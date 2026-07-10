// The deploy loop + zero-downtime port swap, on a release-based layout:
//   /srv/<name>/repo             git working area
//   /srv/<name>/releases/<sha>   a built copy of the app at that commit (has .jd-built marker)
//   /srv/<name>/current -> releases/<sha>   symlink to the live release
//   /srv/<name>/data             persists across releases (SQLite, uploads)
// Deploy builds a new release and re-points `current`. Rollback to a kept release just
// re-points `current` + restarts — no rebuild. See docs/port-swap.md for the swap sequence.
import { existsSync, mkdirSync, rmSync, symlinkSync, readFileSync, writeFileSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { row, autoEnv } from './table.js';
import { resolveEnv } from './envref.js';
import { repoDir, dataDir, SRV, logFile, releasesDir, releaseDir, currentLink } from './paths.js';
import * as db from './db.js';
import * as caddy from './caddy.js';
import * as proc from './proc.js';
import * as github from './github.js';
import { classify } from './diagnose.js';
import { run, capture } from './sh.js';

const now = () => new Date().toISOString();
const KEEP_RELEASES = 5; // besides the current one

// The env injected into build/release/run: the app's stored vars + the type's auto vars (PORT,
// etc.), with any `${{Source.KEY}}` references expanded against resources/other apps (see envref).
const appEnv = (database, name, type, port) =>
  resolveEnv(database, name, { ...db.getEnv(database, name), ...autoEnv(type, port) });

// --- release bookkeeping ---------------------------------------------------
function setCurrent(name, sha) {
  const cur = currentLink(name);
  rmSync(cur, { force: true }); // rm on a symlink removes the link, not the target
  symlinkSync(releaseDir(name, sha), cur);
}
export function currentRelease(name) {
  try { return basename(readlinkSync(currentLink(name))); } catch { return null; }
}
export function listReleases(name) {
  const dir = releasesDir(name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((sha) => existsSync(join(dir, sha, '.jd-built')));
}
function pruneReleases(name) {
  const dir = releasesDir(name);
  if (!existsSync(dir)) return;
  const cur = currentRelease(name);
  const rels = readdirSync(dir)
    .map((sha) => ({ sha, mtime: statSync(join(dir, sha)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  let kept = 0;
  for (const r of rels) {
    if (r.sha === cur) continue;                       // never delete the live release
    if (kept < KEEP_RELEASES) { kept += 1; continue; }
    rmSync(join(dir, r.sha), { recursive: true, force: true });
  }
}

// The dir an app runs from. With a sha → that release; otherwise the current release (falling
// back to repo/ for apps not yet migrated to the release layout).
function runDir(name, type, sha) {
  const r = row(type);
  const base = sha ? releaseDir(name, sha) : (existsSync(currentLink(name)) ? currentLink(name) : repoDir(name));
  return r.cwd && r.cwd !== '.' ? join(base, r.cwd) : base;
}

// --- git -------------------------------------------------------------------
// Fetch and resolve the commit to deploy (latest of origin/HEAD, or an explicit sha).
async function fetchSha(name, repo, targetSha, authEnv) {
  const dir = repoDir(name);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    await run(name, process.cwd(), `git clone ${repo} ${dir}`, authEnv);
  }
  await run(name, dir, 'git fetch --all --prune && git remote set-head origin --auto', authEnv);
  return targetSha || capture(dir, ['git', 'rev-parse', 'origin/HEAD']);
}

// --- build a release -------------------------------------------------------
// Materialize a pristine tree at `sha` into releases/<sha> and build it. Idempotent: if the
// release is already built (marker present), reuse it — this is what makes rollback instant.
async function buildRelease(database, name, type, sha) {
  const rel = releaseDir(name, sha);
  const marker = join(rel, '.jd-built');
  if (existsSync(marker)) return rel;
  rmSync(rel, { recursive: true, force: true });
  mkdirSync(rel, { recursive: true });
  // Clean export of the commit (no .git); deps install fresh inside the release.
  await run(name, repoDir(name), `git archive ${sha} | tar -x -C ${rel}`);

  const r = row(type);
  // Build with the app's env injected — some builds validate/need it (Adonis `node ace build`
  // boots the app; Vite/Next inline VITE_/NEXT_PUBLIC_ vars at build time).
  const app = db.getApp(database, name);
  const buildEnv = appEnv(database, name, type, app.live_port || 4000);
  if (r.build) await run(name, rel, r.build, buildEnv);
  if (r.postBuild === 'next-standalone-copy') {
    // Standalone mode does not copy static assets or public/ — the classic broken-CSS trap.
    await run(name, rel, 'cp -r .next/static .next/standalone/.next/static');
    await run(name, rel, 'cp -r public .next/standalone/public 2>/dev/null || true');
  }
  setupPersistence(name, type, sha, app.persist); // stable data dirs before the app runs
  writeFileSync(marker, sha);
  return rel;
}

// Redirect runtime data dirs (e.g. `tmp` holding a SQLite file) inside a release to the shared
// /srv/<name>/data area, so data persists across releases. `persist` is a comma-separated list.
function setupPersistence(name, type, sha, persist) {
  if (!persist) return;
  const base = runDir(name, type, sha);
  for (const p of persist.split(',').map((s) => s.trim()).filter(Boolean)) {
    const stable = join(dataDir(name), p);
    const link = join(base, p);
    mkdirSync(stable, { recursive: true });
    rmSync(link, { recursive: true, force: true });
    symlinkSync(stable, link);
  }
}

// Run the app's release command (e.g. `node ace migration:run`) inside the release, before the
// server starts, with the app's env injected.
async function runRelease(database, name, type, sha) {
  const app = db.getApp(database, name);
  if (!app.release_cmd) return;
  const env = appEnv(database, name, type, app.live_port || 4000);
  await run(name, runDir(name, type, sha), app.release_cmd, env);
}

// --- the loop -------------------------------------------------------------
// opts.sha (optional) pins the commit — used by rollback's rebuild fallback.
export async function deploy(database, name, opts = {}) {
  const app = db.getApp(database, name);
  if (!app) throw new Error(`no such app: ${name}`);
  if (!app.repo) throw new Error(`type ${app.type} is not deployable (no repository)`);
  const deployId = db.startDeploy(database, name, now());
  let sha = null;
  try {
    const authEnv = github.gitAuthEnv(db.getSetting(database, 'github_token'), app.repo);
    sha = await fetchSha(name, app.repo, opts.sha, authEnv);
    await buildRelease(database, name, app.type, sha);
    // Run the release command (e.g. migrations) on EVERY deploy — not just fresh builds. It's
    // idempotent, and a cached build must still migrate when env/db/release-cmd changed.
    await runRelease(database, name, app.type, sha);

    if (app.serve === 'static') {
      setCurrent(name, sha);
      await caddy.applyFromDb(database); // Caddy root is current/<artifact>
    } else if (app.serve === 'proxy') {
      await swap(database, app, sha);
      setCurrent(name, sha); // reflect the now-running release
    } else {
      throw new Error(`type ${app.type} is not deployable (it is a ${app.serve})`);
    }
    pruneReleases(name);
    db.finishDeploy(database, deployId, 'success', sha, null, now());
    return { sha };
  } catch (e) {
    const { reason, hint } = classify(e.message, tailLog(name));
    db.finishDeploy(database, deployId, 'failed', sha, e.message, now(), reason, hint);
    const err = new Error(e.message);
    err.reason = reason; err.hint = hint;
    throw err;
  }
}

// Roll back to a specific commit. If its release is still on disk → instant (re-point current
// + restart, no rebuild). If it was pruned → rebuild that commit.
export async function rollback(database, name, sha) {
  const app = db.getApp(database, name);
  if (!app) throw new Error(`no such app: ${name}`);
  if (!existsSync(join(releaseDir(name, sha), '.jd-built'))) return deploy(database, name, { sha });

  const deployId = db.startDeploy(database, name, now());
  try {
    if (app.serve === 'proxy') await swap(database, app, sha);
    setCurrent(name, sha);
    if (app.serve === 'static') await caddy.applyFromDb(database);
    db.finishDeploy(database, deployId, 'success', sha, 'instant rollback', now());
    return { sha, instant: true };
  } catch (e) {
    const { reason, hint } = classify(e.message, tailLog(name));
    db.finishDeploy(database, deployId, 'failed', sha, e.message, now(), reason, hint);
    const err = new Error(e.message);
    err.reason = reason; err.hint = hint;
    throw err;
  }
}

function tailLog(name, lines = 60) {
  try { return readFileSync(logFile(name), 'utf8').split('\n').slice(-lines).join('\n'); }
  catch { return ''; }
}

// Zero-downtime swap for proxy types, launching from release `sha`. Invariant: someone healthy
// always serves the domain.
async function swap(database, app, sha) {
  const r = row(app.type);
  const port = db.allocatePort(database);
  db.setPorts(database, app.name, { live: app.live_port, pending: port, pid: app.live_pid });

  const env = appEnv(database, app.name, app.type, port);
  const cwd = runDir(app.name, app.type, sha);
  const newPid = proc.start(app.name, { cwd, argv: r.run, env });

  const healthy = await proc.healthCheck(port, { path: app.health_path, timeout: app.health_timeout });
  if (!healthy) {
    await proc.drainAndKill(newPid, 0);
    db.setPorts(database, app.name, { live: app.live_port, pending: null, pid: app.live_pid });
    throw new Error(`health check failed on port ${port} — old version still serving`);
  }

  db.setPorts(database, app.name, { live: port, pending: null, pid: newPid });
  try {
    await caddy.applyFromDb(database);
  } catch (e) {
    db.setPorts(database, app.name, { live: app.live_port, pending: null, pid: app.live_pid });
    await proc.drainAndKill(newPid, 0);
    throw new Error(`caddy cutover failed, rolled back: ${e.message}`);
  }

  if (app.live_pid && app.live_pid !== newPid) {
    await proc.drainAndKill(app.live_pid, app.drain_seconds);
  }
}

// Tear an app down: stop its process, drop it from Caddy, forget it, delete its files.
export async function destroy(database, name, { keepData = false } = {}) {
  const app = db.getApp(database, name);
  if (!app) throw new Error(`no such app: ${name}`);

  if (app.serve === 'proxy' && app.live_pid) {
    await proc.drainAndKill(app.live_pid, 0);
  }
  db.removeApp(database, name);
  await caddy.applyFromDb(database);

  if (keepData) {
    for (const sub of ['repo', 'logs', 'releases', 'current']) {
      rmSync(join(SRV, name, sub), { recursive: true, force: true });
    }
  } else {
    rmSync(join(SRV, name), { recursive: true, force: true });
  }
}

// Relaunch a proxy app that died at runtime, on its existing live_port, from the current
// release — no rebuild. Used by the supervisor and by crash recovery after a reboot.
export async function restart(database, name) {
  const app = db.getApp(database, name);
  if (!app || app.serve !== 'proxy' || !app.live_port) return false;
  const r = row(app.type);
  const env = appEnv(database, name, app.type, app.live_port);
  const cwd = runDir(name, app.type); // current release (or repo/ pre-migration)
  const pid = proc.start(name, { cwd, argv: r.run, env });
  const healthy = await proc.healthCheck(app.live_port, { path: app.health_path, timeout: app.health_timeout });
  if (!healthy) { await proc.drainAndKill(pid, 0); return false; }
  db.setPorts(database, name, { live: app.live_port, pending: null, pid });
  return true;
}

// Ensure the app's data dir exists (SQLite path convention — survives redeploys).
export function ensureDataDir(name) {
  mkdirSync(dataDir(name), { recursive: true });
  return dataDir(name);
}
