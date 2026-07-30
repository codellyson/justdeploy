// The framework table — the ONE thing that varies between app types.
// Adding a framework later is appending a row here, not writing new logic.
//
//   serve:   'static' | 'proxy' | 'container' | 'worker' | 'resource'
//   build:   shell string run in the repo dir (null = no build step)
//   artifact: for static, the folder to serve, relative to the repo
//   cwd:     for proxy, the dir to launch from, relative to the repo
//   run:     for proxy, argv to spawn (via node)
//   postBuild: named fixup run after build (see engine.js)

// Lockfile-aware installs with a Vercel/Cloudflare-style ERESOLVE fallback.
//
// `npm ci` is fast + deterministic but REQUIRES a lockfile; many repos don't commit one, so we
// fall back to `npm install` (which also generates one). On top of that: npm 7+ hard-fails on
// peer-dependency conflicts (ERESOLVE) — common with React 19 + libraries that still cap at
// React 18. Vercel and Cloudflare Pages transparently retry such installs with
// `--legacy-peer-deps`; we do the same, so a user never has to add an `.npmrc`. Only the FIRST
// attempt's output is captured (to a temp file) to detect ERESOLVE; the retry streams live.
// POSIX sh (run() uses /bin/sh), so no bashisms — the base exit code is stashed in a marker file
// because dash has no PIPESTATUS.
function npmInstall(flags = '') {
  const f = flags ? ` ${flags}` : '';
  const base = `if [ -f package-lock.json ]; then npm ci${f}; else npm install${f}; fi`;
  const legacy = `if [ -f package-lock.json ]; then npm ci${f} --legacy-peer-deps; else npm install${f} --legacy-peer-deps; fi`;
  return `{ ${base}; echo $? >.jd-npm.ec; } 2>&1 | tee .jd-npm.log; ` +
    `ec=$(cat .jd-npm.ec 2>/dev/null || echo 1); ` +
    `if [ "$ec" -ne 0 ] && grep -q ERESOLVE .jd-npm.log; then ` +
      `echo "[justdeploy] peer-dependency conflict — retrying install with --legacy-peer-deps (same as Vercel/Cloudflare)"; ` +
      `rm -f .jd-npm.log .jd-npm.ec; ${legacy}; ` +
    `else rm -f .jd-npm.log .jd-npm.ec; [ "$ec" -eq 0 ] || exit "$ec"; fi`;
}
// Build install (host static types): force devDependencies IN. Build tooling (Vite, TypeScript,
// tailwind) lives in devDependencies, but the build env may set NODE_ENV=production and npm omits
// dev deps under NODE_ENV=production — which breaks the build. Container types use Railpack, which
// handles this itself (NPM_CONFIG_PRODUCTION=false), so this only applies to the host build path.
const NPM = npmInstall('--include=dev');

export const TABLE = {
  react: {
    serve: 'static',
    build: `${NPM} && npm run build`,
    artifact: 'build',
  },
  vite: {
    serve: 'static',
    build: `${NPM} && npm run build`,
    artifact: 'dist',
  },
  static: {
    serve: 'static',
    build: null,
    artifact: '.',
  },
  // Container types: Railpack detects the package manager, language runtime, and build/start
  // commands itself and produces an OCI image — no hand-rolled build/run recipe. `nextjs` gets
  // its own entry only so the dashboard/CLI can show a Next.js icon and set the right auto-env;
  // `app` is the catch-all for anything Railpack can build (Node variants, Python, Go, …).
  adonis: {
    serve: 'container',
    // Railpack builds Adonis (`node ace build`) but its generic start runs the *source* entry;
    // the built server lives in build/, so override the start. Migrations (release) are baked in
    // front of the start command by the engine and reach Postgres over the shared container network.
    railpackStart: 'node build/bin/server.js',
    release: 'node ace migration:run --force',
  },
  nextjs: {
    serve: 'container',
  },
  app: {
    serve: 'container',
  },
  // Anything that runs but never serves HTTP: bots, queue consumers, schedulers, scrapers.
  // Built by Railpack exactly like `app`, but with no port published, no domain, no Caddy route
  // and no HTTP health check — a worker is healthy when it stays up (see engine's settle window).
  worker: {
    serve: 'worker',
  },
  // A batch job: same Railpack image, but run on a schedule instead of kept alive. Nothing stays
  // running between fires, so there is nothing to health-check or keep up — see cron.js.
  cron: {
    serve: 'cron',
  },
  postgres: {
    serve: 'resource',
  },
};

export const TYPES = Object.keys(TABLE);

export function row(type) {
  const r = TABLE[type];
  if (!r) throw new Error(`unknown type "${type}" — one of: ${TYPES.join(', ')}`);
  return r;
}

// Env vars each type sets for the user so the documented traps never happen.
// PORT is filled in per-deploy; APP_KEY is generated once at `add` and persisted.
export function autoEnv(type, port) {
  switch (type) {
    case 'adonis':
      return { HOST: '0.0.0.0', PORT: String(port), NODE_ENV: 'production' };
    case 'nextjs':
      // Container: must bind 0.0.0.0 so the published port is reachable; PORT is what we publish.
      return { HOSTNAME: '0.0.0.0', PORT: String(port), NODE_ENV: 'production' };
    case 'app':
      // Generic container app — the near-universal convention is to listen on $PORT.
      return { PORT: String(port), NODE_ENV: 'production' };
    case 'worker':
    case 'cron':
      // Deliberately no PORT: nothing is published, so a port would only tempt the app to bind
      // one that no one can reach.
      return { NODE_ENV: 'production' };
    default:
      return {};
  }
}
