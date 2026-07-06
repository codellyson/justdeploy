// The deploy loop + the one stateful operation (zero-downtime port swap).
// See docs/port-swap.md for the sequence and its failure matrix.
import { existsSync, mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { row, autoEnv } from './table.js';
import { repoDir, dataDir, SRV, logFile } from './paths.js';
import * as db from './db.js';
import * as caddy from './caddy.js';
import * as proc from './proc.js';
import { classify } from './diagnose.js';
import { run, capture } from './sh.js';

const now = () => new Date().toISOString();

// --- git ------------------------------------------------------------------
// Always check out an explicit commit. Normal deploy → latest of the remote default branch
// (origin/HEAD). Rollback → a specific past SHA. Uniform path, and it works from a detached
// HEAD (which a prior rollback leaves behind) — no reliance on branch upstream (@{u}).
async function sync(name, repo, targetSha) {
  const dir = repoDir(name);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    await run(name, process.cwd(), `git clone ${repo} ${dir}`);
  }
  await run(name, dir, 'git fetch --all --prune && git remote set-head origin --auto');
  const sha = targetSha || capture(dir, ['git', 'rev-parse', 'origin/HEAD']);
  await run(name, dir, `git checkout --force ${sha}`);
  return capture(dir, ['git', 'rev-parse', 'HEAD']);
}

// --- build ----------------------------------------------------------------
async function build(name, type) {
  const r = row(type);
  const dir = repoDir(name);
  if (r.build) await run(name, dir, r.build);
  if (r.postBuild === 'next-standalone-copy') {
    // Standalone mode does not copy static assets or public/ — the classic broken-CSS trap.
    await run(name, dir, 'cp -r .next/static .next/standalone/.next/static');
    await run(name, dir, 'cp -r public .next/standalone/public 2>/dev/null || true');
  }
}

// The dir an app builds/runs from: for adonis that's build/, otherwise the repo root.
function runDir(name, type) {
  const r = row(type);
  return r.cwd && r.cwd !== '.' ? join(repoDir(name), r.cwd) : repoDir(name);
}

// Redirect runtime data dirs (e.g. `tmp` holding a SQLite file) to the persistent
// /srv/<name>/data area, so they survive the build dir being replaced each deploy.
// `persist` is a comma-separated list of paths relative to the run dir.
function setupPersistence(name, type, persist) {
  if (!persist) return;
  const base = runDir(name, type);
  for (const p of persist.split(',').map((s) => s.trim()).filter(Boolean)) {
    const stable = join(dataDir(name), p);   // /srv/<name>/data/<p>  (survives)
    const link = join(base, p);              // <rundir>/<p>          (replaced each deploy)
    mkdirSync(stable, { recursive: true });
    rmSync(link, { recursive: true, force: true });
    symlinkSync(stable, link);
  }
}

// Run the app's release command (e.g. `node ace migration:run`) after build, before the
// server starts, with the app's env injected.
async function runRelease(database, name, type) {
  const app = db.getApp(database, name);
  if (!app.release_cmd) return;
  const env = { ...db.getEnv(database, name), ...autoEnv(type, app.live_port || 4000) };
  await run(name, runDir(name, type), app.release_cmd, env);
}

// --- the loop -------------------------------------------------------------
// opts.sha (optional) pins the commit to deploy — used by rollback.
export async function deploy(database, name, opts = {}) {
  const app = db.getApp(database, name);
  if (!app) throw new Error(`no such app: ${name}`);
  const deployId = db.startDeploy(database, name, now());
  let sha = null;
  try {
    if (app.repo) sha = await sync(name, app.repo, opts.sha);
    await build(name, app.type);
    setupPersistence(name, app.type, app.persist); // stable data dirs before migrations
    await runRelease(database, name, app.type);    // migrations etc.

    if (app.serve === 'static') {
      // Nothing to swap — repoint Caddy at the (possibly rebuilt) folder.
      await caddy.applyFromDb(database);
    } else if (app.serve === 'proxy') {
      await swap(database, app);
    } else {
      throw new Error(`type ${app.type} is not deployable (it is a ${app.serve})`);
    }

    db.finishDeploy(database, deployId, 'success', sha, null, now());
    return { sha };
  } catch (e) {
    // Diagnose: the thrown message plus the log tail (where the real crash shows up).
    const { reason, hint } = classify(e.message, tailLog(name));
    db.finishDeploy(database, deployId, 'failed', sha, e.message, now(), reason, hint);
    const err = new Error(e.message);
    err.reason = reason; err.hint = hint;
    throw err;
  }
}

