// The dashboard: a small HTTP server serving the SPA + a JSON API over the engine.
// Runs as its own (systemd) process, as root, so it can drive deploys. Password-protected.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as db from './db.js';
import * as engine from './engine.js';
import * as proc from './proc.js';
import * as pg from './postgres.js';
import * as firewall from './firewall.js';
import * as auth from './auth.js';
import * as github from './github.js';
import { TABLE, TYPES, row } from './table.js';
import { logFile } from './paths.js';

// The built Vite/React dashboard (dashboard/dist). Build it with `justdeploy dashboard build`.
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'dashboard', 'dist');
const now = () => new Date().toISOString();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Apps currently mid-deploy in THIS process (for live status in the UI).
const deploying = new Set();
const restarting = new Set();          // apps the supervisor is currently relaunching
const crash = new Map();               // name -> { fails, nextTry } backoff state

function kickDeploy(database, name, opts) {
  if (deploying.has(name)) return;
  deploying.add(name);
  engine.deploy(database, name, opts).catch(() => {}).finally(() => deploying.delete(name));
}

function kickRollback(database, name, sha) {
  if (deploying.has(name)) return;
  deploying.add(name);
  engine.rollback(database, name, sha).catch(() => {}).finally(() => deploying.delete(name));
}

// --- process supervision ----------------------------------------------------
// Every few seconds, restart any proxy app whose process has died (runtime crash, or a
// reboot that left a stale pid). Exponential backoff avoids hammering a crash-looping app.
async function superviseOnce(database) {
  for (const app of db.listApps(database)) {
    if (app.serve !== 'proxy' || !app.live_pid) continue;
    if (deploying.has(app.name) || restarting.has(app.name)) continue;
    if (proc.alive(app.live_pid)) { crash.delete(app.name); continue; }

    const st = crash.get(app.name) || { fails: 0, nextTry: 0 };
    if (Date.now() < st.nextTry) continue;

    restarting.add(app.name);
    appendFileSync(logFile(app.name), `\n[justdeploy] process ${app.live_pid} is down — restarting…\n`);
    let ok = false;
    try { ok = await engine.restart(database, app.name); } catch { ok = false; }
    if (ok) {
      crash.delete(app.name);
      appendFileSync(logFile(app.name), '[justdeploy] restart OK\n');
    } else {
      st.fails += 1;
      st.nextTry = Date.now() + Math.min(60000, 5000 * 2 ** st.fails);
      crash.set(app.name, st);
      appendFileSync(logFile(app.name), `[justdeploy] restart failed (attempt ${st.fails}) — backing off\n`);
    }
    restarting.delete(app.name);
  }
}

function startSupervisor(database) {
  setInterval(() => { superviseOnce(database).catch(() => {}); }, 8000);
}

