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
const NPM = npmInstall();
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
  nextjs: {
    serve: 'proxy',
    build: `${NPM} && npm run build`,
    postBuild: 'next-standalone-copy',
    cwd: '.',
    // Prefer the standalone bundle when the app opted into `output: 'standalone'` (smaller, no
    // node_modules needed); otherwise fall back to `next start`, which works for any Next.js app
    // as-is (node_modules is present in the release). So a user never has to edit next.config.
    // `exec` replaces this sh so the tracked pid stays the Node process. PORT comes from autoEnv.
    run: ['sh', '-c', 'if [ -f .next/standalone/server.js ]; then exec node .next/standalone/server.js; else exec node_modules/.bin/next start -H 0.0.0.0 -p "$PORT"; fi'],
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
      return { HOSTNAME: '0.0.0.0', PORT: String(port), NODE_ENV: 'production' };
    default:
      return {};
  }
}
