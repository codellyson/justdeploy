import { track } from './lib/analytics';

// Thin client over the JustDeploy dashboard API. Same-origin, cookie session.
async function req(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const api = {
  session: () => req('/session'),
  login: (password) => req('/login', { method: 'POST', body: { password } }),
  logout: () => req('/logout', { method: 'POST' }),
  state: () => req('/state'),
  graph: (project) => req('/graph' + (project ? `?project=${project}` : '')),
  projects: () => req('/projects'),
  createProject: (name) => req('/projects', { method: 'POST', body: { name } }),
  removeProject: (name) => req(`/projects/${name}`, { method: 'DELETE' }),

  createApp: (body) => req('/apps', { method: 'POST', body }),
  deploy: (name) => req(`/apps/${name}/deploy`, { method: 'POST' }),
  rollback: (name, sha) => req(`/apps/${name}/rollback`, { method: 'POST', body: sha ? { sha } : {} }),
  remove: (name) => req(`/apps/${name}`, { method: 'DELETE' }),
  getEnv: (name) => req(`/apps/${name}/env`),
  setEnv: (name, env) => req(`/apps/${name}/env`, { method: 'PUT', body: { env } }),
  envRefs: (name) => req(`/apps/${name}/refs`),
  setConfig: (name, cfg) => req(`/apps/${name}/config`, { method: 'PUT', body: cfg }),
  resource: (name) => req(`/resources/${name}`),
  removeResource: (name) => req(`/resources/${name}`, { method: 'DELETE' }),
  restartResource: (name) => req(`/resources/${name}/restart`, { method: 'POST' }),
  resetResourcePassword: (name) => req(`/resources/${name}/reset-password`, { method: 'POST' }),
  exposeResource: (name, isPublic, allowIps = []) => req(`/resources/${name}/expose`, { method: 'POST', body: { public: isPublic, allowIps } }),
  myIp: () => req('/myip'),
  setDbHost: (host) => req('/settings/public-host', { method: 'PUT', body: { host } }),

  // First-run setup wizard + settings
  doctor: () => req('/doctor'),
  setBaseDomain: (domain) => req('/settings/base-domain', { method: 'PUT', body: { domain } }),
  dismissOnboarding: () => req('/onboarding/dismiss', { method: 'POST' }),
  setPassword: (current, next) => req('/settings/password', { method: 'PUT', body: { current, next } }),
  backupSettings: () => req('/settings/backup'),
  setBackupConfig: (cfg) => req('/settings/backup', { method: 'PUT', body: cfg }),
  runBackup: (local = false) => req('/backup/run', { method: 'POST', body: { local } }),
  setBackupSchedule: (interval, keep = 7) => req('/backup/schedule', { method: 'POST', body: { interval, keep } }),
  backups: () => req('/backups'),
  restoreBackup: (file) => req('/backup/restore', { method: 'POST', body: { file } }),
  webhookInfo: () => req('/settings/webhook'),
  enableWebhook: () => req('/settings/webhook', { method: 'POST' }),
  disableWebhook: () => req('/settings/webhook', { method: 'DELETE' }),
  host: () => req('/host'),
  reconcile: () => req('/maintenance/reconcile', { method: 'POST' }),
  gc: () => req('/maintenance/gc', { method: 'POST' }),
  resourceLogStream: (name) => new EventSource(`/api/resources/${name}/logs/stream`),

  // GitHub source connection
  githubStatus: () => req('/github'),
  githubAppNew: () => req('/github/app/new'),
  githubConnect: (token) => req('/github', { method: 'POST', body: { token } }),
  githubDisconnect: () => req('/github', { method: 'DELETE' }),
  githubRepos: () => req('/github/repos'),
  githubDetect: (repo) => req('/github/detect?repo=' + encodeURIComponent(repo)),

  // SSE — returns the EventSource so the caller can close it. kind: 'build' | 'runtime'.
  stream: (name, kind = 'build') => new EventSource(`/api/apps/${name}/stream?kind=${kind}`),
};

// Every mutating action is tracked in Aptabase from here, so no call site can forget to. Each
// entry maps an api method to a SAFE props extractor — resource names and enums only, NEVER
// secrets (passwords, tokens, env values, allow-list IPs, backup filenames). Read-only methods
// are absent and thus never tracked. Events fire on success only, so validation failures and
// wrong-password attempts don't pollute usage stats.
const ACTIONS = {
  login: () => ({}),
  logout: () => ({}),
  createProject: (name) => ({ name }),
  removeProject: (name) => ({ name }),
  createApp: (body) => ({ type: body?.type, serve: body?.serve }),
  deploy: (name) => ({ name }),
  rollback: (name, sha) => ({ name, pinned: !!sha }),
  remove: (name) => ({ name }),
  setEnv: (name) => ({ name }),
  setConfig: (name) => ({ name }),
  removeResource: (name) => ({ name }),
  restartResource: (name) => ({ name }),
  resetResourcePassword: (name) => ({ name }),
  exposeResource: (name, isPublic) => ({ name, public: !!isPublic }),
  setDbHost: () => ({}),
  setBaseDomain: () => ({}),
  dismissOnboarding: () => ({}),
  setPassword: () => ({}),
  setBackupConfig: () => ({}),
  runBackup: (local) => ({ local: !!local }),
  setBackupSchedule: (interval) => ({ interval }),
  restoreBackup: () => ({}),
  enableWebhook: () => ({}),
  disableWebhook: () => ({}),
  reconcile: () => ({}),
  gc: () => ({}),
  githubConnect: () => ({}),
  githubDisconnect: () => ({}),
};

for (const [name, safeProps] of Object.entries(ACTIONS)) {
  const orig = api[name];
  api[name] = (...args) => {
    const out = orig(...args);
    Promise.resolve(out).then(() => track(name, safeProps(...args)), () => {});
    return out;
  };
}

// Launch the GitHub App create flow: fetch the pre-filled manifest, then POST it to GitHub as a
// top-level form navigation (GitHub shows "Create GitHub App", then redirects back to our callback).
export async function connectGithubApp() {
  const { action, manifest } = await api.githubAppNew();
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  document.body.appendChild(form);
  track('githubAppConnect');
  form.submit();
}
