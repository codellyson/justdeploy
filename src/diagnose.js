// Turn a raw deploy failure into a plain-English reason + fix hint. This is the knowledge
// that otherwise lives in the creator's head — encoded so a user never has to SSH in and
// read logs. `message` is the thrown error; `logTail` is the last chunk of the app log
// (crucial: a "health check failed" message says nothing, but the log tail shows the real
// crash — missing env, un-run migration, etc.).
//
// Each rule: a test against the combined text, a reason, and an actionable hint. First match
// wins, so order most-specific first.
const RULES = [
  {
    match: /could not read Username for '|Authentication failed|Permission denied \(publickey\)|fatal: repository .* not found/i,
    reason: 'Git clone failed — the repository is private or unreachable',
    hint: 'Add a deploy key / access token on the server, or make the repo public. JustDeploy has no git-credential flow yet.',
  },
  {
    match: /Missing environment variable "([^"]+)"/gi,
    reason: 'The app crashed on boot: required environment variables are missing',
    hint: (text) => {
      const vars = [...text.matchAll(/Missing environment variable "([^"]+)"/gi)].map((m) => m[1]);
      const uniq = [...new Set(vars)];
      return `Set ${uniq.map((v) => `\`${v}\``).join(', ')} — e.g. \`justdeploy env ${'<app>'} ${uniq.map((v) => v + '=...').join(' ')}\`, then redeploy.`;
    },
  },
  {
    match: /no such table: (\w+)/i,
    reason: 'Database tables are missing — migrations have not run',
    hint: 'Set a release command that runs migrations, e.g. `justdeploy set <app> --release "node ace migration:run --force"`. Apps like Better Auth need their own migration too.',
  },
  {
    match: /Cannot open database because the directory does not exist|SQLITE_CANTOPEN/i,
    reason: 'The app opened a SQLite file in a directory that does not exist',
    hint: 'Persist the data dir so it exists and survives deploys: `justdeploy set <app> --persist tmp` (adjust the dir to match your app).',
  },
  {
    match: /can only install with an existing package-lock\.json/i,
    reason: 'npm ci failed — no lockfile in the install directory',
    hint: 'Commit a package-lock.json, or the framework recipe needs to copy it into the build dir (this is a JustDeploy recipe bug if it is a built-in type).',
  },
  {
    match: /EADDRINUSE|address already in use/i,
    reason: 'The app tried to bind a port that is already in use',
    hint: 'Let JustDeploy assign the port — the app must read PORT from env and not hardcode a listen port.',
  },
  {
    match: /health check failed on port/i,
    // Reached only when the log tail matched no more-specific rule above.
    reason: 'The app started but never answered a healthy HTTP response',
    hint: 'It likely crashed on boot or its "/" returns a 5xx. Open Logs for the stack trace — common causes: missing env vars, a failed DB connection, or un-run migrations.',
  },
  {
    match: /cannot reach Caddy admin/i,
    reason: 'Caddy is not reachable — its admin API did not respond',
    hint: 'Check that Caddy is running: `systemctl status caddy`. JustDeploy drives it via localhost:2019.',
  },
  {
    match: /npm error|tsc|error TS\d+|Build failed|vite.*error/i,
    reason: 'The build step failed',
    hint: 'Open Logs for the build output. This is usually an app-side build error (dependencies, TypeScript, or the build script).',
  },
];

export function classify(message = '', logTail = '') {
  const text = `${message}\n${logTail}`;
  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return {
        reason: rule.reason,
        hint: typeof rule.hint === 'function' ? rule.hint(text) : rule.hint,
      };
    }
  }
  return { reason: 'Deploy failed', hint: 'Open Logs for details.' };
}
