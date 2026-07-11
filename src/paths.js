// Filesystem conventions. Hardcoded on purpose — this is a single-user, single-box tool.
import { join } from 'node:path';

// Where the tool keeps its own state (SQLite index, nothing precious — rebuildable).
export const HOME = process.env.JUSTDEPLOY_HOME || '/var/lib/justdeploy';
export const STATE_DB = join(HOME, 'state.db');

// Where apps live. Each app gets /srv/<name>/{repo,data,logs}.
export const SRV = process.env.JUSTDEPLOY_SRV || '/srv';

export const repoDir = (name) => join(SRV, name, 'repo');   // git working area
export const dataDir = (name) => join(SRV, name, 'data');   // persists across deploys (SQLite dbs, uploads)
export const logFile = (name) => join(SRV, name, 'logs', 'app.log'); // legacy combined log (fallback)
// Split logs: the build/release output for the current deploy vs the running app's live output.
export const buildLog = (name) => join(SRV, name, 'logs', 'build.log');     // clone → build → migrations
export const runtimeLog = (name) => join(SRV, name, 'logs', 'runtime.log'); // the app's stdout/stderr

// Release-based deploys: each deploy builds into releases/<sha>; `current` symlinks the live
// one. Rollback re-points `current` to a kept release — no rebuild.
export const releasesDir = (name) => join(SRV, name, 'releases');
export const releaseDir = (name, sha) => join(SRV, name, 'releases', sha);
export const currentLink = (name) => join(SRV, name, 'current');

// Caddy admin API — driven live, no config file on disk, no SIGHUP.
export const CADDY_ADMIN = process.env.CADDY_ADMIN || 'http://localhost:2019';

// Shared Docker network so apps reach Postgres by container name, nothing published to host.
export const DOCKER_NET = 'deploy-net';

// Proxy apps get ports assigned from here upward.
export const PORT_BASE = 4000;
