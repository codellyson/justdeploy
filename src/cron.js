// Scheduled jobs: a Railpack-built image run on a systemd timer instead of kept alive.
//
// The unit pair is rewritten on every deploy because it names the release's image tag directly —
// no floating "latest" tag to drift, and a rollback rewrites it back to the old sha. systemd owns
// the schedule, catch-up after downtime (Persistent=true), overlap protection (a oneshot service
// will not start again while the previous run is still going), and the logs (journald).
import { spawnSync, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { NET } from './container.js';
import { cronEnvFile } from './paths.js';

const UNITS = '/etc/systemd/system';
export const unitName = (app) => `justdeploy-cron-${app}`;
const servicePath = (app) => `${UNITS}/${unitName(app)}.service`;
const timerPath = (app) => `${UNITS}/${unitName(app)}.timer`;

// Friendly names map to systemd's own shorthands; anything else is passed through as a raw
// OnCalendar expression so the full syntax stays available.
const SHORTHAND = { hourly: 'hourly', daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' };
export const normalizeSchedule = (s) => SHORTHAND[String(s || '').trim().toLowerCase()] || String(s || '').trim();

// Reject a bad expression at `add` time rather than letting systemd fail silently at 3am.
export function validateSchedule(schedule) {
  const cal = normalizeSchedule(schedule);
  if (!cal) throw new Error('a schedule is required — e.g. "daily", "hourly", or an OnCalendar expression like "*-*-* 03:00:00"');
  const r = spawnSync('systemd-analyze', ['calendar', cal], { encoding: 'utf8' });
  // No systemd-analyze (a container, a dev box) — accept it rather than block the deploy.
  if (r.status !== 0 && r.stdout !== undefined && /Failed to parse|Normalized form/.test(`${r.stdout}${r.stderr}`)) {
    throw new Error(`invalid schedule "${schedule}": ${(r.stderr || '').trim() || 'not a valid OnCalendar expression'}`);
  }
  return cal;
}

// The next time this job will fire, for display. Best-effort.
export function nextRun(app) {
  const r = spawnSync('systemctl', ['show', `${unitName(app)}.timer`, '-p', 'NextElapseUSecRealtime', '--value'], { encoding: 'utf8' });
  const v = (r.stdout || '').trim();
  return r.status === 0 && v && v !== '0' ? v : null;
}

export function status(app) {
  const active = spawnSync('systemctl', ['is-active', `${unitName(app)}.timer`], { encoding: 'utf8' });
  const show = spawnSync('systemctl', ['show', `${unitName(app)}.service`, '-p', 'ExecMainStatus', '-p', 'ExecMainStartTimestamp'], { encoding: 'utf8' });
  const props = Object.fromEntries((show.stdout || '').trim().split('\n').map((l) => {
    const i = l.indexOf('=');
    return i === -1 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)];
  }));
  // A unit that has never started still reports ExecMainStatus=0, which would read as "last run
  // ok". The start timestamp is the only thing that distinguishes never-run from succeeded.
  const ran = Boolean(props.ExecMainStartTimestamp);
  const code = Number(props.ExecMainStatus);
  return {
    scheduled: (active.stdout || '').trim() === 'active',
    lastExit: ran && Number.isFinite(code) ? code : null,
    lastRunAt: props.ExecMainStartTimestamp || null,
    next: nextRun(app),
  };
}

const dockerBin = () => {
  const r = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' });
  return (r.stdout || '').trim() || '/usr/bin/docker';
};

// systemd reads `%` as a specifier and splits on unescaped quotes, so anything user-authored that
// lands in ExecStart has to be neutralised first.
const escapeExec = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');

function writeEnvFile(app, env) {
  const f = cronEnvFile(app);
  mkdirSync(dirname(f), { recursive: true });
  // One KEY=VALUE per line, no quoting: systemd's EnvironmentFile takes the rest of the line
  // literally, so a value with spaces is fine but a newline would corrupt the file.
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`)
    .join('\n');
  writeFileSync(f, `${body}\n`, { mode: 0o600 });
  return f;
}

// Install (or refresh) the unit pair for one job and arm the timer.
export function install(app, { image, schedule, cmd, env = {}, volumes = [] }) {
  const cal = validateSchedule(schedule);
  const envFile = writeEnvFile(app, env);
  const docker = dockerBin();

  const args = ['run', '--rm', '--name', `jd-cron-${app}`, '--network', NET, '--env-file', envFile];
  for (const v of volumes) args.push('-v', v);
  // `--entrypoint sh` so the command is interpreted the same way the release phase runs one, and
  // so the image's own entrypoint can't swallow or mangle the arguments.
  args.push('--entrypoint', 'sh', image, '-c', `"${escapeExec(cmd)}"`);

  writeFileSync(servicePath(app), `[Unit]
Description=JustDeploy cron: ${app}
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=${docker} ${args.join(' ')}
`);

  writeFileSync(timerPath(app), `[Unit]
Description=JustDeploy cron timer: ${app}

[Timer]
OnCalendar=${cal}
Persistent=true
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
`);

  execSync('systemctl daemon-reload');
  execSync(`systemctl enable --now ${unitName(app)}.timer`);
  return { schedule: cal, next: nextRun(app) };
}

// Trigger a run right now, without waiting for the timer. Returns once it has been started —
// the run itself is asynchronous, so follow it in the logs.
export function runNow(app) {
  if (!existsSync(servicePath(app))) throw new Error(`no scheduled job installed for ${app} — deploy it first`);
  execSync(`systemctl start --no-block ${unitName(app)}.service`);
}

export function remove(app) {
  try { execSync(`systemctl disable --now ${unitName(app)}.timer`, { stdio: 'ignore' }); } catch { /* not installed */ }
  for (const f of [servicePath(app), timerPath(app), cronEnvFile(app)]) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
  }
  try { execSync('systemctl daemon-reload', { stdio: 'ignore' }); } catch { /* ignore */ }
}
