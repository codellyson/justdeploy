# Lean Deploy Tool — Concept Note

A stripped-down, single-server deploy tool for a fixed menu of app types. Not a Coolify
competitor. An opinionated deploy tool for one person's workflow, bring-your-own-VPS, no
accounts, no forms.

## The core idea

Coolify and other PaaS panels are complex because they have to ask "what could this app
possibly be?" and expose every knob for every answer. If you already know the answer is
one of six things, you throw away all the detection and all the configurability and just
run the right two commands.

The whole product is:

- Two build-and-proxy templates (Node processes)
- One static template (folders)
- One saved Postgres docker command

Everything else is the same deploy loop wrapped around a small framework table.

## Scope discipline

The trap is scope creep: start lean, then slowly reimplement Coolify badly one feature at
a time. The rules that keep it small:

- Single server only. No orchestration, no multi-server.
- Hardcode your own conventions instead of making things configurable.
- Skip the hard 20% deliberately: no service template catalog, no multi-tenant UI, no
  scheduled backups, no secrets encryption at rest. You are a single user on a single box.

## The framework table

This table is the only thing that varies between app types. Everything else is shared.

| type       | build command                                                      | artifact / entrypoint         | serve model      |
|------------|--------------------------------------------------------------------|-------------------------------|------------------|
| `react`    | `npm ci && npm run build`                                          | `build/` (folder)             | static           |
| `vite`     | `npm ci && npm run build`                                          | `dist/` (folder)              | static           |
| `static`   | none (or custom)                                                   | `./` or `public/`             | static           |
| `adonis`   | `npm ci && node ace build && cp package-lock.json build/ && cd build && npm ci --omit=dev` | `build/bin/server.js` | proxy |
| `nextjs`   | `npm ci && npm run build`                                          | `.next/standalone/server.js`  | proxy            |
| `postgres` | none                                                               | container                     | one-time recipe  |

Adding a framework later is appending a row, not writing new logic.

Note: Vite emits `dist/`, create-react-app emits `build/`. That difference is a column,
not logic.

## Serve model 1: static (react, vite, static)

No process, no container needed. Caddy serves the folder directly with SPA fallback.

```
gobi.design {
    root * /srv/gobi-design/dist
    try_files {path} /index.html
    file_server
    encode gzip
}
```

`try_files {path} /index.html` is the entire SPA-routing solution. Any path that is not a
real file falls back to `index.html` so client-side routing works. Only the `root` path
changes between static apps.

## Serve model 2: proxy (adonis, nextjs)

Long-running Node process on an assigned port, Caddy reverse-proxies to it. The tool
assigns each app a port (increment from 4000, store in SQLite), injects it as `PORT`, and
points Caddy there.

```
api.gobi.design {
    reverse_proxy 127.0.0.1:4001
}
```

Caddy fetches and renews the TLS cert automatically the moment this block exists. That is
the reason to use it over nginx.

### AdonisJS

Runs from inside the build dir. Required env:

```
HOST=0.0.0.0
PORT=4001
APP_KEY=<node ace generate:key>
NODE_ENV=production
```

Launch: `cd build && node bin/server.js`

Trap: `HOST=0.0.0.0` is mandatory. If it binds to localhost the proxy cannot reach it and
you get a 502.

Trap: `node ace build` copies `package.json` into `build/` but not `package-lock.json`, so
a bare `npm ci` in `build/` fails ("no lockfile"). Copy the lockfile in first (see the build
command above) to keep a deterministic install.

## Release command + persisted dirs (DB-backed apps)

Two optional per-app knobs cover apps that need a database:

- `release: <cmd>` — a command run **after build, before the server starts**, with the app's
  env injected. Typically `node ace migration:run --force`. This is the one place migrations
  belong: not in the build (no env/db yet), not in the server boot (racy across the swap).
- `persist: <dir,dir>` — runtime data dirs (e.g. `tmp` holding a SQLite file) that get
  symlinked to the persistent `/srv/<name>/data/` area, so they survive the build dir being
  replaced each deploy. This is the SQLite convention made automatic: the `.db` file ends up
  on stable storage without the app hardcoding an absolute path.

Set them at `add` time (`--release`, `--persist`), later via `justdeploy set <name>`, or in
the dashboard's per-app Config panel.

### Next.js

Needs `output: 'standalone'` in `next.config.js`, which produces a self-contained
`server.js`.

Wrinkle: standalone mode does not copy static assets or `public/`. Do it after build:

```
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public   2>/dev/null || true
```

Required env:

```
PORT=4002
HOSTNAME=0.0.0.0
```

Launch: `node .next/standalone/server.js`

Trap: skip the copy step and you get a running app with no CSS and 404ing images. This is
the classic "Next standalone looks broken" symptom.

## Databases

### Postgres

A saved `docker run`, executed once per project, never per deploy.

```
docker run -d \
  --name gobi-db \
  --restart unless-stopped \
  -e POSTGRES_PASSWORD=... \
  -e POSTGRES_DB=gobi \
  -v gobi-pgdata:/var/lib/postgresql/data \
  --network deploy-net \
  -p 127.0.0.1:5433:5432 \
  postgres:16
```

Correction to the original idea: apps run as **host processes** (not containers on
`deploy-net`), so a container-internal address like `gobi-db:5432` isn't reachable from
them. Publish the port to **localhost only** (`-p 127.0.0.1:<port>:5432`) — each database
gets its own host port from 5433 up — and the connection string uses `127.0.0.1:<port>`.
Binding to 127.0.0.1 keeps it off the public internet; the named volume survives redeploys.

