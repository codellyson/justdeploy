// Postgres: a saved `docker run`, executed once per project, never per deploy.
// JustDeploy runs apps as HOST processes (not containers), so the DB must be reachable from
// the host — we publish it on a localhost-only port (127.0.0.1) and use that in the conn
// string. Bound to 127.0.0.1 so it's never exposed to the internet.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DOCKER_NET } from './paths.js';
import * as db from './db.js';
import * as firewall from './firewall.js';

function docker(argv) {
  const r = spawnSync('docker', argv, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${argv[0]} failed: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}

function ensureNetwork() {
  // idempotent: create the shared network if missing
  const nets = docker(['network', 'ls', '--format', '{{.Name}}']).split('\n');
  if (!nets.includes(DOCKER_NET)) docker(['network', 'create', DOCKER_NET]);
}

const rand = () => randomBytes(18).toString('base64url'); // safe for SQL single-quotes

function runContainer({ name, base, superPass, dbName, bind, port }) {
  docker([
    'run', '-d', '--name', name, '--restart', 'unless-stopped',
    '-e', `POSTGRES_PASSWORD=${superPass}`, '-e', `POSTGRES_DB=${dbName}`,
    '-v', `${base}-pgdata:/var/lib/postgresql/data`, '--network', DOCKER_NET,
    '-p', `${bind}:${port}:5432`, 'postgres:16',
  ]);
}

// Wait for the server to accept connections (docker exec uses local `trust` auth — no password).
function waitReady(name, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' }).status === 0) return true;
    spawnSync('sh', ['-c', 'sleep 0.5']);
  }
  throw new Error('database did not become ready in time');
}

