// The dashboard: a small HTTP server serving the SPA + a JSON API over the engine.
// Runs as its own (systemd) process, as root, so it can drive deploys. Password-protected.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, appendFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as db from './db.js';
import * as engine from './engine.js';
import * as caddy from './caddy.js';
import * as proc from './proc.js';
import * as container from './container.js';
import * as cron from './cron.js';
import * as pg from './postgres.js';
import * as firewall from './firewall.js';
import * as auth from './auth.js';
import * as github from './github.js';
import * as setup from './setup.js';
import * as backup from './backup.js';
import * as s3 from './s3.js';
import { TABLE, TYPES, row } from './table.js';
import { PG_REF_FIELDS } from './envref.js';
import { logFile, buildLog, runtimeLog, normSubdir } from './paths.js';

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
    appendFileSync(runtimeLog(app.name), `\n[justdeploy] process ${app.live_pid} is down — restarting…\n`);
    let ok = false;
    try { ok = await engine.restart(database, app.name); } catch { ok = false; }
    if (ok) {
      crash.delete(app.name);
      appendFileSync(runtimeLog(app.name), '[justdeploy] restart OK\n');
    } else {
      st.fails += 1;
      st.nextTry = Date.now() + Math.min(60000, 5000 * 2 ** st.fails);
      crash.set(app.name, st);
      appendFileSync(runtimeLog(app.name), `[justdeploy] restart failed (attempt ${st.fails}) — backing off\n`);
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
    a.repo && set.has(normRepo(a.repo)) && a.serve !== 'resource');
  if (ref && def && ref !== `refs/heads/${def}`) apps = []; // push wasn't to the default branch
  const names = [];
  for (const a of apps) { kickDeploy(database, a.name); names.push(a.name); }
  return names;
}

// --- app state for the UI ---------------------------------------------------
// The CLI entrypoint, for the backup timer's ExecStart + the detached restore (dashboard runs as root).
const CLI_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'justdeploy');
const CLI = `${process.execPath} ${CLI_SCRIPT}`;

// Git-push webhook: the payload URL + secret, for the dashboard's Settings > Auto-deploy section.
function webhookInfo(database) {
  const secret = db.getSetting(database, 'webhook_secret') || null;
  const domain = db.getSetting(database, 'dashboard_domain');
  const base = domain ? `https://${domain}` : null;
  return {
    enabled: !!secret, secret,
    url: base ? `${base}/api/webhook` : '<dashboard-domain>/api/webhook',
    urlWithSecret: base && secret ? `${base}/api/webhook/${secret}` : null,
  };
}

// Local backup archives, newest first.
function listBackups() {
  try {
    return readdirSync(backup.BACKUP_DIR)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => { const s = statSync(join(backup.BACKUP_DIR, f)); return { name: f, sizeMB: +(s.size / 1048576).toFixed(2), at: s.mtime.toISOString() }; })
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  } catch { return []; }
}

// Host readiness (doctor) + disk usage + tool versions, for the Settings > Host section.
async function hostStatus() {
  const insp = await setup.inspect();
  let disk = null;
  try {
    const cols = execSync('df -Pk /', { encoding: 'utf8' }).trim().split('\n').pop().split(/\s+/);
    const totalKB = +cols[1], usedKB = +cols[2], freeKB = +cols[3];
    disk = { totalGB: +(totalKB / 1048576).toFixed(1), usedGB: +(usedKB / 1048576).toFixed(1), freeGB: +(freeKB / 1048576).toFixed(1), pct: Math.round((usedKB / totalKB) * 100) };
  } catch { /* not linux / no df */ }
  const ver = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; } catch { return null; } };
  return { ...insp, disk, versions: { caddy: ver('caddy version'), docker: ver('docker --version'), railpack: ver('railpack --version') } };
}

// The S3/R2 remote config, or null if incomplete. (Mirror of the CLI's remoteConfig.)
function backupRemote(database) {
  const c = {
    endpoint: db.getSetting(database, 'backup_endpoint'), bucket: db.getSetting(database, 'backup_bucket'),
    region: db.getSetting(database, 'backup_region') || 'auto', accessKey: db.getSetting(database, 'backup_access_key'),
    secretKey: db.getSetting(database, 'backup_secret_key'), prefix: db.getSetting(database, 'backup_prefix') || '',
  };
  return (c.endpoint && c.bucket && c.accessKey && c.secretKey) ? c : null;
}

// Backup settings for the UI — the secret is never sent, only whether one is stored.
function backupSettings(database) {
  return {
    endpoint: db.getSetting(database, 'backup_endpoint') || '', bucket: db.getSetting(database, 'backup_bucket') || '',
    region: db.getSetting(database, 'backup_region') || '', prefix: db.getSetting(database, 'backup_prefix') || '',
    accessKey: db.getSetting(database, 'backup_access_key') || '', hasSecret: !!db.getSetting(database, 'backup_secret_key'),
    configured: !!backupRemote(database), schedule: currentSchedule(),
  };
}

