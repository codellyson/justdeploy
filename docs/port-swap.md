# Zero-downtime port swap (proxy types)

The one genuinely stateful operation in JustDeploy. Everything else in the deploy loop is
idempotent and order-free; this is not. It has a precise sequence, and every step has a
failure mode that must leave the *old* version serving traffic. The governing rule:

> **Never repoint Caddy at a process that has not passed a health check, and never kill the
> old process until the new one is serving.**

Applies only to `adonis` and `nextjs` (serve model = proxy). Static types skip this
entirely — they just repoint Caddy's `root` at the new folder, which is atomic and needs no
draining.

## State the tool tracks per app

Kept in SQLite (`state.db`, the source of truth). Ports are the only shared, contended resource.

| field         | meaning                                                        |
|---------------|---------------------------------------------------------------|
| `live_port`   | the port Caddy currently proxies to (the serving version)     |
| `live_pid`    | process / container id currently bound to `live_port`         |
| `domain`      | the Caddy site this app owns                                   |

Port allocation: increment from 4000, skip any port present as a `live_port` **or**
currently in an in-flight swap. Reserve the candidate port in the DB *before* starting the
process so two concurrent deploys can't pick the same one.

## The sequence

Let `OLD = {live_port, live_pid}` (may be empty on first deploy).

1. **Build** the new artifact (git pull → build string). Pure, no traffic impact. If it
   fails, abort — `OLD` is untouched and still serving.
2. **Allocate** a fresh `NEW.port` (reserve in DB) distinct from `OLD.live_port`.
3. **Start** the new process with `PORT=NEW.port` and the app's env. Capture `NEW.pid`.
   - Adonis: `cd build && node bin/server.js` with `HOST=0.0.0.0`.
   - Next: `node .next/standalone/server.js` with `HOSTNAME=0.0.0.0`.
4. **Health-check** `NEW.port` — poll `GET http://127.0.0.1:NEW.port<healthpath>` until it
   returns a non-5xx response, with a timeout (default 30s, ~15 attempts backing off).
   - **Fail path:** kill `NEW.pid`, release `NEW.port`, abort the deploy. `OLD` never moved.
5. **Repoint Caddy** — patch the app's upstream from `OLD.live_port` to `NEW.port` via the
   admin API (see below). This is the cutover instant. New connections now hit `NEW`.
6. **Commit** the new state in SQLite: `live_port = NEW.port`, `live_pid = NEW.pid`.
7. **Drain then kill OLD** — wait `drain_seconds` (default 10s) for in-flight requests on
   `OLD` to finish, then `SIGTERM` `OLD.pid` (escalate to `SIGKILL` after a grace period).
   Release `OLD.port` back to the pool.
   - If `OLD` was empty (first deploy), steps 7 is a no-op.

Only step 5 is observable to users, and it flips from one healthy process to another
healthy process. There is no window where Caddy points at nothing.

## Health check: what "healthy" means

Default: `GET /` and accept any status `< 500`. A 404 means the app is *up* (it answered);
a connection-refused or 5xx means it is not ready. Optional per-app override in config:

```yaml
health:
  path: /health      # default: /
  timeout: 30        # seconds, default 30
```

Do not require 200 — many apps 302 or 404 the root. The check is "is a Node process
accepting connections and returning HTTP," not "is the app logically correct."

## Repointing Caddy via the admin API

Caddy runs with its admin endpoint on `localhost:2019`. Each proxy app owns a reverse-proxy
handler whose upstream is a single dial address. The swap is a `PATCH` to that one field —
no full-config reload, no dropped connections.

Give each app's upstream a stable `@id` when first created so later swaps address it
directly:

```
PATCH http://localhost:2019/id/<app>-upstream
Content-Type: application/json

{ "dial": "127.0.0.1:4103" }
```

Caddy applies this atomically and keeps existing connections on the old dial until they
close — which is exactly why step 7 drains before killing. If the app's Caddy route does not
exist yet (first deploy), POST the whole site block instead of PATCHing; TLS provisioning
starts the moment the block exists.

## Failure matrix

| fails at            | who is serving after   | cleanup                                  |
|---------------------|------------------------|------------------------------------------|
| build (1)           | OLD                    | none — nothing started                   |
| start (3)           | OLD                    | release NEW.port                         |
| health check (4)    | OLD                    | kill NEW.pid, release NEW.port           |
| Caddy PATCH (5)     | OLD                    | kill NEW.pid, release NEW.port, log loud |
| after commit (6)    | NEW                    | drain/kill OLD as normal                 |
| drain/kill (7)      | NEW                    | OLD may linger — reap orphan by port     |

The invariant every row preserves: **someone healthy is always serving `domain`.** A failed
deploy is a no-op from the user's perspective, not an outage.

## Crash recovery

SQLite (`state.db`) is the source of truth; on startup, reconcile the running processes
against it. This is implemented as the dashboard's supervisor loop:

- For each proxy app, check whether `live_pid` is alive. If dead (runtime crash, or a reboot
  that left a stale pid), restart the process on `live_port` — no rebuild, Caddy already
  points there. Exponential backoff avoids hammering a crash-looping app. (See
  `engine.restart` + `superviseOnce` in `dashboard.js`.)

Note: `state.db` itself is not rebuildable from anything — it is the record. Back it up; it and
the app data volumes are the only irreplaceable state.

## What this deliberately does NOT do

- **No rollback history.** "Rollback" = redeploy the previous git SHA through the same loop.
  No stored artifacts, no version stack.
- **No connection-draining beyond a fixed timer.** A single `drain_seconds` wait, not active
  connection counting. Single user, small apps — good enough.
- **No blue/green pair kept warm.** The old process dies after each deploy. We spin a new one
  per deploy; we don't keep two live indefinitely.
