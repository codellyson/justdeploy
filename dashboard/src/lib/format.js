export const cx = (...parts) => parts.filter(Boolean).join(' ');

// Slugify a project name into a DNS/URL-safe label.
export const slug = (s) => (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// A friendly random project name, Vercel-style (adjective-noun).
const ADJ = ['swift', 'calm', 'bright', 'bold', 'lucky', 'quiet', 'brave', 'fresh', 'noble', 'sunny', 'cosmic', 'amber', 'violet', 'misty', 'silent', 'rapid'];
const NOUN = ['otter', 'falcon', 'harbor', 'meadow', 'cedar', 'comet', 'ember', 'delta', 'lotus', 'pixel', 'quartz', 'river', 'summit', 'willow', 'aurora', 'nebula'];
const rand = (a) => a[Math.floor(Math.random() * a.length)];
export const suggestName = () => `${rand(ADJ)}-${rand(NOUN)}`;

// Derive a project name from a git repo URL (its basename, slugified).
export const nameFromRepo = (repo) => slug((repo || '').replace(/\.git$/, '').split('/').filter(Boolean).pop() || '');

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

export const TYPE_LABEL = {
  react: 'React',
  vite: 'Vite',
  static: 'Static',
  adonis: 'AdonisJS',
  nextjs: 'Next.js',
  postgres: 'Postgres',
  sqlite: 'SQLite',
};
export const typeLabel = (t) => TYPE_LABEL[t] || t;

// App health for the status system: ok | running | failed | idle.
export function appHealth(app) {
  if (app.deploying) return 'running';
  const d = app.lastDeploy;
  if (!d) return 'idle';
  if (d.status === 'failed') return 'failed';
  if (d.status === 'running') return 'running';
  return 'ok';
}
