// Postgres: a saved `docker run`, executed once per project, never per deploy.
// JustDeploy runs apps as HOST processes (not containers), so the DB must be reachable from
// the host — we publish it on a localhost-only port (127.0.0.1) and use that in the conn
// string. Bound to 127.0.0.1 so it's never exposed to the internet.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DOCKER_NET } from './paths.js';
import * as db from './db.js';

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

// Provision a container named <name>-db with a named volume that survives redeploys.
export function provision(database, name, { dbName = name, password } = {}) {
  ensureNetwork();
  const container = `${name}-db`;
  const volume = `${name}-pgdata`;
  const pass = password || randomBytes(18).toString('base64url');
  const port = db.allocatePgPort(database);

  docker([
    'run', '-d',
    '--name', container,
    '--restart', 'unless-stopped',
    '-e', `POSTGRES_PASSWORD=${pass}`,
    '-e', `POSTGRES_DB=${dbName}`,
    '-v', `${volume}:/var/lib/postgresql/data`,
    '--network', DOCKER_NET,
    '-p', `127.0.0.1:${port}:5432`, // reachable from host-run apps, localhost only
    'postgres:16',
  ]);

  // Host-reachable connection string (apps run on the host, so use 127.0.0.1:<port>).
  const conn = `postgres://postgres:${pass}@127.0.0.1:${port}/${dbName}`;
  db.addResource(database, container, 'postgres', conn, port, new Date().toISOString());
  return { container, conn, port };
}

const CONN_RE = /^postgres:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/(.+)$/;

// Full detail for a provisioned Postgres: parsed connection + live container status.
export function info(database, name) {
  const r = db.getResource(database, name);
  if (!r || r.kind !== 'postgres') return null;
  const m = (r.conn || '').match(CONN_RE) || [];
  const [, user, password, host, port, dbName] = m;
  let status = 'unknown', image = '', startedAt = null;
  const insp = spawnSync('docker', ['inspect', name, '--format', '{{.State.Status}}|{{.Config.Image}}|{{.State.StartedAt}}'], { encoding: 'utf8' });
  if (insp.status === 0) { [status, image, startedAt] = insp.stdout.trim().split('|'); }
  return {
    name, kind: 'postgres', conn: r.conn, created_at: r.created_at,
    host, port: Number(port || r.port), dbName, user, password,
    status, image, startedAt, running: status === 'running',
  };
}

// Restart the container.
export function restart(name) {
  const r = spawnSync('docker', ['restart', name], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`restart failed: ${(r.stderr || '').trim()}`);
  return true;
}

// Rotate the password: ALTER USER inside the container, then update the stored conn string.
export function resetPassword(database, name) {
  const res = db.getResource(database, name);
  const m = (res.conn || '').match(CONN_RE);
  if (!m) throw new Error('unparseable connection string');
  const [, , , , port, dbName] = m;
  const pass = randomBytes(18).toString('base64url'); // safe chars for SQL single-quotes
  const ex = spawnSync('docker', ['exec', name, 'psql', '-U', 'postgres', '-c', `ALTER USER postgres PASSWORD '${pass}';`], { encoding: 'utf8' });
  if (ex.status !== 0) throw new Error(`reset failed: ${(ex.stderr || '').trim()}`);
  const conn = `postgres://postgres:${pass}@127.0.0.1:${port}/${dbName}`;
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
