// Backup / restore. With SQLite as the single source of truth, this is the safety net.
// A backup captures exactly the irreplaceable state — the state db, each app's persistent
// data/ dir, and a pg_dump of every provisioned Postgres — and nothing rebuildable (repos,
// logs, build output). One gzipped tar, chmod 600 (it contains secrets).
import { mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME, STATE_DB, dataDir } from './paths.js';
import * as db from './db.js';

export const BACKUP_DIR = join(HOME, 'backups');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r;
}

// stamp is passed in (caller stamps with the real clock) so this stays deterministic.
export function create(database, { out = BACKUP_DIR, keep, stamp } = {}) {
  const ts = stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const work = join(HOME, `.backup-tmp-${ts}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(out, { recursive: true });

  // 1. Consistent snapshot of the state db (VACUUM INTO reads through WAL — safe while live).
  const snap = join(work, 'state.db');
  database.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);

  // 2. Each app's persistent data dir.
  const apps = db.listApps(database);
  const dataRoot = join(work, 'data');
  mkdirSync(dataRoot, { recursive: true });
  let dataDirs = 0;
  for (const a of apps) {
    const d = dataDir(a.name);
    if (existsSync(d)) { sh('cp', ['-a', d, join(dataRoot, a.name)]); dataDirs += 1; }
  }

  // 3. pg_dumpall for each Postgres resource (skips gracefully if the container is down).
  const pgRoot = join(work, 'postgres');
  mkdirSync(pgRoot, { recursive: true });
  const resources = db.listResources(database).filter((r) => r.kind === 'postgres');
  const pgOk = [];
  for (const r of resources) {
    const res = spawnSync('docker', ['exec', r.name, 'pg_dumpall', '-U', 'postgres'],
      { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (res.status === 0) { writeFileSync(join(pgRoot, `${r.name}.sql`), res.stdout); pgOk.push(r.name); }
  }

  writeFileSync(join(work, 'manifest.json'), JSON.stringify({
    created: ts,
    apps: apps.map((a) => ({ name: a.name, type: a.type, domain: a.domain, serve: a.serve })),
    postgres: pgOk,
  }, null, 2));

  // 4. One archive, locked down (contains secrets).
  const archive = join(out, `justdeploy-${ts}.tar.gz`);
  sh('tar', ['-czf', archive, '-C', work, '.']);
  chmodSync(archive, 0o600);
  rmSync(work, { recursive: true, force: true });

  if (keep) prune(out, keep);
  const size = statSync(archive).size;
  return { archive, size, apps: apps.length, dataDirs, postgres: pgOk.length };
}

// Keep only the newest `n` archives in `dir`.
export function prune(dir, n) {
  const files = readdirSync(dir)
    .filter((f) => /^justdeploy-.*\.tar\.gz$/.test(f))
    .map((f) => join(dir, f))
    .sort(); // ISO timestamps sort chronologically
  const remove = files.slice(0, Math.max(0, files.length - n));
  for (const f of remove) rmSync(f, { force: true });
  return remove.length;
}

// Restore from an archive. Overwrites current state — the caller must confirm and stop the
// dashboard first (it holds state.db open). Returns what was restored.
export function restore(archivePath, { stamp } = {}) {
  if (!existsSync(archivePath)) throw new Error(`no such backup: ${archivePath}`);
  const ts = stamp || new Date().toISOString().replace(/[:.]/g, '-');
  const work = join(HOME, `.restore-tmp-${ts}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  sh('tar', ['-xzf', archivePath, '-C', work]);

  const manifest = JSON.parse(sh('cat', [join(work, 'manifest.json')]).stdout);

  // 1. state db — replace file, clear stale WAL/SHM.
  sh('cp', ['-f', join(work, 'state.db'), STATE_DB]);
  for (const ext of ['-wal', '-shm']) rmSync(STATE_DB + ext, { force: true });

  // 2. app data dirs.
  const dataRoot = join(work, 'data');
  if (existsSync(dataRoot)) {
    for (const name of readdirSync(dataRoot)) {
      const dest = dataDir(name);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(join(dest, '..'), { recursive: true });
      sh('cp', ['-a', join(dataRoot, name), dest]);
    }
  }

  // 3. Postgres — pipe each dump back into its (running) container.
  const pgRoot = join(work, 'postgres');
  const pgRestored = [];
  if (existsSync(pgRoot)) {
    for (const f of readdirSync(pgRoot)) {
      const container = f.replace(/\.sql$/, '');
      const dump = sh('cat', [join(pgRoot, f)]).stdout;
      const res = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres'],
        { input: dump, encoding: 'utf8' });
      if (res.status === 0) pgRestored.push(container);
    }
  }

  rmSync(work, { recursive: true, force: true });
  return { apps: manifest.apps?.length || 0, postgres: pgRestored };
}
