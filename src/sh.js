// Shell helpers. Everything real — we genuinely shell out to git, npm, docker.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logFile } from './paths.js';

// Run a shell string in `cwd`, streaming combined output into the app's log AS IT ARRIVES
// (so a live log tail sees a long `npm ci` progress in real time, not all at once at the
// end). Returns a promise; rejects on non-zero exit. `env` (optional) is merged over the
// inherited environment — used to pass app env to release commands like migrations.
export function run(name, cwd, cmd, env) {
  const lf = logFile(name);
  mkdirSync(dirname(lf), { recursive: true });
  appendFileSync(lf, `\n$ ${cmd}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd, env: env ? { ...process.env, ...env } : process.env,
    });
    let out = '';
    const capture = (chunk) => { out += chunk; appendFileSync(lf, chunk); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      appendFileSync(lf, `\n[exit ${code}]\n`);
      reject(new Error(`command failed: ${cmd}\n${out.trim().slice(-2000)}`));
    });
  });
}

// Capture stdout of a command without logging (for short queries like git rev-parse).
export function capture(cwd, argv) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${argv.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return (r.stdout || '').trim();
}
