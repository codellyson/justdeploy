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
    CREATE TABLE IF NOT EXISTS projects (
      name       TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      username    TEXT PRIMARY KEY,
      pass_hash   TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'member',   -- 'admin' | 'member'
      app_quota   INTEGER,                          -- null = fall back to the default_app_quota setting
      must_change INTEGER NOT NULL DEFAULT 0,       -- force a password change on next login
      created_at  TEXT NOT NULL
    );
    -- Per-user GitHub connection (App or PAT). One row per user who connected GitHub.
    CREATE TABLE IF NOT EXISTS user_github (
      username               TEXT PRIMARY KEY,
      gh_app_id              TEXT,
      gh_app_slug            TEXT,
      gh_app_pem             TEXT,
      gh_app_client_id       TEXT,
      gh_app_client_secret   TEXT,
      gh_app_webhook_secret  TEXT,
      gh_app_installation_id TEXT,
      github_token           TEXT,
      github_login           TEXT,
      gh_app_state           TEXT
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
    'ALTER TABLE apps ADD COLUMN container TEXT',
    'ALTER TABLE apps ADD COLUMN artifact TEXT',
    'ALTER TABLE apps ADD COLUMN project TEXT',
    'ALTER TABLE resources ADD COLUMN project TEXT',
    'ALTER TABLE apps ADD COLUMN subdir TEXT',
    'ALTER TABLE apps ADD COLUMN owner TEXT',
    'ALTER TABLE resources ADD COLUMN owner TEXT',
    'ALTER TABLE projects ADD COLUMN owner TEXT',
    'ALTER TABLE apps ADD COLUMN grp TEXT', // optional sub-group within a project (canvas)
    'ALTER TABLE apps ADD COLUMN schedule TEXT', // cron type: OnCalendar expression
    'ALTER TABLE apps ADD COLUMN cmd TEXT',      // cron type: the command to run each fire
  ]) { try { db.exec(alter); } catch { /* column already exists */ } }
  // Every service belongs to a project; ungrouped ones (and older dbs) land in 'default'.
  db.prepare("INSERT INTO projects (name, created_at) VALUES ('default', ?) ON CONFLICT(name) DO NOTHING")
    .run(new Date().toISOString());
  db.exec("UPDATE apps SET project='default' WHERE project IS NULL OR project=''");
  db.exec("UPDATE resources SET project='default' WHERE project IS NULL OR project=''");
  // Multi-user bootstrap: single-admin dbs kept one `admin_hash` setting. Seed it as the first
  // admin user (username 'admin', same scrypt salt$hash format) so existing installs keep working.
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    const legacy = getSetting(db, 'admin_hash');
    if (legacy) {
      db.prepare("INSERT INTO users (username, pass_hash, role, created_at) VALUES ('admin', ?, 'admin', ?)")
        .run(legacy, new Date().toISOString());
    }
  }
  // Ownerless apps/projects/resources (pre-multi-user) belong to the first admin.
  const admin = db.prepare("SELECT username FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get()?.username;
  if (admin) {
    for (const t of ['apps', 'resources', 'projects']) {
      db.prepare(`UPDATE ${t} SET owner=? WHERE owner IS NULL OR owner=''`).run(admin);
    }
    // Per-user GitHub: move the old single global connection into the admin's row (once), so their
    // existing App/PAT keeps working and auto-deploys of admin-owned apps don't break.
    const hasRow = db.prepare('SELECT 1 FROM user_github WHERE username=?').get(admin);
    const legacyAppId = getSetting(db, 'gh_app_id');
    const legacyPat = getSetting(db, 'github_token');
    if (!hasRow && (legacyAppId || legacyPat)) {
      db.prepare(`INSERT INTO user_github
        (username, gh_app_id, gh_app_slug, gh_app_pem, gh_app_client_id, gh_app_client_secret, gh_app_webhook_secret, gh_app_installation_id, github_token, github_login)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        admin,
        legacyAppId || null, getSetting(db, 'gh_app_slug') || null, getSetting(db, 'gh_app_pem') || null,
        getSetting(db, 'gh_app_client_id') || null, getSetting(db, 'gh_app_client_secret') || null,
        getSetting(db, 'gh_app_webhook_secret') || null, getSetting(db, 'gh_app_installation_id') || null,
        legacyPat || null, getSetting(db, 'github_login') || null,
      );
      // Retire the globals so there's one source of truth.
      for (const k of ['gh_app_id', 'gh_app_slug', 'gh_app_pem', 'gh_app_client_id', 'gh_app_client_secret', 'gh_app_webhook_secret', 'gh_app_installation_id', 'github_token', 'github_login', 'gh_app_state']) {
        db.prepare('DELETE FROM settings WHERE key=?').run(k);
      }
    }
  }
  return db;
}

// --- projects --------------------------------------------------------------
export const listProjects = (db, owner = null) =>
  owner
    ? db.prepare('SELECT * FROM projects WHERE owner=? ORDER BY created_at').all(owner)
    : db.prepare('SELECT * FROM projects ORDER BY created_at').all();
export const getProject = (db, name) => db.prepare('SELECT * FROM projects WHERE name=?').get(name);
export const createProject = (db, name, at, owner = null) =>
  db.prepare('INSERT INTO projects (name, created_at, owner) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING').run(name, at, owner);
export function removeProject(db, name, fallback = 'default') {
  // Reassign the project's services to `fallback`, then drop it (never delete apps/dbs here).
  db.prepare('UPDATE apps SET project=? WHERE project=?').run(fallback, name);
  db.prepare('UPDATE resources SET project=? WHERE project=?').run(fallback, name);
  db.prepare("DELETE FROM projects WHERE name=? AND name!='default'").run(name);
}
export const setAppGroup = (db, name, grp) =>
  db.prepare('UPDATE apps SET grp=? WHERE name=?').run(grp || null, name);
export const setAppProject = (db, name, project) =>
  db.prepare('UPDATE apps SET project=? WHERE name=?').run(project, name);
export const setResourceProject = (db, name, project) =>
  db.prepare('UPDATE resources SET project=? WHERE name=?').run(project, name);
export const setResourceOwner = (db, name, owner) =>
  db.prepare('UPDATE resources SET owner=? WHERE name=?').run(owner, name);

// --- users -----------------------------------------------------------------
export const getUser = (db, username) =>
  db.prepare('SELECT * FROM users WHERE username=?').get(username);
export const listUsers = (db) =>
  db.prepare('SELECT username, role, app_quota, must_change, created_at FROM users ORDER BY created_at').all();
export const hasAdminUser = (db) =>
  db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get() != null;
export const createUser = (db, { username, pass_hash, role = 'member', app_quota = null, must_change = 0, created_at }) =>
  db.prepare('INSERT INTO users (username, pass_hash, role, app_quota, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, pass_hash, role, app_quota, must_change ? 1 : 0, created_at);
export const setUserPassword = (db, username, pass_hash, mustChange = 0) =>
  db.prepare('UPDATE users SET pass_hash=?, must_change=? WHERE username=?').run(pass_hash, mustChange ? 1 : 0, username);
export const setUserRole = (db, username, role) =>
  db.prepare('UPDATE users SET role=? WHERE username=?').run(role, username);
export const setUserQuota = (db, username, quota) =>
  db.prepare('UPDATE users SET app_quota=? WHERE username=?').run(quota ?? null, username);
export const deleteUser = (db, username) =>
  db.prepare('DELETE FROM users WHERE username=?').run(username);
export const countAppsByOwner = (db, owner) =>
  db.prepare('SELECT COUNT(*) AS n FROM apps WHERE owner=?').get(owner).n;
export const countOwnedByOwner = (db, owner) =>
  db.prepare('SELECT (SELECT COUNT(*) FROM apps WHERE owner=?) + (SELECT COUNT(*) FROM resources WHERE owner=?) AS n')
    .get(owner, owner).n;

// --- per-user GitHub connection --------------------------------------------
const GH_FIELDS = ['gh_app_id', 'gh_app_slug', 'gh_app_pem', 'gh_app_client_id', 'gh_app_client_secret', 'gh_app_webhook_secret', 'gh_app_installation_id', 'github_token', 'github_login', 'gh_app_state'];
export const getUserGithub = (db, username) =>
  (username && db.prepare('SELECT * FROM user_github WHERE username=?').get(username)) || {};
// Upsert only the provided fields (others untouched).
export function setUserGithub(db, username, fields) {
  const keys = Object.keys(fields).filter((k) => GH_FIELDS.includes(k));
  if (!keys.length) return;
  db.prepare('INSERT INTO user_github (username) VALUES (?) ON CONFLICT(username) DO NOTHING').run(username);
  db.prepare(`UPDATE user_github SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE username=?`)
    .run(...keys.map((k) => fields[k] ?? null), username);
}
export const clearUserGithub = (db, username) =>
  db.prepare('DELETE FROM user_github WHERE username=?').run(username);
export const findUserByGhState = (db, state) =>
  state && db.prepare('SELECT username FROM user_github WHERE gh_app_state=?').get(state)?.username;
export const findUserByGhAppId = (db, appId) =>
  appId && db.prepare('SELECT username FROM user_github WHERE gh_app_id=?').get(String(appId))?.username;
// All users' App webhook secrets — the webhook endpoint tries each to find whose push it is.
export const listGithubWebhookSecrets = (db) =>
  db.prepare("SELECT username, gh_app_webhook_secret AS secret FROM user_github WHERE gh_app_webhook_secret IS NOT NULL AND gh_app_webhook_secret != ''").all();

export const getSetting = (db, key) =>
  db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;

export const setSetting = (db, key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));

export const listResources = (db, owner = null) =>
  owner
    ? db.prepare('SELECT * FROM resources WHERE owner=? ORDER BY name').all(owner)
    : db.prepare('SELECT * FROM resources ORDER BY name').all();

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

// `owner` filters to one user's apps; omit (or pass null) for all — admins pass null.
export const listApps = (db, owner = null) =>
  owner
    ? db.prepare('SELECT * FROM apps WHERE owner=? ORDER BY name').all(owner)
    : db.prepare('SELECT * FROM apps ORDER BY name').all();

export function upsertApp(db, a) {
  db.prepare(`
    INSERT INTO apps (name, type, domain, repo, serve, health_path, health_timeout, drain_seconds, release_cmd, persist, artifact, subdir, project, owner, schedule, cmd, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      type=excluded.type, domain=excluded.domain, repo=excluded.repo, serve=excluded.serve,
      health_path=excluded.health_path, health_timeout=excluded.health_timeout,
      drain_seconds=excluded.drain_seconds,
      release_cmd=coalesce(excluded.release_cmd, apps.release_cmd),
      persist=coalesce(excluded.persist, apps.persist),
      artifact=coalesce(excluded.artifact, apps.artifact),
      subdir=coalesce(excluded.subdir, apps.subdir),
      project=coalesce(excluded.project, apps.project),
      owner=coalesce(excluded.owner, apps.owner),
      schedule=coalesce(excluded.schedule, apps.schedule),
      cmd=coalesce(excluded.cmd, apps.cmd)
  `).run(
    a.name, a.type, a.domain ?? null, a.repo ?? null, a.serve,
    a.health_path ?? '/', a.health_timeout ?? 30, a.drain_seconds ?? 10,
    a.release_cmd ?? null, a.persist ?? null, a.artifact ?? null, a.subdir ?? null, a.project ?? 'default', a.owner ?? null,
    a.schedule ?? null, a.cmd ?? null, a.created_at,
  );
}

// Update just the deploy-config fields (release command, persist paths, health path).
export function updateAppConfig(db, name, f) {
  const sets = [], vals = [];
  for (const k of ['release_cmd', 'persist', 'health_path', 'subdir', 'schedule', 'cmd']) {
    if (f[k] !== undefined) { sets.push(`${k}=?`); vals.push(f[k]); }
  }
  if (!sets.length) return;
  vals.push(name);
  db.prepare(`UPDATE apps SET ${sets.join(', ')} WHERE name=?`).run(...vals);
}

// Convert an existing app to another framework type (and its serve model) in place, keeping its
// env, project, owner, and deploy history — the alternative is rm + add, which drops all of it.
export const setAppType = (db, name, type, serve) =>
  db.prepare('UPDATE apps SET type=?, serve=? WHERE name=?').run(type, serve, name);

export const setPorts = (db, name, { live, pending, pid }) =>
  db.prepare('UPDATE apps SET live_port=?, pending_port=?, live_pid=? WHERE name=?')
    .run(live ?? null, pending ?? null, pid ?? null, name);

// The running container name for container-served apps (parallel to live_pid for host apps).
export const setContainer = (db, name, container) =>
  db.prepare('UPDATE apps SET container=? WHERE name=?').run(container ?? null, name);

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

export const addResource = (db, name, kind, conn, port, at, project = 'default', owner = null) =>
  db.prepare('INSERT INTO resources (name, kind, conn, port, project, owner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(name) DO UPDATE SET conn=excluded.conn, port=excluded.port').run(name, kind, conn, port ?? null, project, owner, at);

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
