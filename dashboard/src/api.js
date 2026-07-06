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
  rollback: (name) => req(`/apps/${name}/rollback`, { method: 'POST' }),
  remove: (name) => req(`/apps/${name}`, { method: 'DELETE' }),
  getEnv: (name) => req(`/apps/${name}/env`),
  setEnv: (name, env) => req(`/apps/${name}/env`, { method: 'PUT', body: { env } }),
  setConfig: (name, cfg) => req(`/apps/${name}/config`, { method: 'PUT', body: cfg }),
  removeResource: (name) => req(`/resources/${name}`, { method: 'DELETE' }),

  // SSE — returns the EventSource so the caller can close it.
  stream: (name) => new EventSource(`/api/apps/${name}/stream`),
};
