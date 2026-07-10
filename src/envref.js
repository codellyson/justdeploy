// Railway-style variable references in env values, resolved at deploy time.
//
//   DB_HOST=${{lucky-meadow-db.PGHOST}}     # a field of a provisioned postgres resource
//   DATABASE_URL=${{lucky-meadow-db.DATABASE_URL}}
//   API_URL=${{web.PUBLIC_URL}}             # another app's env var
//   ORIGIN=${{APP_URL}}                      # this app's own env var (no dot)
//
// Env is stored verbatim in the state db; this expands the `${{ ... }}` tokens each deploy,
// so rotating a db password or re-pointing a reference takes effect on the next deploy without
// re-editing every consumer. An unresolved reference throws a plain-English error that fails the
// deploy (never ships a literal `${{...}}` to the app).
import * as db from './db.js';
import * as pg from './postgres.js';

const RE = /\$\{\{\s*([\w-]+)(?:\.([\w-]+))?\s*\}\}/g;
export const hasRef = (v) => typeof v === 'string' && RE.test(v);

// The postgres fields advertised in the dashboard's reference autocomplete, best-first. The
// resolver (pgFields) also accepts friendly aliases (HOST, PORT, URL, …); these are the canonical
// names we surface. Keep in sync with pgFields below.
export const PG_REF_FIELDS = [
  'DATABASE_URL', 'DATABASE_PUBLIC_URL', 'PGHOST', 'PGPORT',
  'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE',
];

// The fields a postgres resource exposes. Apps run as host processes, so the reachable host is
// always 127.0.0.1 (the localhost-published port) — the same address the stored conn uses.
function pgFields(info) {
  if (!info) return null;
  const url = info.privateConn;
  return {
    PGHOST: '127.0.0.1', PGPORT: String(info.port), PGUSER: info.user,
    PGPASSWORD: info.password, PGDATABASE: info.dbName,
    PGSSLMODE: info.tls ? 'require' : 'disable',
    DATABASE_URL: url, DATABASE_PRIVATE_URL: url, DATABASE_PUBLIC_URL: info.publicConn,
    // friendly aliases for the same values
    HOST: '127.0.0.1', PORT: String(info.port), USER: info.user, PASSWORD: info.password,
    DATABASE: info.dbName, NAME: info.dbName, URL: url, SSLMODE: info.tls ? 'require' : 'disable',
  };
}

// List what a reference *could* point at, for the "no such source" error.
function sources(database) {
  const res = db.listResources(database).filter((r) => r.kind === 'postgres').map((r) => r.name);
  const apps = db.listApps(database).map((a) => a.name);
  return [...res, ...apps].join(', ') || '(none)';
}

// Expand every `${{...}}` in an app's env map. `self` is the app's own merged env (stored env +
// autoEnv like PORT), so bare `${{KEY}}` and `${{PORT}}` self-references work too.
export function resolveEnv(database, appName, self) {
  const cache = new Map();   // `${app}\0${key}` -> resolved value
  const stack = new Set();   // in-progress, for cycle detection

  const rawEnvOf = (app) => (app === appName ? self : db.getEnv(database, app));

  const fail = (owner, token, detail) => {
    throw new Error(`unresolved env reference ${token} in ${owner}: ${detail}`);
  };

  function resolveKey(app, key) {
    const id = `${app}\0${key}`;
    if (cache.has(id)) return cache.get(id);
    if (stack.has(id)) throw new Error(`circular env reference at ${app}.${key}`);
    const raw = rawEnvOf(app)[key];
    if (raw === undefined) return undefined;
    stack.add(id);
    const out = expand(String(raw), app);
    stack.delete(id);
    cache.set(id, out);
    return out;
  }

  function expand(value, owner) {
    return value.replace(RE, (token, src, key) => {
      if (key === undefined) {
        // ${{KEY}} — this app's own env var
        const v = resolveKey(owner, src);
        if (v === undefined) fail(owner, token, `no env var '${src}' on this app`);
        return v;
      }
      // ${{Source.KEY}} — a postgres resource first, then another app
      const res = db.getResource(database, src);
      if (res && res.kind === 'postgres') {
        const fields = pgFields(pg.info(database, src));
        if (!fields || !(key in fields)) {
          fail(owner, token, `postgres '${src}' has no field '${key}' — try PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, or DATABASE_URL`);
        }
        return fields[key];
      }
      if (db.getApp(database, src)) {
        const v = resolveKey(src, key);
        if (v === undefined) fail(owner, token, `app '${src}' has no env var '${key}'`);
        return v;
      }
      fail(owner, token, `no resource or app named '${src}'. Available: ${sources(database)}`);
    });
  }

  const out = {};
  for (const k of Object.keys(self)) out[k] = resolveKey(appName, k);
  return out;
}
