// Long-running proxy processes: start, health-check, drain, kill. Real side effects.
import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logFile } from './paths.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn a detached Node process, append its stdout/stderr to the app log, return its pid.
export function start(name, { cwd, argv, env }) {
  const lf = logFile(name);
  mkdirSync(dirname(lf), { recursive: true });
  const fd = openSync(lf, 'a');
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  return child.pid;
}

export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Poll the port until it answers HTTP with a non-5xx status (a 404 means "up").
export async function healthCheck(port, { path = '/', timeout = 30 } = {}) {
  const deadline = Date.now() + timeout * 1000;
  let wait = 500;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.status < 500) return true;
    } catch {
      // connection refused / not ready yet
    }
    await sleep(wait);
    wait = Math.min(wait * 1.5, 3000);
  }
  return false;
}

// Wait for in-flight requests, then SIGTERM, escalating to SIGKILL after a grace period.
export async function drainAndKill(pid, drainSeconds = 10) {
  if (!alive(pid)) return;
  await sleep(drainSeconds * 1000);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await sleep(5000);
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
