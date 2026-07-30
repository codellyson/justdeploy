// Container deploy primitives: Railpack builds an OCI image (via a BuildKit daemon), Docker runs
// it. Used by the engine's `container` serve model (Next.js and the catch-all `app` type). The
// built image IS the release artifact — rollback re-runs an old image tag with no rebuild.
//
// Railpack is BuildKit-native, so we keep a long-lived BuildKit daemon container and point
// railpack at it via BUILDKIT_HOST. Everything else is plain `docker`.
import { spawnSync } from 'node:child_process';
import { run } from './sh.js';
import { buildLog } from './paths.js';

const BUILDKIT = 'jd-buildkit';
const BUILDKIT_HOST = `docker-container://${BUILDKIT}`;
// Shared bridge network so app containers reach provisioned Postgres by container name (a
// container's own 127.0.0.1 is NOT the host's — the localhost-published DB port is unreachable
// from inside a container).
export const NET = 'jd-net';

export const imageTag = (app, sha) => `justdeploy/${app}:${sha.slice(0, 12)}`;
export const containerName = (app, sha) => `jd-${app}-${sha.slice(0, 12)}`;

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });

// Ensure the shared network exists, and (idempotently) attach a container to it.
export function ensureNetwork() {
  if (docker(['network', 'inspect', NET]).status !== 0) docker(['network', 'create', NET]);
}
export function connectToNetwork(name) {
  ensureNetwork();
  docker(['network', 'connect', NET, name]); // no-op error if already attached
}

export function have(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
}

// Ensure the BuildKit daemon (a privileged container) is up — Railpack needs it to build.
export function ensureBuildkit() {
  const st = docker(['inspect', '-f', '{{.State.Running}}', BUILDKIT]);
  if (st.status === 0 && st.stdout.trim() === 'true') return;
  docker(['rm', '-f', BUILDKIT]); // clear a stopped/broken one
  const r = docker(['run', '-d', '--name', BUILDKIT, '--restart', 'unless-stopped', '--privileged', 'moby/buildkit:latest']);
  if (r.status !== 0) throw new Error(`could not start BuildKit daemon: ${(r.stderr || '').trim()}`);
}

// Build `srcDir` into the app's image with Railpack. Streams build output to the app log.
export async function build(logName, app, sha, srcDir, startCmd) {
  ensureBuildkit();
  const start = startCmd ? ` --start-cmd ${JSON.stringify(startCmd)}` : ''; // e.g. Adonis → node build/bin/server.js
  await run(logName, srcDir, `railpack build . --name ${imageTag(app, sha)}${start}`, { BUILDKIT_HOST }, buildLog(logName));
}

export const imageExists = (app, sha) => docker(['image', 'inspect', imageTag(app, sha)]).status === 0;

// Run the app's image detached on a localhost port. The app must listen on $PORT (passed in env);
// we publish 127.0.0.1:port:port so Caddy can reverse-proxy to it. `volumes` are `host:container`.
// A null `port` publishes nothing — that's a worker, which serves no traffic.
export function runContainer(app, sha, port, env, volumes = [], restart = 'unless-stopped') {
  ensureNetwork();
  const name = containerName(app, sha);
  docker(['rm', '-f', name]); // idempotent
  const args = ['run', '-d', '--name', name, '--restart', restart, '--network', NET];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  if (port) args.push('-p', `127.0.0.1:${port}:${port}`);
  for (const v of volumes) args.push('-v', v);
  args.push(imageTag(app, sha));
  const r = docker(args);
  if (r.status !== 0) throw new Error(`docker run failed: ${(r.stderr || '').trim()}`);
  return name;
}

// Run a one-shot command in the app's image and wait for it — the release phase (migrations)
// for types whose start command Railpack detects for us, so there is nothing to bake it in front
// of. `--entrypoint sh` because appending args to an image's own ENTRYPOINT would mangle them.
export function runOnce(app, sha, env, volumes, cmd) {
  ensureNetwork();
  const args = ['run', '--rm', '--entrypoint', 'sh', '--network', NET];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  for (const v of volumes) args.push('-v', v);
  args.push(imageTag(app, sha), '-c', cmd);
  const r = docker(args);
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

export const setRestart = (name, policy) => docker(['update', '--restart', policy, name]);

export function stop(name) {
  if (name) docker(['rm', '-f', name]);
}

export const running = (name) => {
  if (!name) return false;
  const r = docker(['inspect', '-f', '{{.State.Running}}', name]);
  return r.status === 0 && r.stdout.trim() === 'true';
};

// Liveness detail for containers with no port to probe (workers). `restarts` is the key signal:
// `--restart unless-stopped` makes a container that crashes on boot look "running" forever, so a
// nonzero restart count is how you tell a healthy worker from a crash loop.
export function state(name) {
  const r = docker(['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}}', name]);
  if (r.status !== 0) return { status: 'missing', exitCode: null, restarts: 0, running: false };
  const [status, code, restarts] = r.stdout.trim().split(/\s+/);
  return { status, exitCode: Number(code), restarts: Number(restarts), running: status === 'running' };
}

// A container's recent output. Used to salvage the crash before a failed deploy removes it —
// otherwise `docker rm -f` takes the only evidence of why it died with it.
export function logs(name, tail = 200) {
  const r = docker(['logs', '--tail', String(tail), name]);
  return r.status === 0 ? `${r.stdout || ''}${r.stderr || ''}` : '';
}

// Drop any container whose name is jd-<app>-* except `keep` — cleans up old releases.
export function pruneExcept(app, keep) {
  const r = docker(['ps', '-a', '--filter', `name=jd-${app}-`, '--format', '{{.Names}}']);
  if (r.status !== 0) return;
  for (const n of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (n !== keep) docker(['rm', '-f', n]);
  }
}

// --- garbage collection ---------------------------------------------------
// Each build leaves an ~1 GB image; keep the newest `keepCount` per app (so instant rollback to
// a recent release still works) plus the current SHA, and delete the rest. Also clears dangling
// layers left behind by rebuilds. `docker images` lists newest-first.
export function pruneImages(app, keepSha, keepCount = 3) {
  const r = docker(['images', `justdeploy/${app}`, '--format', '{{.Tag}}']);
  if (r.status === 0) {
    const tags = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const keep = new Set(tags.slice(0, keepCount));
    if (keepSha) keep.add(keepSha.slice(0, 12));
    for (const t of tags) if (!keep.has(t)) docker(['rmi', '-f', `justdeploy/${app}:${t}`]);
  }
  docker(['image', 'prune', '-f']);
}

// Cap the BuildKit build cache so it can't grow without bound (keeps recent layers for fast
// rebuilds). Best-effort — a missing/older buildctl just no-ops.
export function pruneBuildCache(keepMB = 3000) {
  docker(['exec', BUILDKIT, 'buildctl', 'prune', `--keep-storage=${keepMB}`]);
}

// Everything above, for one app after a deploy: trim its images + cap the shared cache.
export function gcAfterDeploy(app, currentSha) {
  pruneImages(app, currentSha);
  pruneBuildCache();
}
