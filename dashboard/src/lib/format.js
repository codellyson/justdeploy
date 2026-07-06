export const cx = (...parts) => parts.filter(Boolean).join(' ');

export const shortSha = (sha) => (sha ? sha.slice(0, 7) : '');

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const TYPE_META = {
  react: { glyph: '⚛', label: 'React' },
  vite: { glyph: '⚡', label: 'Vite' },
  static: { glyph: '𝗛', label: 'Static' },
  adonis: { glyph: '𝗔', label: 'AdonisJS' },
  nextjs: { glyph: '▲', label: 'Next.js' },
  postgres: { glyph: '🐘', label: 'Postgres' },
  sqlite: { glyph: '🗄', label: 'SQLite' },
};
export const typeMeta = (t) => TYPE_META[t] || { glyph: '◆', label: t };

// App health for the status system: ok | running | failed | idle.
export function appHealth(app) {
  if (app.deploying) return 'running';
  const d = app.lastDeploy;
  if (!d) return 'idle';
  if (d.status === 'failed') return 'failed';
  if (d.status === 'running') return 'running';
  return 'ok';
}