**Hardening.** Each database hands out a scoped **non-superuser** role (`app`, owns the DB —
full DDL/DML + trusted extensions, but no `COPY … FROM PROGRAM` RCE); the `postgres`
superuser stays internal. **TLS** is on (self-signed cert, `sslmode=require`). Optionally
expose publicly (`-p 0.0.0.0:<port>`), gated by a source-**IP allowlist** enforced in the
`DOCKER-USER` iptables chain — because Docker's port publishing bypasses `ufw`.

### SQLite (not a deploy type)

There is no `sqlite` app type — SQLite isn't a service to deploy. If your app *uses* a SQLite
file, keep it on a path that persists across deploys (via the `persist` field), never inside
the build directory that gets replaced.

```
/srv/gobi-design/data/app.db   survives
/srv/gobi-design/build/app.db  wiped next deploy
```

Point the app's DB path at a stable `data/` dir. That's a `persist` convention, not a type.

## Project config & source of truth

An app is described by a handful of fields:

```yaml
name: gobi-design
type: vite              # or: react | adonis | nextjs | static
domain: gobi.design
postgres: gobi-db       # optional: names a provisioned db resource to wire in
```

**The source of truth is the SQLite state db** (`/var/lib/justdeploy/state.db`) — apps, env
vars, assigned ports, release/persist config, and deploy history all live there, written by
the CLI and the dashboard. A `justdeploy.yml` is an optional *input* to `add` (or a snapshot
you export), not a live record: the tool does not read yml files back on every deploy, and
editing one after the fact does nothing until you re-`add`.

This is a deliberate simplification, honestly stated. An earlier draft claimed "config in
files you own; SQLite is just a rebuildable index." That was aspirational — making the files
the true operational record (so `reconcile` could rebuild everything from them) is real work
that wasn't done, and pretending otherwise would be the dishonest spot. Since this is a
single user on a single box, one SQLite file as the record is fine. **The one obligation that
creates: back it up.** `state.db` and the app data volumes are the only irreplaceable state;
a periodic copy off-box is the safety net that the "files you own" story would have provided.

## Interface: one model, two front-ends

There is one source of truth (the state db) and one engine (the deploy loop). Two front-ends
sit on top; neither is privileged, and both write to the same db.

- **CLI.** `add`, `deploy`, `logs`, `env`, `set`, `rollback`, `rm`, `webhook`. The whole tool.
  No forms because you drive it from the terminal.
- **Dashboard (optional).** A control panel over the same engine: status, live logs, deploy /
  rollback / env / new-project. When it writes, it calls the same engine functions the CLI
  does. Close the dashboard and nothing is lost — the record is the db, not the UI.

### The "pick a type" onboarding (dashboard or `justdeploy add`)

The insight is that **the configuration moved into the type.** Coolify says "create a
generic application, configure everything, then deploy." This says "tell me what it is,
point me at the code, done." Whether that happens by clicking an icon or running
`justdeploy add --type vite --domain gobi.design <repo>`, the result is identical: a
config file is written and the loop runs.

Three steps:

1. **Pick the type.** One choice — icon click or `--type` flag — decides the build
   command, run command, serve model, and port assignment, because each type *is* one row
   of the framework table.
2. **Select the source.** A git repo (public URL, or connect a provider for the push
   webhook).
3. **Deploy.**

### What each type auto-fills

- **Adonis** generates `APP_KEY`, sets `HOST=0.0.0.0`, `PORT`, `NODE_ENV`. The env is
  pre-populated with the required vars; you only edit it to add your own.
- **Next** sets `HOSTNAME=0.0.0.0`, `PORT`, and silently runs the standalone
  asset-copy step, so the broken-CSS trap never happens.
- **React / Vite / static** configure nothing. Source and domain, then deploy.
- **Postgres** provisions the container and records a connection string. It is a resource
  you *add* (and reference via `postgres:` in an app's config), not a thing you deploy.

In the common case the only things a user supplies are the **domain** and, optionally,
their **own env vars**. Everything else the type knew.

This auto-fill is where the tool encodes the traps documented above so the user never hits
them — and it lives in the **engine**, so it works identically from the CLI. The dashboard
gets it for free; it is not a dashboard feature.

## The deploy loop

Identical for all types:

1. Pull from git
2. Run the build string for `type`
3. For proxy types: swap the process and patch Caddy
4. For static types: point Caddy at the new folder

The zero-downtime port swap for proxy types is the one part with real sequencing to get
right: start the new container on an ephemeral port, health-check it, repoint Caddy's
upstream, then drain and kill the old one. See `docs/port-swap.md` (to be written) for the
exact sequence — it is the only genuinely stateful operation in the tool.

## Deliberately deferred (the "upload a folder" question)

Static apps could accept a pre-built `dist/` upload instead of a repo. Tempting, but it is
a **second ingestion mode** — no git, no build step, no redeploy trigger — so it does not
fit "one row of the table." Deferred until the git path is solid. When added, it is
`accept tarball → extract → point Caddy`, kept explicitly separate from the deploy loop.

## Suggested stack

- **Runtime:** Docker (shell out to `docker build` / `docker run`)
- **Proxy + TLS:** Caddy, driven live via its admin API (POST JSON, no config-file reload)
- **State:** SQLite (`state.db`) — the source of truth: apps, env vars, domains, assigned
  ports, release/persist config, deploy history. Back it up; there is no rebuild-from-files.
- **Trigger:** a small webhook receiver catching git push (`POST /api/webhook`, HMAC-verified)
- **Front-ends:** a CLI as the primary interface, plus an optional dashboard over the same
  engine

Real and usable for a handful of apps in roughly 300 to 500 lines, with Docker and Caddy
doing the heavy lifting.

## Naming

Placeholder: **JustDeploy**, extrapolated from the existing Just X line (JustAPI, JustDB,
justphotobooks). Undecided. `gobi-design` throughout is a sample project standing in for
"some app you'd deploy," not part of the tool.
