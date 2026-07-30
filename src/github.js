// GitHub API helpers + git auth. Two connection modes, in order of preference:
//   1. GitHub App (recommended) — installed once, one webhook for all repos, short-lived
//      installation tokens clone private repos. No per-repo setup, no long-lived PAT.
//   2. Personal Access Token (fallback) — a single stored token.
// Both resolve to a token that authenticates API reads + `git clone` the same way.
import { createSign } from 'node:crypto';
import * as db from './db.js';
const API = 'https://api.github.com';
const b64url = (x) => Buffer.from(x).toString('base64url');

function headers(token) {
  return {
    // Omit auth when there's no token so public-repo reads still work (unauthenticated, rate-
    // limited). A `Bearer null` header would otherwise 401.
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'User-Agent': 'justdeploy',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Validate a token and return the account it belongs to.
export async function whoami(token) {
  const r = await fetch(`${API}/user`, { headers: headers(token) });
  if (r.status === 401) throw new Error('invalid GitHub token');
  if (!r.ok) throw new Error(`GitHub error (${r.status})`);
  const u = await r.json();
  return { login: u.login, name: u.name || u.login, avatar: u.avatar_url };
}

// List repos the token can access (owner + collaborator + org), newest push first.
export async function listRepos(token) {
  const out = [];
  for (let page = 1; page <= 4; page++) {
    const r = await fetch(`${API}/user/repos?per_page=100&sort=pushed&page=${page}`, { headers: headers(token) });
    if (!r.ok) throw new Error(`GitHub error (${r.status})`);
    const arr = await r.json();
    for (const x of arr) {
      out.push({ full_name: x.full_name, clone_url: x.clone_url, private: x.private, default_branch: x.default_branch, pushed_at: x.pushed_at });
    }
    if (arr.length < 100) break;
  }
  return out;
}

// --- type detection --------------------------------------------------------
// Detect what a repo is so the right config is matched to it rather than guessed at. This looks at
// the whole tree, not just the root: a repo's deployable app is very often in a subfolder
// (ingest/, server/, apps/web), and a root-only reading of such a repo is always wrong.
//
// Two rules learned the hard way:
//   * `static` is never a fallback. It used to be what every unrecognised repo became, which is how
//     a Cloudflare Worker got deployed as a static site — Caddy happily serves a directory that has
//     no index.html, so the failure is silent instead of loud. It now needs positive evidence.
//   * When nothing matches, say so (type: null) and let the user choose. A wrong guess that half
//     works costs more than an honest "I don't know".

const HTTP_DEPS = ['express', 'fastify', 'koa', 'hono', 'h3', '@hapi/hapi', 'restify', 'polka', 'micro', '@nestjs/core'];
const WORKERISH_DEPS = ['bullmq', 'bee-queue', 'bull', 'agenda', 'discord.js', 'telegraf', 'node-telegram-bot-api', 'amqplib', 'kafkajs', 'ioredis-stream', '@slack/bolt'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// One recursive tree read gives the whole layout — cheaper than probing paths one at a time.
async function repoTree(token, fullName) {
  const meta = await fetch(`${API}/repos/${fullName}`, { headers: headers(token) });
  if (!meta.ok) throw new Error(`GitHub error (${meta.status})`);
  const branch = (await meta.json()).default_branch || 'main';
  const r = await fetch(`${API}/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers: headers(token) });
  if (!r.ok) throw new Error(`GitHub error (${r.status})`);
  const body = await r.json();
  return { files: (body.tree || []).filter((n) => n.type === 'blob').map((n) => n.path), truncated: !!body.truncated };
}

async function readJson(token, fullName, path) {
  const r = await fetch(`${API}/repos/${fullName}/contents/${path}`, { headers: headers(token) });
  if (!r.ok) return null;
  try { return JSON.parse(Buffer.from((await r.json()).content, 'base64').toString('utf8')); }
  catch { return null; }
}

// Classify one candidate directory. `has(f)` tests for a file inside that directory.
function classify(pkg, has, subdir) {
  const where = subdir ? ` in ${subdir}/` : '';
  // A Cloudflare Worker is not deployable here at all — naming it beats mislabelling it.
  if (has('wrangler.toml') || has('wrangler.jsonc') || has('wrangler.json')) {
    return { type: null, confidence: 'certain', reason: `this is a Cloudflare Worker${where} (wrangler config) — deploy it with wrangler, not JustDeploy` };
  }
  if (!pkg) {
    if (has('hugo.toml') || has('config.toml') && has('content')) {
      return { type: null, confidence: 'certain', reason: `Hugo site${where} — JustDeploy has no Hugo type; it needs a build step, so serving the repo root would 404` };
    }
    if (has('index.html')) return { type: 'static', confidence: 'high', reason: `index.html${where} with no build step — served as a static site` };
    return { type: null, confidence: 'low', reason: `nothing recognisable${where} — no package.json and no index.html` };
  }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const dep = (names) => names.find((n) => deps[n]);

  if (deps.next) return { type: 'nextjs', confidence: 'certain', reason: `Next.js detected${where}` };
  if (deps['@adonisjs/core']) return { type: 'adonis', confidence: 'certain', reason: `AdonisJS detected${where}` };
  if (deps['react-scripts']) return { type: 'react', confidence: 'certain', reason: `Create React App detected${where}` };
  // Vite builds a static bundle — unless it's also running a server, in which case it's an app.
  if (deps.vite || deps['@vitejs/plugin-react'] || deps['@vitejs/plugin-vue']) {
    const server = dep(HTTP_DEPS);
    if (server) return { type: 'app', confidence: 'medium', reason: `Vite + ${server}${where} — a server, not a static bundle` };
    return { type: 'vite', confidence: 'certain', reason: `Vite detected${where}` };
  }

  // A `start` script means something long-running. What kind depends on what it pulls in.
  if (scripts.start) {
    const server = dep(HTTP_DEPS);
    if (server) return { type: 'app', confidence: 'high', reason: `start script + ${server}${where} — an HTTP service` };
    const workerish = dep(WORKERISH_DEPS);
    if (workerish) return { type: 'worker', confidence: 'high', reason: `start script + ${workerish}${where} — a long-running process that serves no HTTP` };
    // node:http has no dependency to find, so fall back to the safe assumption: it listens.
    return { type: 'app', confidence: 'medium', reason: `start script${where} (\`${String(scripts.start).slice(0, 40)}\`) — assumed to listen on $PORT` };
  }

  // No start script, but an executable entry: a CLI/batch tool, which is a scheduled job here.
  if (pkg.bin) return { type: 'cron', confidence: 'medium', reason: `a CLI${where} (bin, no start script) — runs and exits, so it belongs on a schedule` };

  if (scripts.build) {
    if (has('index.html')) return { type: 'vite', confidence: 'medium', reason: `build script + index.html${where} — a static bundle` };
    return { type: null, confidence: 'low', reason: `build script${where} but no index.html and no start script — can't tell what it produces` };
  }
  if (has('index.html')) return { type: 'static', confidence: 'medium', reason: `index.html${where} — served as a static site` };
  return { type: null, confidence: 'low', reason: `package.json${where} with no start, build, or bin — nothing to run` };
}

const RANK = { certain: 3, high: 2, medium: 1, low: 0 };

// Returns { type, subdir, reason, confidence, candidates } — `subdir` is the folder the app lives
// in ('' for the repo root), ready to pass straight through as the root directory.
export async function detectType(token, fullName) {
  let tree;
  try { tree = await repoTree(token, fullName); }
  catch { tree = null; }

  // Fall back to a root-only read if the tree is unavailable or too big to trust.
  if (!tree || tree.truncated) {
    const pkg = await readJson(token, fullName, 'package.json');
    const one = classify(pkg, () => false, '');
    return { ...one, subdir: '', candidates: [] };
  }

  const { files } = tree;
  const fileSet = new Set(files);
  // Candidate roots: the repo root, plus any directory (two levels deep at most) holding a
  // package.json — that covers ingest/, server/, apps/web, packages/api.
  const dirs = new Set(['']);
  for (const f of files) {
    if (!/(^|\/)package\.json$/.test(f)) continue;
    const d = dirOf(f);
    if (d.split('/').length <= 2) dirs.add(d);
  }
  // Directories that only hold static files still count (a docs/ folder with an index.html).
  for (const f of files) {
    if (!/(^|\/)index\.html$/.test(f)) continue;
    const d = dirOf(f);
    if (d.split('/').length <= 2) dirs.add(d);
  }

  const candidates = [];
  for (const d of [...dirs].slice(0, 8)) {
    const prefix = d ? `${d}/` : '';
    const has = (f) => fileSet.has(`${prefix}${f}`) || files.some((p) => p.startsWith(`${prefix}${f}/`));
    const pkg = fileSet.has(`${prefix}package.json`) ? await readJson(token, fullName, `${prefix}package.json`) : null;
    const c = classify(pkg, has, d);
    candidates.push({ ...c, subdir: d });
  }

  // Prefer the most confident deployable candidate; the repo root wins ties so a single-app repo
  // never gets pushed into a subfolder.
  const usable = candidates.filter((c) => c.type);
  usable.sort((a, b) => (RANK[b.confidence] - RANK[a.confidence]) || (a.subdir.length - b.subdir.length));
  const best = usable[0];
  if (!best) {
    // Nothing deployable — surface the most specific explanation we have (e.g. "it's a Worker").
    const explained = candidates.sort((a, b) => RANK[b.confidence] - RANK[a.confidence])[0];
    return { type: null, subdir: '', confidence: 'low', reason: explained?.reason || 'could not tell what this repo is', candidates };
  }
  return { ...best, candidates: usable.filter((c) => c !== best) };
}

// Per-invocation git config that authenticates HTTPS clones/fetches to github.com WITHOUT
// putting the token in the command string (so it never lands in logs) or in .git/config
// (GIT_CONFIG_* env applies only to that git process). Returns undefined for non-github repos.
export function gitAuthEnv(token, repo) {
  if (!token || !/(^|@|\/\/)github\.com[/:]/.test(repo || '')) return undefined;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0', // never hang waiting for a username/password
  };
}

// --- GitHub App -----------------------------------------------------------

// The App Manifest the user submits to GitHub to create the App in one click (name is unique,
// webhook + permissions + redirect pre-filled — the user never pastes anything).
export function appManifest(dashboardDomain, suffix) {
  const base = `https://${dashboardDomain}`;
  return {
    name: `JustDeploy ${suffix}`,
    url: base,
    hook_attributes: { url: `${base}/api/webhook`, active: true },
    redirect_url: `${base}/api/github/app/callback`,
    setup_url: `${base}/settings`,
    public: false,
    default_permissions: { contents: 'read', metadata: 'read' },
    default_events: ['push'],
  };
}

// Exchange the temporary manifest `code` for the created App's credentials (private key, webhook
// secret, id, slug, …). One-time, right after the user clicks "Create GitHub App".
export async function convertManifest(code) {
  const r = await fetch(`${API}/app-manifests/${code}/conversions`, { method: 'POST', headers: headers() });
  if (!r.ok) throw new Error(`GitHub App creation failed (${r.status})`);
  return r.json();
}

// A short-lived App JWT (RS256), signed with the App's private key — authenticates as the App.
function appJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: Number(appId) }));
  const sig = b64url(createSign('RSA-SHA256').update(`${head}.${body}`).sign(pem));
  return `${head}.${body}.${sig}`;
}

