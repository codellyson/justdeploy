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

// Detect the app type from a repo's package.json so the right build config is matched to it
// (rather than the user guessing). Returns { type, reason }.
export async function detectType(token, fullName) {
  const r = await fetch(`${API}/repos/${fullName}/contents/package.json`, { headers: headers(token) });
  if (r.status === 404) return { type: 'static', reason: 'no package.json — served as a static site' };
  if (!r.ok) throw new Error(`GitHub error (${r.status})`);
  let pkg;
  try { pkg = JSON.parse(Buffer.from((await r.json()).content, 'base64').toString('utf8')); }
  catch { return { type: 'static', reason: 'unreadable package.json' }; }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.next) return { type: 'nextjs', reason: 'Next.js detected' };
  if (deps['@adonisjs/core']) return { type: 'adonis', reason: 'AdonisJS detected' };
  if (deps.vite || deps['@vitejs/plugin-react'] || deps['@vitejs/plugin-vue']) return { type: 'vite', reason: 'Vite detected' };
  if (deps['react-scripts']) return { type: 'react', reason: 'Create React App detected' };
  if (pkg.scripts && pkg.scripts.build) return { type: 'vite', reason: 'build script found — building to dist/' };
  return { type: 'static', reason: 'no build step — served as a static site' };
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
let _cache = { token: null, exp: 0 };
export async function activeToken(database) {
  const appId = db.getSetting(database, 'gh_app_id');
  const pem = db.getSetting(database, 'gh_app_pem');
  if (appId && pem) {
    let instId = db.getSetting(database, 'gh_app_installation_id');
    if (!instId) {
      const insts = await appInstallations(appId, pem).catch(() => []);
      instId = insts[0]?.id;
      if (instId) db.setSetting(database, 'gh_app_installation_id', String(instId));
    }
    if (instId) {
      if (_cache.token && Date.now() < _cache.exp) return _cache.token;
      const token = await installationToken(appId, pem, instId);
      _cache = { token, exp: Date.now() + 50 * 60 * 1000 };
      return token;
    }
  }
  return db.getSetting(database, 'github_token') || null;
}

// git clone auth for a repo, resolving the active token (App or PAT).
export async function cloneAuthEnv(database, repo) {
  return gitAuthEnv(await activeToken(database), repo);
}

// Connection status for the dashboard: app | pat | none.
export function connection(database) {
  if (db.getSetting(database, 'gh_app_id')) {
    return { mode: 'app', slug: db.getSetting(database, 'gh_app_slug') || null, installed: !!db.getSetting(database, 'gh_app_installation_id') };
  }
  if (db.getSetting(database, 'github_token')) return { mode: 'pat', login: db.getSetting(database, 'github_login') || null };
  return { mode: 'none' };
}