// 'off' | 'hourly' | 'daily' | 'weekly' | '<raw OnCalendar>' — read from the installed timer.
function currentSchedule() {
  try {
    if (execSync('systemctl is-enabled justdeploy-backup.timer', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== 'enabled') return 'off';
    const cal = execSync('systemctl cat justdeploy-backup.timer', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').find((l) => l.startsWith('OnCalendar='));
    return cal ? cal.split('=')[1].trim() : 'on';
  } catch { return 'off'; }
}

// Install / update / remove the systemd backup timer at the chosen interval (root only).
function setBackupSchedule(interval, keep = 7) {
  const svc = '/etc/systemd/system/justdeploy-backup.service';
  const tmr = '/etc/systemd/system/justdeploy-backup.timer';
  if (!interval || interval === 'off') {
    try { execSync('systemctl disable --now justdeploy-backup.timer', { stdio: 'ignore' }); } catch { /* not installed */ }
    for (const f of [svc, tmr]) { try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ } }
    try { execSync('systemctl daemon-reload', { stdio: 'ignore' }); } catch { /* ignore */ }
    return;
  }
  const cal = ['hourly', 'daily', 'weekly'].includes(interval) ? interval : 'daily';
  writeFileSync(svc, `[Unit]\nDescription=JustDeploy backup\n\n[Service]\nType=oneshot\nEnvironment=NODE_OPTIONS=--disable-warning=ExperimentalWarning\nExecStart=${CLI} backup --keep ${keep}\n`);
  writeFileSync(tmr, `[Unit]\nDescription=JustDeploy backup timer\n\n[Timer]\nOnCalendar=${cal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
  execSync('systemctl daemon-reload');
  execSync('systemctl enable --now justdeploy-backup.timer');
}

function appView(database, a) {
  const last = db.latestDeploy(database, a.name);
  return {
    name: a.name, type: a.type, serve: a.serve, domain: a.domain, owner: a.owner, group: a.grp,
    repo: a.repo, live_port: a.live_port, live_pid: a.live_pid,
    release_cmd: a.release_cmd, persist: a.persist,
    // A worker has no URL to click and no port to read, so whether its container is up is the
    // only live signal the UI can show. Other serve models don't pay for the docker inspect.
    running: a.serve === 'worker' ? container.running(a.container) : undefined,
    schedule: a.schedule, cmd: a.cmd,
    cron: a.serve === 'cron' ? cron.status(a.name) : undefined,
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
function streamLog(req, res, lf) {
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

// SSE stream of a systemd unit's journal — a scheduled job's runs, as they happen.
function streamJournal(req, res, unit) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const sse = (text) => { for (const line of text.split('\n')) res.write(`data: ${line}\n`); res.write('\n'); };
  const child = spawn('journalctl', ['-u', unit, '-n', '300', '-f', '--no-pager']);
  child.stdout.on('data', (d) => sse(d.toString()));
  child.stderr.on('data', (d) => sse(d.toString()));
  const hb = setInterval(() => res.write(': hb\n\n'), 15000);
  req.on('close', () => { clearInterval(hb); child.kill('SIGKILL'); });
}

// One app's live output as a spawnable tail, whichever backend it happens to use. `tail -F`
// (not -f) so an app that hasn't written its log yet still streams once it does.
function runtimeTail(app, lines) {
  if (app.serve === 'cron') return ['journalctl', ['-u', `${cron.unitName(app.name)}.service`, '-n', String(lines), '-f', '--no-pager']];
  if (app.container) return ['docker', ['logs', '-f', '--tail', String(lines), app.container]];
  return ['tail', ['-n', String(lines), '-F', runtimeLog(app.name)]];
}

// Every app's runtime output merged into one SSE stream, each line tagged with its app so the
// client can filter and colour. Answers "which app just broke?" without knowing where to look.
function streamAllLogs(req, res, database, owner) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  // Static sites are served straight off disk by the host's Caddy — they have no process and so no
  // runtime output. Listing them would only add filters that never emit anything.
  const apps = db.listApps(database, owner).filter((a) => a.serve !== 'resource' && a.serve !== 'static');
  res.write(`event: apps\ndata: ${JSON.stringify(apps.map((a) => ({ name: a.name, type: a.type, serve: a.serve })))}\n\n`);

  const lines = Math.max(1, Math.floor(200 / Math.max(apps.length, 1))); // keep the initial backlog bounded
  const children = [];
  for (const app of apps) {
    const [cmd, args] = runtimeTail(app, lines);
    let child;
    try { child = spawn(cmd, args); } catch { continue; }
    // tail/journalctl chatter about a missing file isn't the app's output — drop it rather than
    // pass noise off as a log line.
    const emit = (buf, isErr) => {
      for (const line of buf.toString().split('\n')) {
        if (!line) continue;
        if (isErr && /No such file or directory|cannot open|has appeared|has become inaccessible/i.test(line)) continue;
        res.write(`data: ${JSON.stringify({ app: app.name, line })}\n\n`);
      }
    };
    child.stdout.on('data', (d) => emit(d, false));
    child.stderr.on('data', (d) => emit(d, true));
    child.on('error', () => {});
    children.push(child);
  }
  const hb = setInterval(() => res.write(': hb\n\n'), 15000);
  req.on('close', () => { clearInterval(hb); for (const c of children) c.kill('SIGKILL'); });
}

// Where to read an app's logs for a kind: build → build.log; runtime → the app's live output
// (runtime.log for host processes, `docker logs` for containers, journald for cron jobs).
// Falls back to the legacy combined app.log for apps not yet redeployed after the split.
function logSource(database, name, kind) {
  const app = db.getApp(database, name);
  if (kind === 'runtime') {
    // A scheduled job has no long-lived container; each run's output lands in the journal.
    if (app?.serve === 'cron') return { unit: `${cron.unitName(name)}.service` };
    if (app?.container) return { container: app.container }; // container + worker apps
    return { file: runtimeLog(name), legacy: logFile(name) };
  }
  return { file: buildLog(name), legacy: logFile(name) };
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

export async function api(database, req, res, path) {
  // The live user this request is authenticated as, or null. Computed once, reused everywhere.
  const user = auth.validUser(database, cookies(req).jd_session);

  // --- public endpoints ---
  if (path === '/api/session' && req.method === 'GET') {
    return send(res, 200, {
      authed: !!user,
      needsSetup: !auth.hasAdmin(database),
      user: user && { username: user.username, role: user.role, mustChange: user.mustChange },
    });
  }
  if (path === '/api/login' && req.method === 'POST') {
    const { username, password } = await body(req);
    const u = auth.verifyUser(database, String(username || ''), String(password || ''));
    if (!u) return send(res, 401, { error: 'wrong username or password' });
    const token = auth.issueToken(database, u.username);
    res.setHeader('Set-Cookie', `jd_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
    return send(res, 200, { ok: true, mustChange: !!u.must_change });
  }
  // First-run: create the initial admin from the browser when no admin exists yet.
  if (path === '/api/setup' && req.method === 'POST') {
    if (auth.hasAdmin(database)) return send(res, 409, { error: 'already set up' });
    const { username, password } = await body(req);
    const name = String(username || '').toLowerCase().trim();
    if (!/^[a-z0-9-]{2,32}$/.test(name)) return send(res, 400, { error: 'username must be 2-32 chars [a-z0-9-]' });
    if (String(password || '').length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });
    auth.createUser(database, { username: name, password: String(password), role: 'admin' });
    const token = auth.issueToken(database, name);
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
    const secret = db.getSetting(database, 'webhook_secret');       // manual per-repo webhook
    const appSecrets = db.listGithubWebhookSecrets(database);       // each user's GitHub App secret
    if (!secret && !appSecrets.length) return send(res, 503, { error: 'webhook not enabled' });

    const raw = await rawBody(req);
    const urlSecret = path.startsWith('/api/webhook/') ? path.slice('/api/webhook/'.length) : null;
    const sig = req.headers['x-hub-signature-256'];
    // Which user's App signed this? (null for the shared manual webhook.)
    const appMatch = sig ? appSecrets.find((s) => auth.verifyHmac(s.secret, raw, sig)) : null;
    const ok = (sig && ((secret && auth.verifyHmac(secret, raw, sig)) || appMatch))
      || (urlSecret && secret && auth.secretEq(urlSecret, secret));
    if (!ok) return send(res, 401, { error: 'bad signature' });

    const event = req.headers['x-github-event'] || req.headers['x-gitlab-event'] || req.headers['x-gitea-event'];
    let payload; try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }

    // GitHub App lifecycle: record the installation id on the owning user's row (match by App id,
    // falling back to whichever user's secret verified this delivery).
    if (event === 'installation' || event === 'installation_repositories') {
      const owner = db.findUserByGhAppId(database, payload.installation?.app_id) || appMatch?.username;
      if (owner) {
        if (event === 'installation' && payload.action === 'deleted') db.setUserGithub(database, owner, { gh_app_installation_id: '' });
        else if (payload.installation?.id) db.setUserGithub(database, owner, { gh_app_installation_id: String(payload.installation.id) });
      }
      return send(res, 200, { ok: true, event, action: payload.action });
    }
    // Only push events deploy; acknowledge pings and others without acting.
    if (event && !/push/i.test(event)) return send(res, 200, { ok: true, ignored: event });

    const triggered = triggerFromPush(database, payload);
    return send(res, 200, { ok: true, triggered });
  }

  // GitHub redirects the browser here after "Create GitHub App" — exchange the code, store creds,
  // then bounce to the install page so the user picks repos. This MUST be public: it's a cross-site
  // top-level navigation back from github.com, which doesn't reliably carry the SameSite=Lax session
  // cookie, so an auth gate would 401 it. Its protection is the one-time `state` nonce, which only
  // the session that started the flow (via the authed /app/new) knows.
  if (path === '/api/github/app/callback' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const code = q.get('code'), state = q.get('state');
    // The state nonce identifies which user started the flow (it can't rely on the session cookie).
    const owner = code && state && db.findUserByGhState(database, state);
    if (!owner) {
      res.writeHead(302, { Location: '/settings?github=error' }); return res.end();
    }
    try {
      const app = await github.convertManifest(code);
      db.setUserGithub(database, owner, {
        gh_app_id: String(app.id), gh_app_slug: app.slug, gh_app_pem: app.pem,
        gh_app_webhook_secret: app.webhook_secret || '', gh_app_client_id: app.client_id || '',
        gh_app_client_secret: app.client_secret || '', gh_app_state: '',
        github_token: '', // App supersedes the PAT
      });
      res.writeHead(302, { Location: `https://github.com/apps/${app.slug}/installations/new` });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/settings?github=error&msg=' + encodeURIComponent(e.message) }); return res.end();
    }
  }

  // --- everything below requires auth ---
  if (!user) return send(res, 401, { error: 'unauthorized' });
  const isAdmin = user.role === 'admin';
  // Admin-only gate for global/box-wide actions. Returns true (and sends 403) when it should block.
  const denyNonAdmin = () => { if (!isAdmin) { send(res, 403, { error: 'admins only' }); return true; } return false; };
  // Ownership gate for a specific app/project/resource. Returns true (and sends 403/404) when blocked.
  const denyNotOwner = (entity) => {
    if (!entity) { send(res, 404, { error: 'not found' }); return true; }
    if (!isAdmin && entity.owner !== user.username) { send(res, 403, { error: 'forbidden' }); return true; }
    return false;
  };

  // Global/box-wide actions are admin-only — one gate instead of a check per route. Members still
  // reach their own apps/projects/resources and self-service password below. (GitHub is admin-wide
  // here; Phase C makes it per-user.)
  const ADMIN_EXACT = new Set([
    '/api/settings/base-domain', '/api/settings/public-host', '/api/settings/backup',
    '/api/settings/webhook', '/api/backups', '/api/host', '/api/doctor', '/api/onboarding/dismiss',
  ]);
  const ADMIN_PREFIX = ['/api/backup/', '/api/maintenance/', '/api/users'];
  if (!isAdmin && (ADMIN_EXACT.has(path) || ADMIN_PREFIX.some((p) => path.startsWith(p)))) {
    return send(res, 403, { error: 'admins only' });
  }

  if (path === '/api/myip' && req.method === 'GET') {
    return send(res, 200, { ip: clientIp(req) });
  }

  if (path === '/api/settings/public-host' && req.method === 'PUT') {
    if (denyNonAdmin()) return;
    const { host } = await body(req);
    db.setSetting(database, 'public_host', (host || '').trim()); // empty → falls back to the domain
    return send(res, 200, { ok: true });
  }

  // Members see only what they own; admins see everything. `scope` is the owner filter (null = all).
  const scope = isAdmin ? null : user.username;

  // Every app's logs in one stream — scoped, so a member never sees another user's output.
  if (path === '/api/logs/stream' && req.method === 'GET') {
    return streamAllLogs(req, res, database, scope);
  }

  if (path === '/api/state' && req.method === 'GET') {
    return send(res, 200, {
      apps: db.listApps(database, scope).map((a) => appView(database, a)),
      resources: db.listResources(database, scope),
      types: TYPES.map((t) => ({ id: t, serve: TABLE[t].serve, release: TABLE[t].release || null })),
      // Suggest `{name}.{base}` domains — override with a `base_domain` setting, else the
      // dashboard's own domain (apps are subdomains of it).
      baseDomain: db.getSetting(database, 'base_domain') || db.getSetting(database, 'dashboard_domain') || null,
      // First-run onboarding state (the setup wizard reads these to know what's left).
      baseDomainSet: !!db.getSetting(database, 'base_domain'),
      publicHost: db.getSetting(database, 'public_host') || '',
      github: github.connection(database, user.username).mode !== 'none',
      githubLogin: db.getUserGithub(database, user.username).github_login || null,
      onboardingDismissed: db.getSetting(database, 'onboarding_dismissed') === '1',
    });
  }

  // Host readiness for the onboarding wizard (Caddy/Docker/Railpack/BuildKit) — same checks as
  // `justdeploy doctor`, read-only.
  if (path === '/api/doctor' && req.method === 'GET') {
    if (denyNonAdmin()) return;
    return send(res, 200, await setup.inspect());
  }

  // Relationship graph for the canvas: apps + databases are nodes; every `${{source.key}}` env
  // reference is an edge. Scoped to one project when ?project=<name> is given.
  if (path === '/api/graph' && req.method === 'GET') {
    const project = new URL(req.url, 'http://x').searchParams.get('project');
    const inProj = (p) => !project || (p || 'default') === project;
    const apps = db.listApps(database, scope).filter((a) => inProj(a.project));
    const resources = db.listResources(database, scope).filter((r) => inProj(r.project));
    const ids = new Set([...apps.map((a) => a.name), ...resources.map((r) => r.name)]);
    const REF = /\$\{\{\s*([\w-]+)\.([\w-]+)\s*\}\}/g;
    const edges = [];
    for (const a of apps) {
      const seen = new Map(); // source -> Set(keys)
      for (const v of Object.values(db.getEnv(database, a.name))) {
        for (const m of String(v).matchAll(REF)) {
          if (m[1] === a.name || !ids.has(m[1])) continue; // skip self + refs outside this scope
          if (!seen.has(m[1])) seen.set(m[1], new Set());
          seen.get(m[1]).add(m[2]);
        }
      }
      for (const [to, keys] of seen) edges.push({ from: a.name, to, keys: [...keys] });
    }
    const nodes = [
      ...apps.map((a) => ({ kind: 'app', ...appView(database, a), project: a.project || 'default' })),
      ...resources.map((r) => ({ kind: r.kind, name: r.name, project: r.project || 'default' })),
    ];
    return send(res, 200, { nodes, edges });
  }

  // Projects: each with its services + an aggregate status, for the home page.
  if (path === '/api/projects' && req.method === 'GET') {
    const apps = db.listApps(database, scope);
    const resources = db.listResources(database, scope);
    const projects = db.listProjects(database, scope).map((p) => {
      const pa = apps.filter((a) => (a.project || 'default') === p.name).map((a) => ({ kind: 'app', ...appView(database, a) }));
      const pr = resources.filter((r) => (r.project || 'default') === p.name).map((r) => ({ kind: r.kind, name: r.name, owner: r.owner }));
      return { name: p.name, created_at: p.created_at, owner: p.owner, apps: pa, resources: pr };
    });
    return send(res, 200, { projects });
  }
  if (path === '/api/projects' && req.method === 'POST') {
    const { name } = await body(req);
    const slug = String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return send(res, 400, { error: 'project name required' });
    const existing = db.getProject(database, slug);
    if (existing && existing.owner && existing.owner !== user.username && !isAdmin) {
      return send(res, 409, { error: `project “${slug}” already exists` });
    }
    db.createProject(database, slug, now(), user.username);
    return send(res, 200, { ok: true, name: slug });
  }
  const pm = path.match(/^\/api\/projects\/([a-z0-9-]+)$/);
  if (pm && req.method === 'DELETE') {
    if (pm[1] === 'default') return send(res, 400, { error: 'the default project cannot be removed' });
    if (denyNotOwner(db.getProject(database, pm[1]))) return;
    // Services fall back to the remover's own default project so members don't lose sight of them.
    const fallback = isAdmin ? 'default' : user.username;
    db.createProject(database, fallback, now(), user.username);
    db.removeProject(database, pm[1], fallback);
    return send(res, 200, { ok: true });
  }
  // Sync a whole project: redeploy every deployable app it owns (pull latest + rebuild).
  const psync = path.match(/^\/api\/projects\/([a-z0-9-]+)\/sync$/);
  if (psync && req.method === 'POST') {
    const proj = psync[1];
    if (denyNotOwner(db.getProject(database, proj))) return;
    const apps = db.listApps(database, isAdmin ? null : user.username)
      .filter((a) => (a.project || 'default') === proj && a.repo && a.serve !== 'resource');
    for (const a of apps) kickDeploy(database, a.name);
    return send(res, 200, { ok: true, syncing: apps.map((a) => a.name) });
  }
  if (path === '/api/settings/base-domain' && req.method === 'PUT') {
    const { domain } = await body(req);
    db.setSetting(database, 'base_domain', (domain || '').trim());
    return send(res, 200, { ok: true, baseDomain: (domain || '').trim() });
  }
  if (path === '/api/onboarding/dismiss' && req.method === 'POST') {
    db.setSetting(database, 'onboarding_dismissed', '1');
    return send(res, 200, { ok: true });
  }

  // --- change the admin password (verify current, then set) ---
  // Change YOUR OWN password (any signed-in user). Clears the must-change flag.
  if (path === '/api/settings/password' && req.method === 'PUT') {
    const { current, next } = await body(req);
    if (!next || String(next).length < 8) return send(res, 400, { error: 'new password must be at least 8 characters' });
    if (!auth.verifyUser(database, user.username, String(current || ''))) {
      return send(res, 403, { error: 'current password is incorrect' });
    }
    auth.setUserPassword(database, user.username, String(next), 0);
    return send(res, 200, { ok: true });
  }

  // --- user administration (admins only) ---
  if (path === '/api/users' && req.method === 'GET') {
    if (denyNonAdmin()) return;
    const defaultQuota = Number(db.getSetting(database, 'default_app_quota') ?? 3);
    const users = db.listUsers(database).map((u) => ({
      username: u.username, role: u.role, mustChange: !!u.must_change, createdAt: u.created_at,
      quota: u.app_quota ?? defaultQuota, appCount: db.countAppsByOwner(database, u.username),
    }));
    return send(res, 200, { users, defaultQuota });
  }
  if (path === '/api/users' && req.method === 'POST') {
    if (denyNonAdmin()) return;
    const { username, password, role, quota } = await body(req);
    const name = String(username || '').toLowerCase().trim();
    if (!/^[a-z0-9-]{2,32}$/.test(name)) return send(res, 400, { error: 'username must be 2-32 chars [a-z0-9-]' });
    if (String(password || '').length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });
    if (db.getUser(database, name)) return send(res, 409, { error: `user “${name}” already exists` });
    auth.createUser(database, {
      username: name, password: String(password),
      role: role === 'admin' ? 'admin' : 'member',
      appQuota: quota == null || quota === '' ? null : Number(quota),
      mustChange: 1, // they set their own password on first login
    });
    return send(res, 200, { ok: true });
  }

  // /api/users/:username  (PUT: role/quota/reset-password, DELETE)
  const um = path.match(/^\/api\/users\/([a-z0-9-]+)$/);
  if (um) {
    if (denyNonAdmin()) return;
    const target = um[1];
    const tu = db.getUser(database, target);
    if (!tu) return send(res, 404, { error: 'no such user' });
    if (req.method === 'PUT') {
      const { role, quota, password } = await body(req);
      if (role !== undefined) {
        if (role !== 'admin' && role !== 'member') return send(res, 400, { error: 'role must be admin or member' });
        // Don't allow removing the last admin.
        if (tu.role === 'admin' && role === 'member' && db.listUsers(database).filter((u) => u.role === 'admin').length <= 1) {
          return send(res, 400, { error: 'cannot demote the last admin' });
        }
        db.setUserRole(database, target, role);
      }
      if (quota !== undefined) db.setUserQuota(database, target, quota === '' || quota == null ? null : Number(quota));
      if (password !== undefined) {
        if (String(password).length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });
        auth.setUserPassword(database, target, String(password), 1);
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      if (target === user.username) return send(res, 400, { error: 'you cannot delete your own account' });
      const owned = db.countOwnedByOwner(database, target);
      if (owned > 0) return send(res, 400, { error: `remove ${target}'s ${owned} service(s) first` });
      db.deleteUser(database, target);
      return send(res, 200, { ok: true });
    }
  }

  // --- off-box backups: S3/R2 config, run-now, and the systemd schedule ---
  if (path === '/api/settings/backup' && req.method === 'GET') {
    return send(res, 200, backupSettings(database));
  }
  if (path === '/api/settings/backup' && req.method === 'PUT') {
    const b = await body(req);
    const map = { endpoint: 'backup_endpoint', bucket: 'backup_bucket', region: 'backup_region', accessKey: 'backup_access_key', secretKey: 'backup_secret_key', prefix: 'backup_prefix' };
    for (const [k, key] of Object.entries(map)) {
      if (b[k] === undefined) continue;
      if (k === 'secretKey' && b[k] === '') continue; // blank secret = keep existing (it's masked)
      db.setSetting(database, key, String(b[k]).trim());
    }
    return send(res, 200, backupSettings(database));
  }
  if (path === '/api/backup/run' && req.method === 'POST') {
    const { local } = await body(req).catch(() => ({}));
    try {
      const r = backup.create(database, {});
      let uploaded = false;
      const remote = backupRemote(database);
      if (!local && remote) { await s3.putObject(remote, basename(r.archive), readFileSync(r.archive)); uploaded = true; }
      return send(res, 200, { ok: true, archive: basename(r.archive), sizeMB: +(r.size / 1048576).toFixed(2), uploaded, hasRemote: !!remote });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (path === '/api/backup/schedule' && req.method === 'POST') {
    const { interval, keep } = await body(req);
    try { setBackupSchedule(interval, keep); return send(res, 200, { ok: true, schedule: currentSchedule() }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (path === '/api/backups' && req.method === 'GET') {
    return send(res, 200, { backups: listBackups() });
  }
  // Restore runs detached — it stops + restarts THIS dashboard service, so it can't run inline.
  if (path === '/api/backup/restore' && req.method === 'POST') {
    const { file } = await body(req);
    const full = join(backup.BACKUP_DIR, basename(file || '')); // basename() prevents path traversal
    if (!file || !existsSync(full)) return send(res, 404, { error: 'no such backup' });
    spawn(process.execPath, [CLI_SCRIPT, 'restore', full, '--yes'],
      { detached: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' } }).unref();
    return send(res, 200, { ok: true, restarting: true });
  }

  // --- git-push auto-deploy (webhook) ---
  if (path === '/api/settings/webhook' && req.method === 'GET') {
    return send(res, 200, webhookInfo(database));
  }
  if (path === '/api/settings/webhook' && req.method === 'POST') { // enable or rotate
    db.setSetting(database, 'webhook_secret', randomBytes(24).toString('hex'));
    return send(res, 200, webhookInfo(database));
  }
  if (path === '/api/settings/webhook' && req.method === 'DELETE') {
    db.setSetting(database, 'webhook_secret', '');
    return send(res, 200, { enabled: false });
  }

  // --- host status + maintenance actions ---
  if (path === '/api/host' && req.method === 'GET') {
    return send(res, 200, await hostStatus());
  }
  if (path === '/api/maintenance/reconcile' && req.method === 'POST') {
    try { await caddy.applyFromDb(database); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (path === '/api/maintenance/gc' && req.method === 'POST') {
    try { return send(res, 200, { ok: true, apps: engine.gcContainers(database) }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }

  // --- GitHub source connection (per-user; App preferred, PAT fallback) ---
  if (path === '/api/github' && req.method === 'GET') {
    const c = github.connection(database, user.username);
    if (c.mode === 'app') {
      c.connected = true;
      c.installUrl = c.slug ? `https://github.com/apps/${c.slug}/installations/new` : null;
      return send(res, 200, c);
    }
    if (c.mode === 'pat') {
      try { const me = await github.whoami(db.getUserGithub(database, user.username).github_token); return send(res, 200, { ...c, connected: true, login: me.login, avatar: me.avatar }); }
      catch { return send(res, 200, { ...c, connected: false, error: 'token invalid or expired' }); }
    }
    return send(res, 200, { mode: 'none', connected: false });
  }
  // Start the GitHub App create flow: return the manifest + the URL the browser POSTs it to. The
  // state nonce is stored on THIS user's row so the (public) callback can route creds back to them.
  if (path === '/api/github/app/new' && req.method === 'GET') {
    const domain = db.getSetting(database, 'dashboard_domain');
    if (!domain) return send(res, 400, { error: 'set the dashboard domain first (it needs a public URL for the webhook + callback)' });
    const state = randomBytes(16).toString('hex');
    db.setUserGithub(database, user.username, { gh_app_state: state });
    const manifest = github.appManifest(domain, randomBytes(3).toString('hex'));
    return send(res, 200, { action: `https://github.com/settings/apps/new?state=${state}`, manifest });
  }
  if (path === '/api/github' && req.method === 'POST') { // PAT fallback
    const { token } = await body(req);
    if (!token || !token.trim()) return send(res, 400, { error: 'token required' });
    let me;
    try { me = await github.whoami(token.trim()); } catch (e) { return send(res, 400, { error: e.message }); }
    db.setUserGithub(database, user.username, { github_token: token.trim(), github_login: me.login });
    return send(res, 200, { connected: true, mode: 'pat', login: me.login, avatar: me.avatar });
  }
  if (path === '/api/github' && req.method === 'DELETE') {
    db.clearUserGithub(database, user.username);
    return send(res, 200, { ok: true });
  }
  if (path === '/api/github/repos' && req.method === 'GET') {
    try { return send(res, 200, { repos: await github.reposFor(database, user.username) }); }
    catch (e) { return send(res, e.message === 'not connected' ? 400 : 502, { error: e.message }); }
  }
  if (path === '/api/github/detect' && req.method === 'GET') {
    const repo = new URL(req.url, 'http://x').searchParams.get('repo');
    const token = await github.activeToken(database, user.username);
    if (!token || !repo) return send(res, 400, { error: 'not connected or no repo' });
    try { return send(res, 200, await github.detectType(token, repo)); }
    catch { return send(res, 200, { type: null, reason: 'could not detect' }); }
  }

  if (path === '/api/apps' && req.method === 'POST') {
    const { name, type, domain, repo, release, persist, subdir, project, schedule, cmd } = await body(req);
    if (!TYPES.includes(type)) return send(res, 400, { error: 'bad type' });
    if (!name || !/^[a-z0-9-]+$/.test(name)) return send(res, 400, { error: 'name must be [a-z0-9-]' });
    let root;
    try { root = normSubdir(subdir) || null; } catch (e) { return send(res, 400, { error: e.message }); }
    const serve = row(type).serve;
    // Members default to a project named after themselves (owned by them); admins keep 'default'.
    const proj = (String(project || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) || (isAdmin ? 'default' : user.username);
    // Can't drop a service into someone else's project.
    const existingProj = db.getProject(database, proj);
    if (existingProj && existingProj.owner && existingProj.owner !== user.username && !isAdmin) {
      return send(res, 403, { error: `project “${proj}” belongs to another user` });
    }
    db.createProject(database, proj, now(), user.username); // ensure the project exists (no-op if present)

    // Never let a new service silently overwrite an existing app or database (names are global).
    if (db.getApp(database, name) || db.getResource(database, name)) {
      return send(res, 409, { error: `“${name}” already exists — pick a different name` });
    }
    // Guard against two apps claiming the same domain (would collide in Caddy).
    if (domain && db.listApps(database).some((a) => a.domain === domain)) {
      return send(res, 409, { error: `domain ${domain} is already used by another app` });
    }
    // Per-user app quota (admins are unlimited). Resources don't count against the app quota.
    if (!isAdmin && serve !== 'resource') {
      const quota = user.appQuota ?? Number(db.getSetting(database, 'default_app_quota') ?? 3);
      if (db.countAppsByOwner(database, user.username) >= quota) {
        return send(res, 403, { error: `app limit reached (${quota}). Ask an admin to raise your quota.` });
      }
    }

    if (serve === 'resource') { // postgres
      // provision() stores the resource under the container name (`<name>-db`), so assign the
      // project to THAT — using the raw name would update a row that doesn't exist, leaving the
      // database in 'default' and invisible on its project's canvas.
      const { container, conn } = pg.provision(database, name);
      db.setResourceProject(database, container, proj);
      db.setResourceOwner(database, container, user.username);
      return send(res, 200, { ok: true, conn });
    }
    if (!domain && !['worker', 'cron'].includes(serve)) return send(res, 400, { error: 'domain required' });
    if (serve === 'cron') {
      if (!cmd) return send(res, 400, { error: 'a command is required — what should each run execute? (e.g. "npm run ingest")' });
      try { cron.validateSchedule(schedule); } catch (e) { return send(res, 400, { error: e.message }); }
    }

    db.upsertApp(database, {
      name, type, domain, repo, serve,
      // The type carries its own release command (Adonis → migrations); an explicit one overrides.
      release_cmd: release || row(type).release || null, persist: persist || null, subdir: root, project: proj, owner: user.username,
      schedule: schedule || null, cmd: cmd || null, created_at: now(),
    });
    if (type === 'adonis') db.setEnv(database, name, 'APP_KEY', randomBytes(32).toString('base64url'));

    kickDeploy(database, name);
    return send(res, 200, { ok: true, deploying: true });
  }

  // /api/apps/:name/...
  const m = path.match(/^\/api\/apps\/([a-z0-9-]+)(\/(deploy|logs|env|refs|config|stream|rollback|deploys|run))?$/);
  if (m) {
    const name = m[1], sub = m[3];
    if (denyNotOwner(db.getApp(database, name))) return;

    // Fire a scheduled job now rather than waiting for its timer — how you test one.
    if (sub === 'run' && req.method === 'POST') {
      const app = db.getApp(database, name);
      if (app?.serve !== 'cron') return send(res, 400, { error: 'not a scheduled job' });
      try { cron.runNow(name); } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 200, { ok: true, started: true });
    }

    if (sub === 'stream' && req.method === 'GET') {
      const kind = new URL(req.url, 'http://x').searchParams.get('kind') || 'build';
      const src = logSource(database, name, kind);
      if (src.unit) return streamJournal(req, res, src.unit);              // SSE from journalctl (cron)
      if (src.container) return streamDockerLogs(req, res, src.container); // SSE from docker logs
      return streamLog(req, res, existsSync(src.file) ? src.file : src.legacy); // SSE tail of the file
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
      const { release, persist, health_path, subdir, group, schedule, cmd } = await body(req);
      let root;
      try { root = subdir === undefined ? undefined : (normSubdir(subdir) || null); }
      catch (e) { return send(res, 400, { error: e.message }); }
      if (schedule !== undefined) {
        try { cron.validateSchedule(schedule); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      db.updateAppConfig(database, name, {
        release_cmd: release ?? null, persist: persist ?? null,
        ...(health_path ? { health_path } : {}),
        ...(root === undefined ? {} : { subdir: root }),
        ...(schedule === undefined ? {} : { schedule: cron.normalizeSchedule(schedule) }),
        ...(cmd === undefined ? {} : { cmd: cmd || null }),
      });
      // Group is its own column; a canvas-only grouping label (no redeploy needed).
      if (group !== undefined) db.setAppGroup(database, name, String(group || '').trim() || null);
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
      const kind = new URL(req.url, 'http://x').searchParams.get('kind') || 'build';
      const src = logSource(database, name, kind);
      let text = '';
      if (src.unit) {
        try { text = execSync(`journalctl -u ${src.unit} -n 400 --no-pager 2>&1`, { encoding: 'utf8' }); } catch { text = ''; }
      } else if (src.container) {
        try { text = execSync(`docker logs --tail 400 ${src.container} 2>&1`, { encoding: 'utf8' }); } catch { text = ''; }
      } else {
        text = existsSync(src.file) ? readFileSync(src.file, 'utf8')
          : (existsSync(src.legacy) ? readFileSync(src.legacy, 'utf8') : '');
      }
      return send(res, 200, { log: text.split('\n').slice(-400).join('\n'), kind });
    }
    if (sub === 'env' && req.method === 'GET') {
      return send(res, 200, { env: db.getEnv(database, name) });
    }
    if (sub === 'env' && req.method === 'PUT') {
      const { env } = await body(req);
      for (const [k, v] of Object.entries(env || {})) db.setEnv(database, name, k, String(v));
      return send(res, 200, { ok: true });
    }
    // What this app's env can reference: every postgres resource (with its fields) and every
    // other app (with its var *names* — never values). Powers the `${{ }}` autocomplete.
    if (sub === 'refs' && req.method === 'GET') {
      const sources = [];
      for (const r of db.listResources(database, scope)) {
        if (r.kind === 'postgres') sources.push({ name: r.name, kind: 'postgres', fields: PG_REF_FIELDS });
      }
      for (const a of db.listApps(database, scope)) {
        if (a.name === name) continue;
        const keys = Object.keys(db.getEnv(database, a.name));
        if (keys.length) sources.push({ name: a.name, kind: 'app', fields: keys });
      }
      return send(res, 200, { sources });
    }
  }

  // /api/resources/:name(/logs/stream|/restart|/reset-password)
  const rm = path.match(/^\/api\/resources\/([a-z0-9-]+)(?:\/(logs\/stream|restart|reset-password|expose))?$/);
  if (rm) {
    const rname = rm[1], rsub = rm[2];
    if (denyNotOwner(db.getResource(database, rname))) return;
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