function tailLog(name, lines = 60) {
  try {
    return readFileSync(logFile(name), 'utf8').split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

// Zero-downtime swap for proxy types. Invariant: someone healthy always serves the domain.
async function swap(database, app) {
  const r = row(app.type);
  const port = db.allocatePort(database);
  db.setPorts(database, app.name, { live: app.live_port, pending: port, pid: app.live_pid });

  // Assemble launch env: inherited persisted env + the type's auto vars + PORT.
  const env = { ...db.getEnv(database, app.name), ...autoEnv(app.type, port) };
  const cwd = r.cwd === '.' ? repoDir(app.name) : join(repoDir(app.name), r.cwd);

  const newPid = proc.start(app.name, { cwd, argv: r.run, env });

  const healthy = await proc.healthCheck(port, {
    path: app.health_path,
    timeout: app.health_timeout,
  });
  if (!healthy) {
    await proc.drainAndKill(newPid, 0); // no drain — nothing is serving from it
    db.setPorts(database, app.name, { live: app.live_port, pending: null, pid: app.live_pid });
    throw new Error(`health check failed on port ${port} — old version still serving`);
  }

  // Cutover: point Caddy at the new port, then commit new state.
  db.setPorts(database, app.name, { live: port, pending: null, pid: newPid });
  try {
    await caddy.applyFromDb(database);
  } catch (e) {
    // Caddy refused the swap — roll back state and kill the new process. Old still serves.
    db.setPorts(database, app.name, { live: app.live_port, pending: null, pid: app.live_pid });
    await proc.drainAndKill(newPid, 0);
    throw new Error(`caddy cutover failed, rolled back: ${e.message}`);
  }

  // Drain and retire the old process (no-op on first deploy).
  if (app.live_pid && app.live_pid !== newPid) {
    await proc.drainAndKill(app.live_pid, app.drain_seconds);
  }
}

// Tear an app down: stop its process, drop it from Caddy, forget it, delete its files.
// keepData preserves /srv/<name>/data (the persistent SQLite/uploads dir).
export async function destroy(database, name, { keepData = false } = {}) {
  const app = db.getApp(database, name);
  if (!app) throw new Error(`no such app: ${name}`);

  if (app.serve === 'proxy' && app.live_pid) {
    await proc.drainAndKill(app.live_pid, 0); // no traffic to drain — we're removing it
  }
  db.removeApp(database, name);
  await caddy.applyFromDb(database); // repoint Caddy without this app

  if (keepData) {
    for (const sub of ['repo', 'logs']) {
      rmSync(join(SRV, name, sub), { recursive: true, force: true });
    }
  } else {
    rmSync(join(SRV, name), { recursive: true, force: true });
  }
}

// Relaunch a proxy app that died at runtime, on its existing live_port. No rebuild, no
// Caddy change (Caddy already points at that port), no release step (migrations already
// ran) — just start the process again and health-check it. Used by the supervisor and by
// crash recovery after a reboot. Returns true if it's back up.
export async function restart(database, name) {
  const app = db.getApp(database, name);
  if (!app || app.serve !== 'proxy' || !app.live_port) return false;
  const r = row(app.type);
  const env = { ...db.getEnv(database, name), ...autoEnv(app.type, app.live_port) };
  const cwd = r.cwd === '.' ? repoDir(name) : join(repoDir(name), r.cwd);
  const pid = proc.start(name, { cwd, argv: r.run, env });
  const healthy = await proc.healthCheck(app.live_port, {
    path: app.health_path, timeout: app.health_timeout,
  });
  if (!healthy) { await proc.drainAndKill(pid, 0); return false; }
  db.setPorts(database, name, { live: app.live_port, pending: null, pid });
  return true;
}

// Ensure the app's data dir exists (SQLite path convention — survives redeploys).
export function ensureDataDir(name) {
  mkdirSync(dataDir(name), { recursive: true });
  return dataDir(name);
}