// --- request helpers --------------------------------------------------------
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function body(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function rawBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

// Normalize a git URL to `host/path` (no scheme, creds, .git, or trailing slash) for matching
// a push payload's repo URLs against an app's stored `repo`.
function normRepo(url) {
  return String(url || '')
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')       // strip user@ credentials
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

// Given a push payload (GitHub / GitLab / Gitea / generic), deploy every app whose repo
// matches — but only when the push is to the repo's default branch. Returns the app names.
function triggerFromPush(database, p) {
  const repo = p.repository || {}, project = p.project || {};
  const urls = [repo.clone_url, repo.ssh_url, repo.html_url, repo.git_http_url,
    repo.git_ssh_url, project.git_http_url, project.git_ssh_url, repo.url]
    .filter(Boolean).map(normRepo);
  const set = new Set(urls);
  const ref = p.ref, def = repo.default_branch || project.default_branch;
  let apps = db.listApps(database).filter((a) =>
    a.repo && set.has(normRepo(a.repo)) && (a.serve === 'static' || a.serve === 'proxy'));
  if (ref && def && ref !== `refs/heads/${def}`) apps = []; // push wasn't to the default branch
  const names = [];
  for (const a of apps) { kickDeploy(database, a.name); names.push(a.name); }
  return names;
}

// --- app state for the UI ---------------------------------------------------
function appView(database, a) {
  const last = db.latestDeploy(database, a.name);
  return {
    name: a.name, type: a.type, serve: a.serve, domain: a.domain,
    repo: a.repo, live_port: a.live_port, live_pid: a.live_pid,
    release_cmd: a.release_cmd, persist: a.persist,
    rollbackTo: db.rollbackTarget(database, a.name),
    releases: engine.listReleases(a.name),      // SHAs with a kept build → instant rollback
    currentSha: engine.currentRelease(a.name),
    deploying: deploying.has(a.name),
    lastDeploy: last ? {
      status: last.status, sha: last.sha, at: last.finished_at || last.started_at,
      message: last.message, reason: last.reason, hint: last.hint,
    } : null,
  };
}

// Server-Sent Events: stream an app's log live. Polls the file size and pushes any newly
// appended bytes — robust to which process wrote them (dashboard-triggered or CLI deploy)
// and to the file not existing yet at connect time.
function streamLog(req, res, name) {
  const lf = logFile(name);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // discourage any proxy from buffering the stream
  });
  const sse = (text) => {
    for (const line of text.split('\n')) res.write(`data: ${line}\n`);
    res.write('\n');
  };

  let pos = 0;
  try {
    if (existsSync(lf)) {
      const tail = readFileSync(lf, 'utf8').split('\n').slice(-400).join('\n');
      if (tail) sse(tail);
      pos = statSync(lf).size;
    }
  } catch { /* ignore */ }

  const tick = setInterval(() => {
    try {
      if (!existsSync(lf)) return;
      const size = statSync(lf).size;
      if (size < pos) pos = 0;            // log rotated/truncated
      if (size <= pos) return;
      const len = size - pos;
      const buf = Buffer.alloc(len);
      const fd = openSync(lf, 'r');
      readSync(fd, buf, 0, len, pos);
      closeSync(fd);
      pos = size;
      sse(buf.toString('utf8'));
    } catch { /* transient; try again next tick */ }
  }, 800);
  const hb = setInterval(() => res.write(': hb\n\n'), 15000); // keep-alive comment
  req.on('close', () => { clearInterval(tick); clearInterval(hb); });
}

// SSE stream of a container's live logs (`docker logs -f`). Postgres writes to stderr.
function streamDockerLogs(req, res, container) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const sse = (text) => { for (const line of text.split('\n')) res.write(`data: ${line}\n`); res.write('\n'); };
  const child = spawn('docker', ['logs', '-f', '--tail', '300', container]);
  child.stdout.on('data', (d) => sse(d.toString()));
  child.stderr.on('data', (d) => sse(d.toString()));
  const hb = setInterval(() => res.write(': hb\n\n'), 15000);
  req.on('close', () => { clearInterval(hb); child.kill('SIGKILL'); });
}

function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC, rel);
  // SPA fallback: unknown client routes (no file extension) serve index.html so deep links
  // like /apps/foo work on refresh. Missing real assets still 404.
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    if (extname(rel)) { res.writeHead(404); res.end('not found'); return; }
    file = join(PUBLIC, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Dashboard not built yet — run: justdeploy dashboard build');
      return;
    }
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

// --- server -----------------------------------------------------------------
export function start({ port = Number(process.env.PORT) || 4999 } = {}) {
  const database = db.open();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // API routes
    if (path.startsWith('/api/')) {
      try {
        return await api(database, req, res, path);
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }
    // Static SPA
    return serveStatic(res, path);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`justdeploy dashboard on 127.0.0.1:${port}`);
  });
  startSupervisor(database); // keep proxy apps alive across crashes / reboots
  firewall.reconcile(database); // reinstall DB allowlists (DOCKER-USER is empty after a reboot)
  return server;
}

// The caller's public IP as seen through Caddy (X-Forwarded-For), for prefilling allowlists.
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

