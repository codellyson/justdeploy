// Host provisioning. Takes a bare Debian/Ubuntu box to a JustDeploy-ready one by installing
// the system dependencies the tool leans on — Caddy (required) and Docker (optional, for
// Postgres) — and making sure Caddy's admin API is live. Idempotent: every step checks first
// and only does work that's missing, so `setup` is safe to re-run. On anything that isn't
// apt-based it prints the manual steps and bails rather than guessing.
import { execSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { CADDY_ADMIN } from './paths.js';

const CADDY_KEYRING = '/usr/share/keyrings/caddy-stable-archive-keyring.gpg';
const CADDY_LIST = '/etc/apt/sources.list.d/caddy-stable.list';

// JustDeploy drives Caddy entirely through its admin API and serves app files from root-owned
// /srv dirs — so Caddy must run as root, and it must `--resume` its last admin-applied config
// on restart (not the default Caddyfile), or a reboot drops every app route. Stock apt Caddy
// runs as the `caddy` user against /etc/caddy/Caddyfile; this drop-in fixes both.
const CADDY_DROPIN_DIR = '/etc/systemd/system/caddy.service.d';
const CADDY_DROPIN = `${CADDY_DROPIN_DIR}/override.conf`;
const CADDY_DROPIN_CONTENT = `[Service]
User=root
Group=root
ExecStart=
ExecStart=/usr/bin/caddy run --resume
ExecReload=
`;

// --- small shell helpers -------------------------------------------------
export function have(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}
function sh(cmd) { execSync(cmd, { stdio: 'inherit' }); }
function quiet(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}
const mark = (ok) => (ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m');
const step = (m) => console.log(`\x1b[36m→\x1b[0m ${m}`);

// --- platform / prerequisites -------------------------------------------
export function platform() {
  const isLinux = process.platform === 'linux';
  const isApt = isLinux && (existsSync('/etc/debian_version') || have('apt-get'));
  return { isLinux, isApt };
}

export function isRoot() { return typeof process.getuid === 'function' && process.getuid() === 0; }

export function nodeOk() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 5);
}

// --- Caddy ---------------------------------------------------------------
export function caddyInstalled() { return have('caddy'); }

export function caddyRunning() { return quiet('systemctl is-active caddy') === 'active'; }

