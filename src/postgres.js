// Postgres: a saved `docker run`, executed once per project, never per deploy.
// On a shared Docker network, no host port published — apps reach it at <name>:5432.
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

  docker([
    'run', '-d',
    '--name', container,
    '--restart', 'unless-stopped',
    '-e', `POSTGRES_PASSWORD=${pass}`,
    '-e', `POSTGRES_DB=${dbName}`,
    '-v', `${volume}:/var/lib/postgresql/data`,
    '--network', DOCKER_NET,
    'postgres:16',
  ]);

  // Reachable only from inside deploy-net, by container name.
  const conn = `postgres://postgres:${pass}@${container}:5432/${dbName}`;
  db.addResource(database, container, 'postgres', conn, new Date().toISOString());
  return { container, conn };
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
