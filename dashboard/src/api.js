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
  resourceLogStream: (name) => new EventSource(`/api/resources/${name}/logs/stream`),

  // GitHub source connection
  githubStatus: () => req('/github'),
  githubConnect: (token) => req('/github', { method: 'POST', body: { token } }),
  githubDisconnect: () => req('/github', { method: 'DELETE' }),
  githubRepos: () => req('/github/repos'),
  githubDetect: (repo) => req('/github/detect?repo=' + encodeURIComponent(repo)),

  // SSE — returns the EventSource so the caller can close it.
  stream: (name) => new EventSource(`/api/apps/${name}/stream`),
};
