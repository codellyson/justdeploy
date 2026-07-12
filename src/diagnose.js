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
    match: /unresolved env reference (\$\{\{[^}]+\}\}|\S+)/i,
    reason: 'An env value references something that does not exist',
    hint: (text) => {
      const m = text.match(/unresolved env reference \S+ in \S+: (.+)/);
      return m ? m[1].replace(/\.$/, '') + '. Fix the `${{Source.KEY}}` reference in this app\'s env (`justdeploy ls` shows resource names), then redeploy.'
               : 'One of this app\'s env values has a `${{Source.KEY}}` reference that could not be resolved. Check the source name against `justdeploy ls`.';
    },
  },
  {
    match: /circular env reference at (\S+)/i,
    reason: 'Two env vars reference each other in a loop',
    hint: 'Break the cycle — an env value points back at itself through another variable. Give one of them a literal value.',
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
    // Container builds (Railpack) install with a frozen lockfile, like CI. pnpm and yarn both
    // refuse when the lockfile no longer matches package.json — typically a dep was added without
    // re-running install, so the committed lockfile is stale.
    match: /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile.*(?:not up to date|up to date)|pnpm-lock\.yaml is not up to date|YN0028|lockfile would have been (?:modified|created)|Your lockfile needs to be updated/i,
    reason: 'The committed lockfile is out of date — it does not match package.json, so the frozen install refused to run',
    hint: (text) => {
      const pm = /pnpm/i.test(text) ? 'pnpm install'
               : /yarn|YN\d|Your lockfile needs to be updated/i.test(text) ? 'yarn install'
               : 'npm install';
      return `A dependency was added or changed in package.json without refreshing the lockfile. In the app repo run \`${pm}\`, commit the updated lockfile alongside package.json, and redeploy. The container build installs with a frozen lockfile (like CI), so the lockfile must be committed in sync — don't switch to \`--no-frozen-lockfile\`, that just hides the drift.`;
    },
  },
  {
    match: /ERESOLVE|could not resolve dependency|conflicting peer dependency/i,
    reason: 'A dependency conflict survived even the --legacy-peer-deps retry',
    hint: (text) => {
      // Name the actual blocker: the package in the "Could not resolve dependency" block.
      const pkg = text.match(/Could not resolve dependency:[\s\S]*?peer [^\n]*?from ([\w.@/-]+)/i)?.[1];
      const who = pkg ? ` (\`${pkg}\`)` : '';
      return `JustDeploy already retried the install with \`--legacy-peer-deps\` automatically (like Vercel), and it still failed — so this is a genuine conflict npm can't paper over${who}. Fix it in the repo: bump or replace the package that caps your React/dependency version, or as a last resort commit an \`.npmrc\` with \`legacy-peer-deps=true\` **and** try \`--force\` locally to see the real breakage.`;
    },
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
