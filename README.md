# JustDeploy

A lean, single-server deploy tool for a fixed menu of app types. Bring your own VPS,
config in files you own, no accounts, no forms. See [CONCEPT.md](CONCEPT.md) for the design
and [docs/port-swap.md](docs/port-swap.md) for the one stateful operation.

## Requirements (on the server)

- **Node ≥ 22.5** (uses the built-in `node:sqlite`; on Node 23 it prints an experimental
  warning — silence with `NODE_OPTIONS=--disable-warning=ExperimentalWarning`)
- **Caddy** running with its admin API on `localhost:2019` (the default)
- **Docker** (only if you use the `postgres` resource)
- **git**

## Install

```
git clone <this repo> /opt/justdeploy
cd /opt/justdeploy
npm link            # or: ln -s /opt/justdeploy/bin/justdeploy /usr/local/bin/justdeploy
```

State lives in `/var/lib/justdeploy/state.db`; apps live under `/srv/<name>/`. Override with
`JUSTDEPLOY_HOME` and `JUSTDEPLOY_SRV`.

## Use

```
# register an app and deploy it in one step — the type decides everything
justdeploy add https://github.com/you/site.git --type vite --domain gobi.design
justdeploy add https://github.com/you/api.git  --type adonis --domain api.gobi.design

# redeploy (pull → build → swap)
justdeploy deploy api
justdeploy deploy                 # all deployable apps

justdeploy ls                     # what's deployed, ports, pids
justdeploy logs api -f            # tail an app's log
justdeploy env api DATABASE_URL=postgres://...   # set env, then redeploy
justdeploy pg api                 # provision a Postgres container, prints conn string
justdeploy rollback api           # redeploy the previous successful commit
justdeploy webhook                # enable git-push auto-deploy, print the setup to paste into GitHub
justdeploy set api --release "node ace migration:run --force" --persist tmp
justdeploy reconcile              # rebuild Caddy config from the db
```

### Database-backed apps (migrations + persistence)

Two optional per-app knobs, set at `add`, via `justdeploy set`, or in the dashboard Config panel:

- `--release "<cmd>"` — runs after build, before the server starts, with the app's env
  (e.g. `node ace migration:run --force`).
- `--persist "tmp,storage"` — runtime dirs symlinked to the persistent `/srv/<name>/data/`
  area so their contents (like a SQLite file) survive the build dir being replaced each deploy.

### Supported types

| type     | serve model | what `add` auto-fills                                    |
|----------|-------------|----------------------------------------------------------|
| `react`  | static      | serves `build/` with SPA fallback                        |
| `vite`   | static      | serves `dist/` with SPA fallback                          |
| `static` | static      | serves the repo root                                     |
| `adonis` | proxy       | `APP_KEY`, `HOST=0.0.0.0`, `PORT`, `NODE_ENV`            |
| `nextjs` | proxy       | `HOSTNAME=0.0.0.0`, `PORT`, runs the standalone asset copy |
| `postgres` | resource  | `docker run` on `deploy-net`, no published port          |
| `sqlite` | file        | reserves the persistent `data/` dir                      |

## Config & source of truth

The **source of truth is the SQLite state db** (`/var/lib/justdeploy/state.db`), written by the
CLI and dashboard. A `justdeploy.yml` is an optional *input* to `add` (or an export snapshot),
not a live record — editing one after the fact does nothing until you re-`add`.
`justdeploy reconcile` rebuilds Caddy's live config **from the db**.

Because the db is the single record, **back it up** — `state.db` and the app data volumes under
`/srv/<name>/data` are the only irreplaceable state.

```yaml
name: gobi-design
type: vite
domain: gobi.design
postgres: gobi-db     # optional
health:               # optional, proxy types
  path: /health
  timeout: 30
```

## Status

Core engine complete and **verified end-to-end on a real server** (Ubuntu 24.04 + Caddy 2.11):

- **Static deploy** — git clone → build → Caddy live-load → HTTPS serve ✓
- **Proxy deploy + zero-downtime swap** — build → spawn → health-check → Caddy repoint →
  drain/kill old process. Verified with an availability probe: **zero dropped requests during
  the port swap** ✓
- **Postgres** — provision on `deploy-net` with no host port published, teardown of
  container + volume ✓
- **`rm`** — stops the process, drops the Caddy route, deletes files and DB rows ✓
- **Process supervision** — a supervisor relaunches any proxy app whose process dies (crash
  or reboot), same port/no rebuild, with backoff. Verified: `kill -9` → back up in ~6s ✓
- **Rollback** — `justdeploy rollback <name>` / dashboard button redeploys the previous
  successful commit ✓
- **Self-service failures** — deploy failures show a plain-English reason + fix (CLI and
  dashboard); build/deploy logs stream live to the dashboard ✓
- **git-push auto-deploy** — a signed webhook (`POST /api/webhook`) redeploys apps matching the
  pushed repo, default-branch only. Enable with `justdeploy webhook` ✓

**Web dashboard** (Vercel-style control panel) — password login, new-project type-picker,
deploy/logs/env/delete, Postgres provisioning, and a live theme switcher. Built on the
`@codellyson/justui` design system (all six themes). Set it up with:

```
justdeploy dashboard install --domain panel.example.com [--password <p>]
```

It runs as a systemd service (`justdeploy-dashboard`) on 127.0.0.1:4999, served with TLS by
Caddy like any other app — JustDeploy deploys its own dashboard. Reset the password any time
with `justdeploy dashboard password <new>`.

Not built yet (deliberately deferred): the git-push webhook receiver and the "upload a
folder" static ingestion mode.
