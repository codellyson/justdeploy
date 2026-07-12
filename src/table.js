// The framework table — the ONE thing that varies between app types.
// Adding a framework later is appending a row here, not writing new logic.
//
//   serve:   'static' | 'proxy' | 'resource'
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
// Build install: force devDependencies IN. Build tooling (Vite, TypeScript, tailwind, Adonis's
// assembler/ts-node-maintained) lives in devDependencies, but a proxy type sets NODE_ENV=production
// in the build env, and npm omits dev deps under NODE_ENV=production — which breaks the build. So
// the build install always includes dev; the runtime prune (--omit=dev) happens separately below.
const NPM = npmInstall('--include=dev');
const NPM_PROD = npmInstall('--omit=dev');

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
  adonis: {
    serve: 'proxy',
    // `node ace build` copies package.json into build/ but NOT the lockfile; copy it in (if any)
    // so the build-dir install stays deterministic, then install production deps there.
    build: `${NPM} && node ace build && ([ -f package-lock.json ] && cp package-lock.json build/ || true) && cd build && ${NPM_PROD}`,
    cwd: 'build',
    run: ['node', 'bin/server.js'],
    // Adonis is DB-backed: run migrations after build, before the server starts. Idempotent,
    // so it's safe on every deploy. Part of the type preset — no per-app configuration needed.
    release: 'node ace migration:run --force',
  },
  // Container types: Railpack detects the package manager, language runtime, and build/start
  // commands itself and produces an OCI image — no hand-rolled build/run recipe. `nextjs` gets
  // its own entry only so the dashboard/CLI can show a Next.js icon and set the right auto-env;
  // `app` is the catch-all for anything Railpack can build (Node variants, Python, Go, …).
  nextjs: {
    serve: 'container',
  },
  app: {
    serve: 'container',
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
      // The Adonis web starter validates these at boot. Sensible, dependency-free defaults so the
      // app runs out of the box; the user's own env (a different session driver, etc.) overrides.
      return { HOST: '0.0.0.0', PORT: String(port), NODE_ENV: 'production', LOG_LEVEL: 'info', SESSION_DRIVER: 'cookie' };
    case 'nextjs':
      // Container: must bind 0.0.0.0 so the published port is reachable; PORT is what we publish.
      return { HOSTNAME: '0.0.0.0', PORT: String(port), NODE_ENV: 'production' };
    case 'app':
      // Generic container app — the near-universal convention is to listen on $PORT.
      return { PORT: String(port), NODE_ENV: 'production' };
    default:
      return {};
  }
}
