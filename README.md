# JustDeploy

Lean, single-server deploy platform for a fixed menu of app types. Bring your own VPS —
Docker + Caddy do the heavy lifting. No accounts, no forms: pick a type, point it at a repo,
done. Ships a CLI **and** a React control panel.

**What you get:** zero-downtime deploys · self-diagnosing failures (plain-English reason + fix) ·
live build-log streaming · automatic npm peer-conflict recovery (retries `ERESOLVE` installs with
`--legacy-peer-deps`, like Vercel — no `.npmrc` needed) · process supervision (crashed apps
self-heal) · one-command rollback · git-push auto-deploy · S3 / R2 backups · a Vercel-style
dashboard built on the [justui](https://github.com/codellyson/justui) design system with six themes.

Full install + usage guide: **[justdeploy.kreativekorna.com](https://justdeploy.kreativekorna.com)**
(source: [docs/index.html](docs/index.html)).

## Screenshots

**Overview** — your fleet at a glance: services up, recent deploys, every app.

![Overview](docs/screenshots/overview.png)

**Per-app pages** — status, live logs, deploy history + rollback, env, and config, all in tabs.

![App detail](docs/screenshots/app-detail.png)

**New project** — the type picker *is* the configuration; it decides how the app builds and runs.

![New project](docs/screenshots/new-project.png)

## Quick start

On a fresh Ubuntu VPS with your domain's DNS pointed at it, one command installs everything —
Node, the CLI, then Caddy + Docker via `justdeploy setup`:

```sh
curl -fsSL https://raw.githubusercontent.com/codellyson/justdeploy/master/install.sh | bash

# deploy your first app — the type decides build + run, and Caddy gets a Let's Encrypt cert
justdeploy add https://github.com/you/site.git --type vite --domain app.example.com

# optional: the web control panel (builds the React UI, served with TLS by Caddy)
justdeploy dashboard install --domain panel.example.com

# optional: git push -> auto-deploy
justdeploy webhook
```

Prefer to do it by hand? Install Node ≥ 22.5, then `git clone … && npm link`, then run
`justdeploy setup` (installs + wires up Caddy and Docker) and `justdeploy doctor` to verify.
Full walkthrough: **[docs/index.html](docs/index.html)** (also live at
[justdeploy.kreativekorna.com](https://justdeploy.kreativekorna.com)).

## Requirements (on the server)

`justdeploy setup` installs and configures Caddy and Docker for you on Debian/Ubuntu, so in
practice the only thing you provide is **Node ≥ 22.5** (needed to run the CLI itself). For
reference, the full set:

- **Node ≥ 22.5** (uses the built-in `node:sqlite`; on Node 23 it prints an experimental
  warning — silenced with `NODE_OPTIONS=--disable-warning=ExperimentalWarning`)
- **Caddy** with its admin API on `localhost:2019` — *installed by `justdeploy setup`*
- **Docker** (only for the `postgres` resource) — *installed by `justdeploy setup`*
- **git**

Run `justdeploy doctor` any time to see which of these are present and reachable.

## Install

One command on a fresh Debian/Ubuntu box (installs Node, clones, links the CLI, then runs
`justdeploy setup`):

```
curl -fsSL https://raw.githubusercontent.com/codellyson/justdeploy/master/install.sh | bash
```

Or by hand:

```
git clone <this repo> /opt/justdeploy
cd /opt/justdeploy
npm link            # or: ln -s /opt/justdeploy/bin/justdeploy /usr/local/bin/justdeploy
justdeploy setup    # installs + wires up Caddy and Docker; idempotent, run as root
justdeploy doctor   # check prerequisites without changing anything
```

`justdeploy setup` handles the system dependencies (Caddy with its admin API, Docker for
Postgres) on Debian/Ubuntu; pass `--no-docker` to skip Docker. State lives in
`/var/lib/justdeploy/state.db`; apps live under `/srv/<name>/`. Override with
`JUSTDEPLOY_HOME` and `JUSTDEPLOY_SRV`.

To reverse it, `justdeploy uninstall` removes **everything** — apps, databases, Caddy (package
+ config), state, and the checkout — after printing the plan and prompting `y/N`. Flags only
hold things back:

```
justdeploy uninstall                # full removal (prompts to confirm)
justdeploy uninstall --keep-data    # keep state.db, app files, and db volumes
justdeploy uninstall --keep-caddy   # leave Caddy installed, just drop the routes
justdeploy uninstall --yes          # skip the prompt (for scripts / non-interactive)
```

Docker is always left in place (it's a shared tool). The prompt is required at a terminal;
piped/non-interactive runs need `--yes`.

## Use

```
# register an app and deploy it in one step. type is detected from the repo's package.json
# and domain is inferred as <name>.<base>, so a bare add just works:
justdeploy add https://github.com/you/site.git                        # type + domain inferred
justdeploy add https://github.com/you/api.git  --type adonis --domain api.gobi.design  # override either

# redeploy (pull → build → swap)
justdeploy deploy api
justdeploy deploy                 # all deployable apps

justdeploy ls                     # what's deployed, ports, pids
justdeploy logs api -f            # tail an app's log
justdeploy env api DATABASE_URL=postgres://...   # set one or more KEY=VAL, then redeploy
justdeploy env api --file .env                    # load a whole .env at once
justdeploy pg api                 # provision a Postgres container, prints conn string
justdeploy rollback api           # redeploy the previous successful commit
justdeploy webhook                # enable git-push auto-deploy, print the setup to paste into GitHub
justdeploy set api --release "node ace migration:run --force" --persist tmp
justdeploy reconcile              # rebuild Caddy config from the db
```

### Backups (bring your own S3 / R2)

The source of truth is `state.db`, so back it up off-box. A backup captures `state.db`, each
app's `data/` dir, and a `pg_dump` of every Postgres — not repos/logs (rebuildable). You bring
the bucket and choose the interval.

```
# point at your bucket once (works for AWS S3 and Cloudflare R2)
justdeploy backup config --endpoint https://<acct>.r2.cloudflarestorage.com \
  --bucket my-backups --access-key <k> --secret-key <s> [--region auto] [--prefix justdeploy]

justdeploy backup                 # snapshot + upload to your bucket (keeps a local copy too)
justdeploy backup --local         # snapshot locally only, no upload
justdeploy backup --keep 7        # local retention: keep newest 7
justdeploy backup --schedule daily # optional: install a systemd timer at your interval
                                    #   (or just call `justdeploy backup` from your own cron/CI)
justdeploy restore <file> --yes   # restore state.db + data dirs + postgres from a backup
```

The archive is `chmod 600` — it contains secrets (env vars, admin hash, webhook secret).

### Referencing a database (or another app) in env

Env values can pull fields from a provisioned resource or another app at deploy time, so you
never paste — or drift on — a password. The reference is stored verbatim and resolved on every
deploy (rotate a db password and the next deploy picks it up automatically):

```
# a postgres resource named `gobi-db` (the name shown in `justdeploy ls`)
justdeploy env api DATABASE_URL='${{gobi-db.DATABASE_URL}}'
justdeploy env api DB_HOST='${{gobi-db.PGHOST}}' DB_PORT='${{gobi-db.PGPORT}}' \
  DB_USER='${{gobi-db.PGUSER}}' DB_PASSWORD='${{gobi-db.PGPASSWORD}}' DB_DATABASE='${{gobi-db.PGDATABASE}}'

# another app's env var, or this app's own (no dot)
justdeploy env api FRONTEND='${{web.PUBLIC_URL}}'
justdeploy env api ORIGIN='https://${{DOMAIN}}'
```

Postgres fields: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`,
`DATABASE_URL` (private), `DATABASE_PUBLIC_URL`. A reference that doesn't resolve fails the
deploy with a plain-English reason (naming the sources that *do* exist) — it never ships a
literal `${{…}}` to your app. Quote the value in the shell so it doesn't expand `${…}` itself.

### Database-backed apps (migrations + persistence)

Two optional per-app knobs, set at `add`, via `justdeploy set`, or in the dashboard Config panel:

- `--release "<cmd>"` — runs after build, before the server starts, with the app's env
  (e.g. `node ace migration:run --force`). For container/worker types it runs as its own phase in
  the freshly built image, on the same network and volumes; a nonzero exit fails the deploy and
  leaves the previous version serving.
- `--persist "tmp,storage"` — runtime dirs symlinked to the persistent `/srv/<name>/data/`
  area so their contents (like a SQLite file) survive the build dir being replaced each deploy.

### Supported types

| type     | serve model | what `add` auto-fills                                    |
|----------|-------------|----------------------------------------------------------|
| `react`  | static      | serves `build/` with SPA fallback                        |
| `vite`   | static      | serves `dist/` with SPA fallback                          |
| `static` | static      | serves the repo root                                     |
| `adonis` | container   | `APP_KEY`, `HOST=0.0.0.0`, `PORT`, `NODE_ENV`, migrations |
| `nextjs` | container   | `HOSTNAME=0.0.0.0`, `PORT`; runs `next start` as-is (no next.config change), or standalone if set |
| `app`    | container   | `PORT`, `NODE_ENV`; catch-all for anything Railpack can build (Node, Python, Go, …) |
| `worker` | worker      | `NODE_ENV`; **no port, no domain, no HTTP health check** — for processes that never serve traffic |
| `cron`   | cron        | `NODE_ENV`; a batch job run on a schedule instead of kept alive |
| `postgres` | resource  | `docker run` + scoped non-superuser role, TLS, localhost port |

### Workers (bots, queue consumers, schedulers)

A `worker` is a service that runs but never answers HTTP — a Discord/Telegram bot, a BullMQ or
SQS consumer, a cron-style scheduler, a scraper. It's built by Railpack exactly like `app`, but
nothing is published and no route is added, so **it is never health-checked over HTTP** — every
other type would be killed by that probe for not listening.

```bash
justdeploy add https://github.com/you/bot.git --type worker
```

A worker's deploy succeeds when its container **stays up** for a short settle window; a process
that exits or crash-loops fails the deploy with its own output in the logs. After that Docker's
`--restart unless-stopped` keeps it alive. Env vars, `--persist`, Postgres references, rollback,
and auto-deploy on push all work the same as any other service.

A worker that exits straight away isn't a worker — that's a one-shot job, and it belongs in
`--release "<cmd>"` on a real service instead.

Already registered something as `app` that turned out not to serve HTTP? Convert it in place,
keeping its env, project, and history:

```bash
justdeploy set <name> --type worker && justdeploy deploy <name>
```

### Scheduled jobs (`cron`)

A `cron` service is a batch job: it runs on a schedule, does its work, and exits. Same Railpack
build as a worker — but instead of being kept alive, the image is handed to a systemd timer.

```bash
justdeploy add https://github.com/you/repo.git --type cron \
  --subdir ingest --schedule daily --cmd "npm run ingest"
```

- `--schedule` takes `hourly` / `daily` / `weekly` / `monthly`, or any systemd
  [OnCalendar](https://www.freedesktop.org/software/systemd/man/systemd.time.html) expression
  (`*-*-* 03:00:00`, `Mon *-*-* 06:00`). It's validated at `add` time, not at 3am.
- `--cmd` is what each run executes inside the built image.
- The deploy succeeds when the image builds and the timer is armed. Whether a *run* works is the
  run's business — check it with `justdeploy schedule`.

```bash
justdeploy schedule          # when each job fires, and how its last run went
justdeploy run <name>        # fire one now, without waiting for the timer
justdeploy logs <name> -f    # every run's output (journald)
```

Runs never overlap (systemd won't start a job whose previous run is still going), missed runs are
caught up after downtime (`Persistent=true`), and env vars, `--persist`, and `${{Postgres.URL}}`
references work as they do everywhere else. Secrets go in a root-only env file, never inline in
the unit — units are world-readable.

**Batch job or worker?** If the process is *supposed* to exit when it's done, it's a `cron`. If
it's supposed to run forever, it's a `worker`. Deploying a batch job as a worker fails with
*"this looks like a batch job, not a service"*, which is the platform telling you to use `cron`.

## Users (friends & family)

The dashboard is multi-user. The first account is the **admin** (created on the setup screen, or
via `justdeploy dashboard install`). From **Settings → Users**, the admin adds members with a
temporary password; each member:

- signs in with their own username and sets their own password on first login,
- sees and manages **only their own** projects, apps, and databases,
- connects **their own GitHub** (Settings → GitHub) to deploy their own private repos,
- is capped by a per-user **app quota** (admin-configurable; default 3).

The admin sees everything and owns all global settings (base domain, backups, webhook, host
maintenance). The **CLI stays admin-only** — members use the web dashboard.

> **Not a security sandbox.** Isolation is at the dashboard level (who can see/manage what). Members'
> apps still run as containers on a shared Docker daemon, so this is for **people you trust**, not
> hostile tenants. And everything shares one box's CPU/RAM/disk — **size the server up** (and set
> quotas) before inviting people; a tiny box fills quickly (each container image is ~1 GB).

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
- **Backups** — `justdeploy backup` snapshots `state.db` + data dirs + Postgres and uploads to
  your S3/R2 bucket (zero-dep SigV4); `restore` brings it back. You bring the bucket + interval ✓

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
