// Caddy, driven live via its admin API. We assemble the whole Caddyfile from the DB (the
// only source) and POST it to /load as text/caddyfile — Caddy adapts + applies it with a
// graceful (zero-downtime) reload, so in-flight requests on the old upstream drain naturally.
// No config file on disk, no SIGHUP.
import { CADDY_ADMIN, repoDir, currentLink } from './paths.js';
import { row } from './table.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import * as db from './db.js';

// Build the global Caddyfile from every app the tool knows about.
// `dashboard` (optional) is {domain, port} — JustDeploy's own control panel, served like
// any other proxy app so it gets TLS too. The tool dogfoods itself.
export function generate(apps, dashboard) {
  const blocks = [`{\n\tadmin ${admHost()}\n}`];
  if (dashboard?.domain && dashboard?.port) {
    blocks.push(`${dashboard.domain} {\n\treverse_proxy 127.0.0.1:${dashboard.port}\n}`);
  }
  for (const a of apps) {
    if (a.serve === 'static' && a.domain) {
      const artifact = row(a.type).artifact;
      // Serve the current release (rollback = re-symlink `current`, no reload). Fall back to
      // repo/ for apps not yet migrated to the release layout.
      const base = existsSync(currentLink(a.name)) ? currentLink(a.name) : repoDir(a.name);
      const root = artifact === '.' ? base : join(base, artifact);
      blocks.push(
        `${a.domain} {\n` +
        `\troot * ${root}\n` +
        `\ttry_files {path} /index.html\n` +
        `\tfile_server\n` +
        `\tencode gzip\n` +
        `}`,
      );
    } else if ((a.serve === 'proxy' || a.serve === 'container') && a.domain && a.live_port) {
      // Host process (proxy) and Railpack container both reverse-proxy to a localhost port.
      blocks.push(
        `${a.domain} {\n` +
        `\treverse_proxy 127.0.0.1:${a.live_port}\n` +
        `}`,
      );
    }
    // resource types (postgres) never touch Caddy.
  }
  return blocks.join('\n\n') + '\n';
}

function admHost() {
  // "http://localhost:2019" -> "localhost:2019"
  return CADDY_ADMIN.replace(/^https?:\/\//, '');
}

export async function reload(caddyfile) {
  let res;
  try {
    res = await fetch(`${CADDY_ADMIN}/load`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/caddyfile',
        // Caddy's admin API enforces an origin check on mutating requests; a bare
        // fetch sends none and gets a 403. Present the admin address as the origin.
        Origin: CADDY_ADMIN,
      },
      body: caddyfile,
    });
  } catch (e) {
    throw new Error(`cannot reach Caddy admin at ${CADDY_ADMIN} — is Caddy running? (${e.message})`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`caddy reload failed (${res.status}): ${body}`);
  }
}

// Read the whole apps table and push the resulting config. Called after any change.
// dashboardSettings (optional) {domain, port} adds the control-panel route.
export async function apply(apps, dashboard) {
  await reload(generate(apps, dashboard));
}

// The single source of Caddy truth: rebuild from the DB, always including the dashboard
// route if one is configured. Everything (deploy, rm, reconcile, dashboard actions) uses
// this so no path accidentally drops the panel or another app.
export function dashboardFromDb(database) {
  const domain = db.getSetting(database, 'dashboard_domain');
  const port = db.getSetting(database, 'dashboard_port');
  return domain && port ? { domain, port: Number(port) } : undefined;
}

export async function applyFromDb(database) {
  await apply(db.listApps(database), dashboardFromDb(database));
}
