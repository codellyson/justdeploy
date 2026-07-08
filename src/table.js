// The framework table — the ONE thing that varies between app types.
// Adding a framework later is appending a row here, not writing new logic.
//
//   serve:   'static' | 'proxy' | 'resource'
//   build:   shell string run in the repo dir (null = no build step)
//   artifact: for static, the folder to serve, relative to the repo
//   cwd:     for proxy, the dir to launch from, relative to the repo
//   run:     for proxy, argv to spawn (via node)
//   postBuild: named fixup run after build (see engine.js)

// Lockfile-aware installs: `npm ci` is fast + deterministic but REQUIRES a lockfile; many
// repos don't commit one, so fall back to `npm install` (which also generates a lockfile).
const NPM = 'if [ -f package-lock.json ]; then npm ci; else npm install; fi';
const NPM_PROD = 'if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi';

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
  },
  nextjs: {
    serve: 'proxy',
    build: `${NPM} && npm run build`,
    postBuild: 'next-standalone-copy',
    cwd: '.',
    run: ['node', '.next/standalone/server.js'],
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