export async function appInstallations(appId, pem) {
  const r = await fetch(`${API}/app/installations`, { headers: headers(appJwt(appId, pem)) });
  if (!r.ok) throw new Error(`GitHub error (${r.status})`);
  return r.json();
}

// A repo-scoped installation access token (valid ~1h) — used for API reads and `git clone`.
export async function installationToken(appId, pem, installationId) {
  const r = await fetch(`${API}/app/installations/${installationId}/access_tokens`, { method: 'POST', headers: headers(appJwt(appId, pem)) });
  if (!r.ok) throw new Error(`installation token failed (${r.status})`);
  return (await r.json()).token;
}

// --- token resolution (App installation token if connected, else the PAT) -------------------
// Cached installation tokens, keyed by username (each user has their own App/installation).
const _cache = new Map(); // username -> { token, exp }
export async function activeToken(database, username) {
  if (!username) return null;
  const gh = db.getUserGithub(database, username);
  const { gh_app_id: appId, gh_app_pem: pem } = gh;
  if (appId && pem) {
    let instId = gh.gh_app_installation_id;
    if (!instId) {
      const insts = await appInstallations(appId, pem).catch(() => []);
      instId = insts[0]?.id;
      if (instId) db.setUserGithub(database, username, { gh_app_installation_id: String(instId) });
    }
    if (instId) {
      const c = _cache.get(username);
      if (c && Date.now() < c.exp) return c.token;
      const token = await installationToken(appId, pem, instId);
      _cache.set(username, { token, exp: Date.now() + 50 * 60 * 1000 });
      return token;
    }
  }
  return gh.github_token || null;
}

