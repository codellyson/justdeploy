// The framework table — the ONE thing that varies between app types.
// Adding a framework later is appending a row here, not writing new logic.
//
//   serve:   'static' | 'proxy' | 'resource' | 'file'
//   build:   shell string run in the repo dir (null = no build step)
//   artifact: for static, the folder to serve, relative to the repo
//   cwd:     for proxy, the dir to launch from, relative to the repo
//   run:     for proxy, argv to spawn (via node)
//   postBuild: named fixup run after build (see engine.js)

export const TABLE = {
  react: {
    serve: 'static',
    build: 'npm ci && npm run build',
    artifact: 'build',
  },
  vite: {
    serve: 'static',
    build: 'npm ci && npm run build',
    artifact: 'dist',
  },
  static: {
    serve: 'static',
    build: null,
    artifact: '.',
  },
  adonis: {
    serve: 'proxy',
    // `node ace build` copies package.json into build/ but NOT package-lock.json, so a bare
    // `npm ci` in build/ fails ("no lockfile"). Copy the lockfile in first to keep a
    // deterministic install.
    build: 'npm ci && node ace build && cp package-lock.json build/ && cd build && npm ci --omit=dev',
    cwd: 'build',
    run: ['node', 'bin/server.js'],
  },
  nextjs: {
    serve: 'proxy',
    build: 'npm ci && npm run build',
    postBuild: 'next-standalone-copy',
    cwd: '.',
    run: ['node', '.next/standalone/server.js'],
  },
  postgres: {
    serve: 'resource',
  },
  sqlite: {
    serve: 'file',
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
