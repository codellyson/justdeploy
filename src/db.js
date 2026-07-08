// SQLite state db — the SOURCE OF TRUTH for apps + runtime state. Not rebuildable from the
// yml files (they aren't read back); this is the one file to back up. `justdeploy reconcile`
// rebuilds Caddy's live config FROM this db, not the other way around.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { STATE_DB, PORT_BASE } from './paths.js';

export function open(file = STATE_DB) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL + a busy timeout so the dashboard process and the CLI can both touch the db.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      name         TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      domain       TEXT,
      repo         TEXT,
      serve        TEXT NOT NULL,
      live_port    INTEGER,
      pending_port INTEGER,
      live_pid     INTEGER,
      health_path  TEXT NOT NULL DEFAULT '/',
      health_timeout INTEGER NOT NULL DEFAULT 30,
      drain_seconds  INTEGER NOT NULL DEFAULT 10,
      release_cmd  TEXT,
      persist      TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS env (
      app   TEXT NOT NULL,
      key   TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (app, key)
    );
    CREATE TABLE IF NOT EXISTS deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app TEXT NOT NULL,
      sha TEXT,
      status TEXT NOT NULL,
      message TEXT,
      reason TEXT,
      hint TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS resources (
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      conn TEXT,
      port INTEGER,
      allow_ips TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Migrations for dbs created before these columns existed (ALTER throws if present).
  for (const alter of [
    'ALTER TABLE apps ADD COLUMN release_cmd TEXT',
    'ALTER TABLE apps ADD COLUMN persist TEXT',
    'ALTER TABLE deploys ADD COLUMN reason TEXT',
    'ALTER TABLE deploys ADD COLUMN hint TEXT',
    'ALTER TABLE resources ADD COLUMN port INTEGER',
    'ALTER TABLE resources ADD COLUMN allow_ips TEXT',
  ]) { try { db.exec(alter); } catch { /* column already exists */ } }
  return db;
}

export const getSetting = (db, key) =>
  db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;

export const setSetting = (db, key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));

export const listResources = (db) =>
  db.prepare('SELECT * FROM resources ORDER BY name').all();

export const recentDeploys = (db, app, n = 10) =>
  db.prepare('SELECT * FROM deploys WHERE app=? ORDER BY id DESC LIMIT ?').all(app, n);

export const latestDeploy = (db, app) =>
  db.prepare('SELECT * FROM deploys WHERE app=? ORDER BY id DESC LIMIT 1').get(app);

// The SHA to roll back to: the previous distinct successful commit (index 0 = current).
export function rollbackTarget(db, app) {
  const rows = db.prepare(
    "SELECT sha FROM deploys WHERE app=? AND status='success' AND sha IS NOT NULL ORDER BY id DESC"
  ).all(app);
  const distinct = [];
  for (const r of rows) if (!distinct.includes(r.sha)) distinct.push(r.sha);
  return distinct[1] || null;
}

export const getApp = (db, name) =>
  db.prepare('SELECT * FROM apps WHERE name = ?').get(name);

export const listApps = (db) =>
  db.prepare('SELECT * FROM apps ORDER BY name').all();

export function upsertApp(db, a) {
  db.prepare(`
    INSERT INTO apps (name, type, domain, repo, serve, health_path, health_timeout, drain_seconds, release_cmd, persist, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      type=excluded.type, domain=excluded.domain, repo=excluded.repo, serve=excluded.serve,
      health_path=excluded.health_path, health_timeout=excluded.health_timeout,
      drain_seconds=excluded.drain_seconds,
      release_cmd=coalesce(excluded.release_cmd, apps.release_cmd),
      persist=coalesce(excluded.persist, apps.persist)
  `).run(
    a.name, a.type, a.domain ?? null, a.repo ?? null, a.serve,
    a.health_path ?? '/', a.health_timeout ?? 30, a.drain_seconds ?? 10,
    a.release_cmd ?? null, a.persist ?? null, a.created_at,
  );
}

// Update just the deploy-config fields (release command, persist paths, health path).
export function updateAppConfig(db, name, f) {
  const sets = [], vals = [];
  for (const k of ['release_cmd', 'persist', 'health_path']) {
    if (f[k] !== undefined) { sets.push(`${k}=?`); vals.push(f[k]); }
  }
  if (!sets.length) return;
  vals.push(name);
  db.prepare(`UPDATE apps SET ${sets.join(', ')} WHERE name=?`).run(...vals);
}

export const setPorts = (db, name, { live, pending, pid }) =>
  db.prepare('UPDATE apps SET live_port=?, pending_port=?, live_pid=? WHERE name=?')
    .run(live ?? null, pending ?? null, pid ?? null, name);

// Lowest free port at/above PORT_BASE, skipping both live and in-flight (pending) ports.
export function allocatePort(db) {
  const used = new Set();
  for (const r of db.prepare('SELECT live_port, pending_port FROM apps').all()) {
    if (r.live_port) used.add(r.live_port);
    if (r.pending_port) used.add(r.pending_port);
  }
  let p = PORT_BASE;
  while (used.has(p)) p++;
  return p;
}

export function removeApp(db, name) {
  db.prepare('DELETE FROM env WHERE app=?').run(name);
  db.prepare('DELETE FROM deploys WHERE app=?').run(name);
  db.prepare('DELETE FROM apps WHERE name=?').run(name);
}

export const removeResource = (db, name) =>
  db.prepare('DELETE FROM resources WHERE name=?').run(name);

export const setResourceAllow = (db, name, allow_ips) =>
  db.prepare('UPDATE resources SET allow_ips=? WHERE name=?').run(allow_ips ?? null, name);

export const getEnv = (db, app) => {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM env WHERE app=?').all(app)) {
    out[r.key] = r.value;
  }
  return out;
};

export const setEnv = (db, app, key, value) =>
  db.prepare('INSERT INTO env (app, key, value) VALUES (?, ?, ?) ' +
    'ON CONFLICT(app, key) DO UPDATE SET value=excluded.value').run(app, key, value);

export const startDeploy = (db, app, at) =>
  db.prepare('INSERT INTO deploys (app, status, started_at) VALUES (?, ?, ?)')
    .run(app, 'running', at).lastInsertRowid;

export const finishDeploy = (db, id, status, sha, message, at, reason = null, hint = null) =>
  db.prepare('UPDATE deploys SET status=?, sha=?, message=?, reason=?, hint=?, finished_at=? WHERE id=?')
    .run(status, sha ?? null, message ?? null, reason, hint, at, id);

export const addResource = (db, name, kind, conn, port, at) =>
  db.prepare('INSERT INTO resources (name, kind, conn, port, created_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(name) DO UPDATE SET conn=excluded.conn, port=excluded.port').run(name, kind, conn, port ?? null, at);

// Lowest free Postgres host port at/above 5433 (skips ones already in use by a resource).
export function allocatePgPort(db) {
  const used = new Set();
  for (const r of db.prepare('SELECT port FROM resources WHERE port IS NOT NULL').all()) used.add(r.port);
  let p = 5433;
  while (used.has(p)) p += 1;
  return p;
}

export const getResource = (db, name) =>
  db.prepare('SELECT * FROM resources WHERE name=?').get(name);