// git clone auth for a repo, resolving the owner's active token (App or PAT).
export async function cloneAuthEnv(database, username, repo) {
  return gitAuthEnv(await activeToken(database, username), repo);
}

// List deployable repos for the picker. App installation tokens CANNOT call /user/repos (that's
// a user endpoint → 403); they must use /installation/repositories. PAT uses /user/repos.
export async function reposFor(database, username) {
  const gh = db.getUserGithub(database, username);
  if (gh.gh_app_id && gh.gh_app_pem) {
    const token = await activeToken(database, username);
    const out = [];
    for (let page = 1; page <= 6; page++) {
      const r = await fetch(`${API}/installation/repositories?per_page=100&page=${page}`, { headers: headers(token) });
      if (!r.ok) throw new Error(`GitHub error (${r.status})`);
      const j = await r.json();
      for (const x of j.repositories || []) {
        out.push({ full_name: x.full_name, clone_url: x.clone_url, private: x.private, default_branch: x.default_branch, pushed_at: x.pushed_at });
      }
      if ((j.repositories || []).length < 100) break;
    }
    return out.sort((a, b) => (String(a.pushed_at) < String(b.pushed_at) ? 1 : -1)); // newest push first
  }
  if (!gh.github_token) throw new Error('not connected');
  return listRepos(gh.github_token);
}

// Connection status for the dashboard: app | pat | none — for one user.
export function connection(database, username) {
  const gh = db.getUserGithub(database, username);
  if (gh.gh_app_id) {
    return { mode: 'app', slug: gh.gh_app_slug || null, installed: !!gh.gh_app_installation_id };
  }
  if (gh.github_token) return { mode: 'pat', login: gh.github_login || null };
  return { mode: 'none' };
}
