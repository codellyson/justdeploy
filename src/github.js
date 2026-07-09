// Minimal GitHub API helpers + git auth. A single Personal Access Token (stored in settings)
// powers both the repo picker (list repos) and private-repo cloning (injected into git).
const API = 'https://api.github.com';

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
