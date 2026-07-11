// Container deploy primitives: Railpack builds an OCI image (via a BuildKit daemon), Docker runs
// it. Used by the engine's `container` serve model (Next.js and the catch-all `app` type). The
// built image IS the release artifact — rollback re-runs an old image tag with no rebuild.
//
// Railpack is BuildKit-native, so we keep a long-lived BuildKit daemon container and point
// railpack at it via BUILDKIT_HOST. Everything else is plain `docker`.
import { spawnSync } from 'node:child_process';
import { run } from './sh.js';

const BUILDKIT = 'jd-buildkit';
const BUILDKIT_HOST = `docker-container://${BUILDKIT}`;

export const imageTag = (app, sha) => `justdeploy/${app}:${sha.slice(0, 12)}`;
export const containerName = (app, sha) => `jd-${app}-${sha.slice(0, 12)}`;

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });

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
export async function build(logName, app, sha, srcDir) {
  ensureBuildkit();
  await run(logName, srcDir, `railpack build . --name ${imageTag(app, sha)}`, { BUILDKIT_HOST });
}

export const imageExists = (app, sha) => docker(['image', 'inspect', imageTag(app, sha)]).status === 0;

// Run the app's image detached on a localhost port. The app must listen on $PORT (passed in env);
// we publish 127.0.0.1:port:port so Caddy can reverse-proxy to it. `volumes` are `host:container`.
export function runContainer(app, sha, port, env, volumes = []) {
  const name = containerName(app, sha);
  docker(['rm', '-f', name]); // idempotent
  const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push('-p', `127.0.0.1:${port}:${port}`);
  for (const v of volumes) args.push('-v', v);
  args.push(imageTag(app, sha));
  const r = docker(args);
  if (r.status !== 0) throw new Error(`docker run failed: ${(r.stderr || '').trim()}`);
  return name;
}

export function stop(name) {
  if (name) docker(['rm', '-f', name]);
}

export const running = (name) => {
  if (!name) return false;
  const r = docker(['inspect', '-f', '{{.State.Running}}', name]);
  return r.status === 0 && r.stdout.trim() === 'true';
};

// Drop any container whose name is jd-<app>-* except `keep` — cleans up old releases.
export function pruneExcept(app, keep) {
  const r = docker(['ps', '-a', '--filter', `name=jd-${app}-`, '--format', '{{.Names}}']);
  if (r.status !== 0) return;
  for (const n of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (n !== keep) docker(['rm', '-f', n]);
  }
}
