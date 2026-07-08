// Source-IP allowlist for publicly-exposed database ports.
//
// Docker's `-p` publish inserts its own iptables rules that BYPASS ufw, so a normal firewall
// won't restrict a published port. The supported hook is the DOCKER-USER chain (Docker
// guarantees it's traversed before its own rules and never flushes it). We match on conntrack's
// ORIGINAL destination port (the published host port) — stable across container recreates and
// unique per database — so rules survive expose/restart without depending on the container IP.
import { spawnSync } from 'node:child_process';
import * as db from './db.js';

const tag = (name) => `jd:${name}`;
function ipt(args) { return spawnSync('iptables', args, { encoding: 'utf8' }); }

// Existing DOCKER-USER rule lines belonging to this db (identified by its comment tag).
function rulesFor(name) {
  const out = spawnSync('iptables', ['-S', 'DOCKER-USER'], { encoding: 'utf8' }).stdout || '';
  return out.split('\n').filter((l) => l.includes(tag(name)));
}

// Drop this db's rules.
export function clear(name) {
  for (const line of rulesFor(name)) {
    const toks = line.replace(/^-A\s+/, '').match(/"[^"]*"|\S+/g).map((t) => t.replace(/^"|"$/g, ''));
    ipt(['-D', ...toks]); // toks[0] is the chain (DOCKER-USER)
  }
}

// Allow only `cidrs` to reach the published `hostPort`; drop everyone else.
export function allow(name, hostPort, cidrs) {
  clear(name);
  const base = ['-p', 'tcp', '-m', 'conntrack', '--ctorigdstport', String(hostPort), '-m', 'comment', '--comment', tag(name)];
  for (const cidr of cidrs) ipt(['-I', 'DOCKER-USER', ...base, '-s', cidr, '-j', 'ACCEPT']);
  ipt(['-A', 'DOCKER-USER', ...base, '-j', 'DROP']);
}

// Whether iptables/DOCKER-USER is usable (root + Docker running).
export function available() {
  return spawnSync('iptables', ['-S', 'DOCKER-USER'], { encoding: 'utf8' }).status === 0;
}

// Re-apply every stored allowlist. DOCKER-USER is empty after a reboot while containers restart
// and republish their ports, so this runs at dashboard startup to re-close the gap.
export function reconcile(database) {
  if (!available()) return;
  for (const r of db.listResources(database)) {
    if (r.kind !== 'postgres' || !r.port || !r.allow_ips) continue;
    allow(r.name, r.port, r.allow_ips.split(',').map((s) => s.trim()).filter(Boolean));
  }
}