async function api(database, req, res, path) {
  const authed = () => auth.validToken(database, cookies(req).jd_session);

  // --- public endpoints ---
  if (path === '/api/session' && req.method === 'GET') {
    return send(res, 200, { authed: authed(), needsSetup: !auth.hasAdmin(database) });
  }
  if (path === '/api/login' && req.method === 'POST') {
    const { password } = await body(req);
    if (!auth.checkAdmin(database, password || '')) return send(res, 401, { error: 'wrong password' });
    const token = auth.issueToken(database);
    res.setHeader('Set-Cookie', `jd_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
    return send(res, 200, { ok: true });
  }
  if (path === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'jd_session=; HttpOnly; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  // --- git-push webhook (unauthenticated, but HMAC- or secret-verified) ---
  if (path === '/api/webhook' || path.startsWith('/api/webhook/')) {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const secret = db.getSetting(database, 'webhook_secret');
    if (!secret) return send(res, 503, { error: 'webhook not enabled — run: justdeploy webhook' });

    const raw = await rawBody(req);
    const urlSecret = path.startsWith('/api/webhook/') ? path.slice('/api/webhook/'.length) : null;
    const sig = req.headers['x-hub-signature-256'];
    const ok = (sig && auth.verifyHmac(secret, raw, sig)) || (urlSecret && auth.secretEq(urlSecret, secret));
    if (!ok) return send(res, 401, { error: 'bad signature' });

    // Only act on push events; acknowledge pings and other events without deploying.
    const event = req.headers['x-github-event'] || req.headers['x-gitlab-event'] || req.headers['x-gitea-event'];
    if (event && !/push/i.test(event)) return send(res, 200, { ok: true, ignored: event });

    let payload; try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
    const triggered = triggerFromPush(database, payload);
    return send(res, 200, { ok: true, triggered });
  }

  // --- everything below requires auth ---
  if (!authed()) return send(res, 401, { error: 'unauthorized' });

  if (path === '/api/myip' && req.method === 'GET') {
    return send(res, 200, { ip: clientIp(req) });
  }

  if (path === '/api/settings/public-host' && req.method === 'PUT') {
    const { host } = await body(req);
    db.setSetting(database, 'public_host', (host || '').trim()); // empty → falls back to the domain
    return send(res, 200, { ok: true });
  }

  if (path === '/api/state' && req.method === 'GET') {
    return send(res, 200, {
      apps: db.listApps(database).map((a) => appView(database, a)),
      resources: db.listResources(database),
      types: TYPES.map((t) => ({ id: t, serve: TABLE[t].serve })),
      // Suggest `{name}.{base}` domains — override with a `base_domain` setting, else the
      // dashboard's own domain (apps are subdomains of it).
      baseDomain: db.getSetting(database, 'base_domain') || db.getSetting(database, 'dashboard_domain') || null,
    });
  }

  // --- GitHub source connection (Personal Access Token) ---
  if (path === '/api/github' && req.method === 'GET') {
    const token = db.getSetting(database, 'github_token');
    if (!token) return send(res, 200, { connected: false });
    try { const me = await github.whoami(token); return send(res, 200, { connected: true, login: me.login, avatar: me.avatar }); }
    catch { return send(res, 200, { connected: false, error: 'token invalid or expired' }); }
  }
  if (path === '/api/github' && req.method === 'POST') {
    const { token } = await body(req);
    if (!token || !token.trim()) return send(res, 400, { error: 'token required' });
    let me;
    try { me = await github.whoami(token.trim()); } catch (e) { return send(res, 400, { error: e.message }); }
    db.setSetting(database, 'github_token', token.trim());
    db.setSetting(database, 'github_login', me.login);
    return send(res, 200, { connected: true, login: me.login, avatar: me.avatar });
  }
  if (path === '/api/github' && req.method === 'DELETE') {
    db.setSetting(database, 'github_token', '');
    db.setSetting(database, 'github_login', '');
    return send(res, 200, { ok: true });
  }
  if (path === '/api/github/repos' && req.method === 'GET') {
    const token = db.getSetting(database, 'github_token');
    if (!token) return send(res, 400, { error: 'not connected' });
    try { return send(res, 200, { repos: await github.listRepos(token) }); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (path === '/api/github/detect' && req.method === 'GET') {
    const token = db.getSetting(database, 'github_token');
    const repo = new URL(req.url, 'http://x').searchParams.get('repo');
    if (!token || !repo) return send(res, 400, { error: 'not connected or no repo' });
    try { return send(res, 200, await github.detectType(token, repo)); }
    catch { return send(res, 200, { type: null, reason: 'could not detect' }); }
  }

  if (path === '/api/apps' && req.method === 'POST') {
    const { name, type, domain, repo, release, persist } = await body(req);
    if (!TYPES.includes(type)) return send(res, 400, { error: 'bad type' });
    if (!name || !/^[a-z0-9-]+$/.test(name)) return send(res, 400, { error: 'name must be [a-z0-9-]' });
    const serve = row(type).serve;

    // Never let a new project silently overwrite an existing app or database.
    if (db.getApp(database, name) || db.getResource(database, name)) {
      return send(res, 409, { error: `“${name}” already exists — pick a different name` });
    }
    // Guard against two apps claiming the same domain (would collide in Caddy).
    if (domain && db.listApps(database).some((a) => a.domain === domain)) {
      return send(res, 409, { error: `domain ${domain} is already used by another app` });
    }

    if (serve === 'resource') { // postgres
      const { conn } = pg.provision(database, name);
      return send(res, 200, { ok: true, conn });
    }
    if (!domain) return send(res, 400, { error: 'domain required' });

    db.upsertApp(database, {
      name, type, domain, repo, serve,
      release_cmd: release || null, persist: persist || null, created_at: now(),
    });
    if (type === 'adonis') db.setEnv(database, name, 'APP_KEY', randomBytes(32).toString('base64url'));

    kickDeploy(database, name);
    return send(res, 200, { ok: true, deploying: true });
  }

  // /api/apps/:name/...
  const m = path.match(/^\/api\/apps\/([a-z0-9-]+)(\/(deploy|logs|env|config|stream|rollback|deploys))?$/);
  if (m) {
    const name = m[1], sub = m[3];
    if (!db.getApp(database, name)) return send(res, 404, { error: 'no such app' });

    if (sub === 'stream' && req.method === 'GET') {
      return streamLog(req, res, name); // SSE — keeps the connection open
    }
    if (sub === 'deploys' && req.method === 'GET') {
      return send(res, 200, { deploys: db.recentDeploys(database, name, 20) });
    }
    if (sub === 'rollback' && req.method === 'POST') {
      const { sha } = await body(req);
      const target = sha || db.rollbackTarget(database, name);
      if (!target) return send(res, 400, { error: 'no previous successful deploy' });
      kickRollback(database, name, target); // instant if the release is kept, else rebuilds
      return send(res, 200, { ok: true, deploying: true, sha: target });
    }

    if (sub === 'config' && req.method === 'PUT') {
      const { release, persist, health_path } = await body(req);
      db.updateAppConfig(database, name, {
        release_cmd: release ?? null, persist: persist ?? null,
        ...(health_path ? { health_path } : {}),
      });
      return send(res, 200, { ok: true });
    }

    if (!sub && req.method === 'DELETE') {
      await engine.destroy(database, name, {});
      return send(res, 200, { ok: true });
    }
    if (sub === 'deploy' && req.method === 'POST') {
      kickDeploy(database, name);
      return send(res, 200, { ok: true, deploying: true });
    }
    if (sub === 'logs' && req.method === 'GET') {
      const lf = logFile(name);
      const text = existsSync(lf) ? readFileSync(lf, 'utf8') : '';
      return send(res, 200, { log: text.split('\n').slice(-400).join('\n') });
    }
    if (sub === 'env' && req.method === 'GET') {
      return send(res, 200, { env: db.getEnv(database, name) });
    }
    if (sub === 'env' && req.method === 'PUT') {
      const { env } = await body(req);
      for (const [k, v] of Object.entries(env || {})) db.setEnv(database, name, k, String(v));
      return send(res, 200, { ok: true });
    }
  }

  // /api/resources/:name(/logs/stream|/restart|/reset-password)
  const rm = path.match(/^\/api\/resources\/([a-z0-9-]+)(?:\/(logs\/stream|restart|reset-password|expose))?$/);
  if (rm) {
    const rname = rm[1], rsub = rm[2];
    if (!db.getResource(database, rname)) return send(res, 404, { error: 'no such resource' });
    if (rsub === 'logs/stream' && req.method === 'GET') return streamDockerLogs(req, res, rname);
    if (!rsub && req.method === 'GET') return send(res, 200, pg.info(database, rname));
    if (!rsub && req.method === 'DELETE') { pg.deprovision(database, rname, {}); return send(res, 200, { ok: true }); }
    if (rsub === 'restart' && req.method === 'POST') {
      try { pg.restart(rname); return send(res, 200, { ok: true }); } catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (rsub === 'reset-password' && req.method === 'POST') {
      try { const { conn } = pg.resetPassword(database, rname); return send(res, 200, { ok: true, conn }); } catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (rsub === 'expose' && req.method === 'POST') {
      const { public: isPublic, allowIps } = await body(req);
      try { const out = pg.setExposure(database, rname, !!isPublic, Array.isArray(allowIps) ? allowIps : []); return send(res, 200, { ok: true, ...out }); } catch (e) { return send(res, 500, { error: e.message }); }
    }
  }

  return send(res, 404, { error: 'not found' });
}