export async function caddyAdminOk() {
  try {
    const res = await fetch(`${CADDY_ADMIN}/config/`, {
      // Caddy's admin API enforces an origin check and 403s browser-style requests with an
      // empty Origin — and Node's fetch sends `Sec-Fetch-Mode: cors`, so it trips it. Present
      // the admin address as the origin, exactly as caddy.js does for its mutating requests.
      headers: { Origin: CADDY_ADMIN },
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch { return false; }
}

export function installCaddy() {
  step('installing Caddy (official apt repo)…');
  sh('apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg');
  if (!existsSync(CADDY_KEYRING)) {
    sh(`curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o ${CADDY_KEYRING}`);
  }
  if (!existsSync(CADDY_LIST)) {
    sh(`curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > ${CADDY_LIST}`);
  }
  sh('apt-get update');
  sh('apt-get install -y caddy');
}

export function startCaddy() {
  step('enabling + starting the Caddy service…');
  sh('systemctl enable --now caddy');
}

// Install the root + --resume drop-in JustDeploy needs. Idempotent: only rewrites and restarts
// when the content actually changes, so re-running setup doesn't bounce a healthy Caddy.
export function configureCaddy() {
  const current = existsSync(CADDY_DROPIN) ? readFileSync(CADDY_DROPIN, 'utf8') : '';
  if (current === CADDY_DROPIN_CONTENT) { step('Caddy already configured for JustDeploy (root + --resume).'); return; }
  step('configuring Caddy to run as root with --resume…');
  mkdirSync(CADDY_DROPIN_DIR, { recursive: true });
  writeFileSync(CADDY_DROPIN, CADDY_DROPIN_CONTENT);
  try { execSync('systemctl daemon-reload', { stdio: 'ignore' }); } catch { /* ignore */ }
  try { execSync('systemctl restart caddy', { stdio: 'ignore' }); } catch { /* startCaddy handles it */ }
}

// --- Docker --------------------------------------------------------------
export function dockerInstalled() { return have('docker'); }

// Daemon actually reachable — the binary existing says nothing about whether dockerd is up.
export function dockerRunning() {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}

export function installDocker() {
  step('installing Docker Engine (get.docker.com)…');
  sh('curl -fsSL https://get.docker.com | sh');
  // get.docker.com already enables + starts dockerd. We deliberately do NOT race it with our
  // own `systemctl start` — two rapid starts trip systemd's restart limiter ("start request
  // repeated too quickly"). ensureDockerRunning() below settles it if anything went sideways.
}

// Make sure dockerd is up, clearing systemd's rapid-restart limiter if a racing start tripped
// it during install. Returns true once the daemon answers. Safe to call when already running.
export async function ensureDockerRunning() {
  if (dockerRunning()) return true;
  try { execSync('systemctl reset-failed docker', { stdio: 'ignore' }); } catch { /* ignore */ }
  try { execSync('systemctl enable --now docker', { stdio: 'ignore' }); } catch { /* ignore */ }
  for (let i = 0; !dockerRunning() && i < 6; i++) await new Promise((r) => setTimeout(r, 1000));
  return dockerRunning();
}

// --- report --------------------------------------------------------------
// Gather current state without changing anything. Used by both `setup` (before/after) and
// the `doctor` dry-run.
export async function inspect() {
  const dockerBin = dockerInstalled();
  return {
    node: nodeOk(),
    nodeVersion: process.versions.node,
    caddy: caddyInstalled(),
    caddyRunning: caddyRunning(),
    caddyAdmin: await caddyAdminOk(),
    dockerInstalled: dockerBin,
    docker: dockerBin && dockerRunning(), // usable = binary present AND daemon up
  };
}

export function printReport(s) {
  const dockerLine = s.docker
    ? 'Docker'
    : s.dockerInstalled
      ? 'Docker installed but daemon not running (try: systemctl start docker)'
      : 'Docker (optional — needed only for Postgres)';
  console.log('');
  console.log(`  ${mark(s.node)} Node ${s.nodeVersion} ${s.node ? '' : '(need ≥ 22.5)'}`);
  console.log(`  ${mark(s.caddy)} Caddy installed`);
  console.log(`  ${mark(s.caddyRunning)} Caddy service running`);
  console.log(`  ${mark(s.caddyAdmin)} Caddy admin API (${CADDY_ADMIN})`);
  console.log(`  ${mark(s.docker)} ${dockerLine}`);
  console.log('');
}

// --- uninstall helpers ---------------------------------------------------
// System-level teardown. The app/database teardown (which needs the engine) stays in the CLI;
// these cover the pieces `setup` itself put on the box: systemd units, the CLI link, the
// Caddy package, and on-disk directories.
export function removeUnit(unit) {
  // `unit` includes its suffix, e.g. 'justdeploy-dashboard.service' or 'justdeploy-backup.timer'.
  try { execSync(`systemctl disable --now ${unit}`, { stdio: 'ignore' }); } catch { /* not present */ }
  const path = `/etc/systemd/system/${unit}`;
  if (existsSync(path)) { try { rmSync(path); } catch { /* ignore */ } }
}

export function daemonReload() { try { execSync('systemctl daemon-reload', { stdio: 'ignore' }); } catch { /* ignore */ } }

export function removeCli() {
  step('removing the justdeploy CLI…');
  try { execSync('npm rm -g justdeploy', { stdio: 'ignore' }); } catch { /* not npm-linked */ }
  for (const p of ['/usr/local/bin/justdeploy', '/usr/bin/justdeploy']) {
    if (existsSync(p)) { try { rmSync(p); } catch { /* ignore */ } }
  }
}

export function removeCaddyPackage() {
  if (!platform().isApt) { console.log('  (skip) not an apt system — remove Caddy manually if you want it gone.'); return; }
  step('purging Caddy from the system…');
  try { execSync('systemctl disable --now caddy', { stdio: 'ignore' }); } catch { /* ignore */ }
  try { execSync('apt-get purge -y caddy', { stdio: 'inherit' }); } catch { /* ignore */ }
  for (const f of [CADDY_LIST, CADDY_KEYRING]) if (existsSync(f)) { try { rmSync(f); } catch { /* ignore */ } }
  // apt purge leaves our systemd drop-in and Caddy's resumable autosave behind, so a reinstalled
  // Caddy would `--resume` the old routes. Clear the drop-in and every autosave location — root's
  // config dir (our drop-in runs Caddy as root) and the default caddy-user dir.
  removePath(CADDY_DROPIN_DIR);
  removePath('/root/.config/caddy');
  removePath('/var/lib/caddy');
  try { execSync('systemctl daemon-reload', { stdio: 'ignore' }); } catch { /* ignore */ }
}

export function removePath(p) {
  if (!existsSync(p)) return;
  try { rmSync(p, { recursive: true, force: true }); }
  catch (e) { console.log(`  could not remove ${p}: ${e.message}`); }
}

// --- orchestration -------------------------------------------------------
// Provision the host. opts: { docker: bool (default true), check: bool (dry-run) }.
// Returns the final state. Throws (with a friendly message) on a hard blocker.
export async function run(opts = {}) {
  const wantDocker = opts.docker !== false;
  const { isLinux, isApt } = platform();

  if (opts.check) {
    const s = await inspect();
    printReport(s);
    if (!s.caddy || !s.caddyAdmin) console.log('run `justdeploy setup` to install what\'s missing.\n');
    return s;
  }

  if (!isLinux || !isApt) {
    throw new Error(
      'automatic setup supports Debian/Ubuntu (apt) only.\n' +
      'On this system, install the prerequisites yourself:\n' +
      '  • Node ≥ 22.5   • Caddy (admin API on localhost:2019)   • Docker (for Postgres)\n' +
      'then run `justdeploy doctor` to confirm they are reachable.',
    );
  }
  if (!isRoot()) {
    throw new Error('setup installs system packages — run it as root:  sudo justdeploy setup');
  }
  if (!nodeOk()) {
    // We are literally running under this Node, so it's already present — just too old.
    throw new Error(`Node ${process.versions.node} is too old (need ≥ 22.5). Upgrade Node, then re-run.`);
  }

  console.log('Provisioning host for JustDeploy…\n');

  if (!caddyInstalled()) installCaddy();
  else step('Caddy already installed — skipping.');

  configureCaddy(); // root + --resume drop-in (restarts Caddy only if it changed)

  if (!caddyRunning()) startCaddy();
  else step('Caddy already running.');

  if (wantDocker) {
    if (!dockerInstalled()) installDocker();
    else step('Docker already installed — skipping.');
    step('ensuring the Docker daemon is running…');
    if (!(await ensureDockerRunning())) {
      console.log('\x1b[33m!\x1b[0m Docker is installed but the daemon would not start. ' +
        'Check: journalctl -xeu docker.service');
    }
  } else {
    step('skipping Docker (--no-docker); databases will be unavailable.');
  }

  // Caddy can take a moment to bind the admin socket after start.
  let admin = await caddyAdminOk();
  for (let i = 0; !admin && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 800));
    admin = await caddyAdminOk();
  }

  const s = await inspect();
  printReport(s);

  if (!s.caddyAdmin) {
    console.log('\x1b[33m!\x1b[0m Caddy is installed but its admin API is not answering on ' +
      `${CADDY_ADMIN}.\n  Check: systemctl status caddy — and that no custom Caddyfile disabled the admin endpoint.\n`);
  } else {
    console.log('\x1b[32mHost ready.\x1b[0m Deploy your first app:');
    console.log('  justdeploy add https://github.com/you/site.git --type vite --domain app.example.com\n');
  }
  return s;
}
