// The project config file — an optional INPUT to `add` (or an exported snapshot). The source
// of truth is the SQLite state db, not these files; the tool does not read them back per
// deploy. This module just parses/validates the small yaml subset when one is provided.
//
//   name: gobi-design
//   type: vite            # react | vite | static | adonis | nextjs
//   domain: gobi.design
//   postgres: gobi-db     # optional: names a provisioned db resource to wire in
//   health:               # optional, proxy types only
//     path: /health
//     timeout: 30
//
// A deliberately tiny YAML subset: flat key: value pairs plus one nested block (`health`).
// We do not pull in a YAML dependency for four keys.
import { readFileSync } from 'node:fs';
import { TYPES } from './table.js';

function scalar(raw) {
  let v = raw.trim();
  if (v.startsWith('#') || v === '') return undefined;
  // strip trailing inline comment (only when unquoted)
  if (v[0] !== '"' && v[0] !== "'") {
    const h = v.indexOf(' #');
    if (h !== -1) v = v.slice(0, h).trim();
  }
  if ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")) {
    return v.slice(1, -1);
  }
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

export function parse(text) {
  const cfg = {};
  let block = null; // name of the current nested block, e.g. "health"
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indented = /^\s/.test(line);
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = scalar(line.slice(colon + 1));

    if (!indented) {
      if (val === undefined) {
        block = key; // opens a nested block like `health:`
        cfg[key] = {};
      } else {
        block = null;
        cfg[key] = val;
      }
    } else if (block) {
      cfg[block][key] = val;
    }
  }
  return cfg;
}

export function validate(cfg) {
  const errs = [];
  if (!cfg.name || !/^[a-z0-9-]+$/.test(cfg.name)) {
    errs.push('name is required and must be [a-z0-9-]');
  }
  if (!TYPES.includes(cfg.type)) {
    errs.push(`type must be one of: ${TYPES.join(', ')}`);
  }
  const serveNeedsDomain = cfg.type !== 'postgres';
  if (serveNeedsDomain && !cfg.domain) {
    errs.push('domain is required for deployable types');
  }
  if (errs.length) throw new Error(`invalid config:\n  - ${errs.join('\n  - ')}`);
  return cfg;
}

export function load(path) {
  return validate(parse(readFileSync(path, 'utf8')));
}

// Serialize back out — used by `add` to write the file it will then treat as truth.
export function stringify(cfg) {
  const lines = [`name: ${cfg.name}`, `type: ${cfg.type}`];
  if (cfg.domain) lines.push(`domain: ${cfg.domain}`);
  if (cfg.repo) lines.push(`repo: ${cfg.repo}`);
  if (cfg.postgres) lines.push(`postgres: ${cfg.postgres}`);
  if (cfg.release) lines.push(`release: ${cfg.release}`);
  if (cfg.persist) lines.push(`persist: ${cfg.persist}`);
  if (cfg.health) {
    lines.push('health:');
    if (cfg.health.path) lines.push(`  path: ${cfg.health.path}`);
    if (cfg.health.timeout) lines.push(`  timeout: ${cfg.health.timeout}`);
  }
  return lines.join('\n') + '\n';
}