function psql(name, sql, dbName) {
  const args = ['exec', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  if (dbName) args.push('-d', dbName);
  args.push('-c', sql);
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}

// A non-superuser role that OWNS the database — full DDL/DML and trusted extensions, but NOT a
// cluster superuser (so no `COPY … FROM PROGRAM` RCE if its password leaks). This is the role we
// hand out; the `postgres` superuser stays internal (reachable only via local `trust`).
function ensureAppRole(name, dbName, appUser, appPass) {
  const U = `"${appUser}"`, D = `"${dbName}"`; // quote identifiers (names may contain hyphens)
  psql(name, `DO $$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${appUser}') THEN CREATE ROLE ${U}; END IF; END$$;`);
  psql(name, `ALTER ROLE ${U} WITH LOGIN NOSUPERUSER PASSWORD '${appPass}';`);
  psql(name, `GRANT ALL ON DATABASE ${D} TO ${U};`);
  psql(name, `ALTER DATABASE ${D} OWNER TO ${U};`);
  psql(name, `ALTER SCHEMA public OWNER TO ${U};`, dbName);
  psql(name, `GRANT ALL ON SCHEMA public TO ${U};`, dbName);
}

const KEY = '/var/lib/postgresql/data/server.key';
const CRT = '/var/lib/postgresql/data/server.crt';

function tlsOn(name) {
  return spawnSync('docker', ['exec', name, 'test', '-f', KEY], { encoding: 'utf8' }).status === 0;
}

// Install a self-signed cert into the volume and turn ssl on via ALTER SYSTEM (a reloadable
// setting — no restart). Both persist in the data volume across container recreates. Idempotent.
export function enableTls(name) {
  if (tlsOn(name)) return true;
  const tmp = `/tmp/jd-tls-${name}`;
  const gen = spawnSync('sh', ['-c', `rm -rf ${tmp} && mkdir -p ${tmp} && openssl req -new -x509 -days 3650 -nodes -newkey rsa:2048 -keyout ${tmp}/server.key -out ${tmp}/server.crt -subj "/CN=${name}" 2>&1`], { encoding: 'utf8' });
  if (gen.status !== 0) throw new Error(`cert generation failed: ${(gen.stdout || '').trim()}`);
  docker(['cp', `${tmp}/server.key`, `${name}:${KEY}`]);
  docker(['cp', `${tmp}/server.crt`, `${name}:${CRT}`]);
  spawnSync('docker', ['exec', '-u', 'root', name, 'sh', '-c', `chown postgres:postgres ${KEY} ${CRT} && chmod 600 ${KEY} && chmod 644 ${CRT}`], { encoding: 'utf8' });
  spawnSync('sh', ['-c', `rm -rf ${tmp}`]);
  psql(name, 'ALTER SYSTEM SET ssl = on;');
  spawnSync('docker', ['exec', name, 'psql', '-U', 'postgres', '-c', 'SELECT pg_reload_conf();'], { encoding: 'utf8' });
  return true;
}

// Provision a container named <name>-db with a named volume that survives redeploys. Hands out
// a scoped `app` role (non-superuser), and enables TLS. The superuser password is kept in settings.
export function provision(database, name, { dbName = name } = {}) {
  ensureNetwork();
  const container = `${name}-db`;
  const superPass = rand();
  const appPass = rand();
  const port = db.allocatePgPort(database);

  runContainer({ name: container, base: name, superPass, dbName, bind: '127.0.0.1', port });
  db.setSetting(database, `pgsuper:${container}`, superPass);
  waitReady(container);
  ensureAppRole(container, dbName, 'app', appPass);
  enableTls(container);

  // Host-reachable connection string using the scoped role (apps run on the host → 127.0.0.1).
  const conn = `postgres://app:${appPass}@127.0.0.1:${port}/${dbName}?sslmode=require`;
  db.addResource(database, container, 'postgres', conn, port, new Date().toISOString());
  return { container, conn, port };
}

// Retrofit an existing DB from the postgres superuser to a scoped `app` role (idempotent).
export function ensureRole(database, name) {
  const cur = info(database, name);
  if (!cur) throw new Error('no such database');
  enableTls(name); // ensure TLS regardless of role state
  if (cur.user !== 'postgres') return { conn: cur.conn, already: true };
  db.setSetting(database, `pgsuper:${name}`, cur.password); // the current password is the superuser's
  const appPass = rand();
  waitReady(name);
  ensureAppRole(name, cur.dbName, 'app', appPass);
  const conn = `postgres://app:${appPass}@127.0.0.1:${cur.port}/${cur.dbName}`;
  db.addResource(database, name, 'postgres', conn, cur.port, new Date().toISOString());
  return { conn, user: 'app' };
}

const CONN_RE = /^postgres:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/; // dbName stops before ?query

// The host to hand out for public connection strings — a configured `public_host` (e.g. a
// domain you point at the box) or the detected public IPv4.
function publicHost(database) {
  let h = db.getSetting(database, 'public_host');
  if (!h) {
    const r = spawnSync('sh', ['-c', 'curl -s --max-time 4 https://api.ipify.org || hostname -I | awk "{print $1}"'], { encoding: 'utf8' });
    h = (r.stdout || '').trim();
    if (h) db.setSetting(database, 'public_host', h);
  }
  return h || '127.0.0.1';
}

// Full detail for a provisioned Postgres, including BOTH a private (localhost) and a public
// (external host) connection URL — like managed providers. The private URL always works for
// apps on this box; the public URL only works when the port is published publicly.
export function info(database, name) {
  const r = db.getResource(database, name);
  if (!r || r.kind !== 'postgres') return null;
  const m = (r.conn || '').match(CONN_RE) || [];
  const [, user, password, , port, dbName] = m;
  let status = 'unknown', image = '', startedAt = null;
  const insp = spawnSync('docker', ['inspect', name, '--format', '{{.State.Status}}|{{.Config.Image}}|{{.State.StartedAt}}'], { encoding: 'utf8' });
  if (insp.status === 0) { [status, image, startedAt] = insp.stdout.trim().split('|'); }
  const bindInsp = spawnSync('docker', ['inspect', name, '--format', '{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostIp }}'], { encoding: 'utf8' });
  const isPublic = (bindInsp.stdout || '').trim() === '0.0.0.0';
  const ph = publicHost(database);
  const tls = tlsOn(name);
  const q = tls ? '?sslmode=require' : '';
  return {
    name, kind: 'postgres', created_at: r.created_at,
    port: Number(port || r.port), dbName, user, password,
    status, image, startedAt, running: status === 'running',
    public: isPublic, publicHost: ph, tls, scoped: user !== 'postgres',
    allowIps: (r.allow_ips || '').split(',').map((s) => s.trim()).filter(Boolean),
    privateConn: `postgres://${user}:${password}@127.0.0.1:${port}/${dbName}${q}`,
    publicConn: `postgres://${user}:${password}@${ph}:${port}/${dbName}${q}`,
    conn: r.conn, // stored (private) — what on-box apps use
  };
}

// Toggle public exposure. Recreates the container on the same volume (data preserved) with the
// port bound to 0.0.0.0 (public) or 127.0.0.1 (private). The stored conn stays private — apps
// on the box always use that; the public URL is for external clients. When public, an optional
// `allowIps` list installs a DOCKER-USER firewall allowlist (recommended); empty = open.
export function setExposure(database, name, isPublic, allowIps = []) {
  const cur = info(database, name);
  if (!cur) throw new Error('no such database');
  const base = name.replace(/-db$/, '');
  const superPass = db.getSetting(database, `pgsuper:${name}`) || cur.password;
  const bind = isPublic ? '0.0.0.0' : '127.0.0.1';
  docker(['rm', '-f', name]); // keep the volume
  runContainer({ name, base, superPass, dbName: cur.dbName, bind, port: cur.port });
  const list = isPublic ? (allowIps || []).map((s) => s.trim()).filter(Boolean) : [];
  db.setResourceAllow(database, name, list.length ? list.join(',') : null);
  if (isPublic && list.length) firewall.allow(name, cur.port, list);
  else firewall.clear(name); // private, or public-to-everyone
  return { public: isPublic, allowIps: list };
}

// Restart the container.
export function restart(name) {
  const r = spawnSync('docker', ['restart', name], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`restart failed: ${(r.stderr || '').trim()}`);
  return true;
}

// Rotate the handed-out role's password (the user in the conn string, i.e. the scoped `app`
// role — not the superuser), then update the stored conn.
export function resetPassword(database, name) {
  const res = db.getResource(database, name);
  const m = (res.conn || '').match(CONN_RE);
  if (!m) throw new Error('unparseable connection string');
  const [, user, , host, port, dbName] = m;
  const pass = rand();
  psql(name, `ALTER ROLE "${user}" WITH LOGIN PASSWORD '${pass}';`);
  const conn = `postgres://${user}:${pass}@${host}:${port}/${dbName}`;
  db.addResource(database, name, 'postgres', conn, Number(port), new Date().toISOString());
  return { conn };
}

// Remove a provisioned Postgres: container + its named volume (destroys the data).
export function deprovision(database, resourceName, { keepData = false } = {}) {
  const base = resourceName.replace(/-db$/, '');
  const volume = `${base}-pgdata`;
  spawnSync('docker', ['rm', '-f', resourceName], { encoding: 'utf8' });
  if (!keepData) spawnSync('docker', ['volume', 'rm', '-f', volume], { encoding: 'utf8' });
  db.removeResource(database, resourceName);
  return { container: resourceName, volume, keptData: keepData };
}
