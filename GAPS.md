# JustDeploy — Gaps & Roadmap

A third-person audit: what stops someone who **isn't the creator** from using JustDeploy as
a deployment platform. Written after a real deploy session (Coolify removed → JustDeploy
installed → dashboard → an AdonisJS app deployed) where every failure was diagnosed by
SSH-ing in, tailing raw logs, and querying SQLite by hand.

## The meta-gap

**Everything works when the creator is in the loop.** Each failure this session
(Adonis lockfile, missing env vars, un-run migrations, Better Auth's separate schema) was
diagnosed and fixed out-of-band by a human with full context — not by the platform. A
deployment platform's core value is handling those failure modes *for* the user. Right now
the platform doesn't; a person does, live. Every gap below is an instance of this.

## Where a third party gets stuck

- **Failures are opaque.** The dashboard shows a red dot; the CLI prints one error line. The
  real reason lives only in `/srv/<app>/logs/app.log`. No build logs stream during the deploy
  — it's a black box ending in ✅/❌.
- **`health check failed on port 4000` means nothing.** Env crash? Slow boot? DB not
  migrated? Bad bind? Indistinguishable. And a 500 on `/` (e.g. pre-migration) fails the check
  even when the process is fine.
- **Framework recipes must be pre-perfect, and users can't fix them.** The Adonis lockfile bug
  hits every Adonis user identically; the framework table is baked in source with no override
  or plugin path short of forking.
- **The DB-app story is undiscoverable.** Nothing detects "this app has a database" or prompts
  for `--release`/`--persist`. A new user deploys, gets a 500, and is stuck. Same for Better
  Auth's separate migration — pure tribal knowledge.
- **Private repos / git auth: no story.** First deploy failed on `could not read Username`. No
  deploy keys, no token flow; a private repo is dead in the water without manual SSH-key setup.

## Missing platform primitives (table stakes)

- **No auto-deploy.** "git push → deploys" — the headline DX of the incumbents — isn't built.
  Every deploy is a manual command/button.
- **No process supervision.** Proxy apps are detached PIDs. A runtime crash (not deploy-time)
  leaves the app down until someone notices. `reconcile` doesn't resurrect dead processes;
  systemd watches only the dashboard, not user apps.
- **No rollback.** "Redeploy the previous SHA" has no command, no UI, no stored artifact.
- **Postgres wiring is fake-automatic.** `pg` prints a connection string to hand-copy. The
  `postgres:` config key meant to auto-inject `DATABASE_URL` was never wired.
- **No backups.** State DB and app data volumes are unbacked. Box dies → everything's gone.

## Promise vs. reality — RESOLVED

The concept used to claim *"config files are the source of truth; SQLite is a rebuildable
index."* That wasn't true in the code. Resolved by owning it: **SQLite `state.db` is the source
of truth**, docs and comments were corrected, and the misleading `.yml` auto-write was removed.
The tradeoff this makes explicit: `state.db` is now the single irreplaceable record, so
**backups are the safety net** (see priority #4 below).

## Security & ops

- Dashboard runs **as root, executes arbitrary build scripts, gated by one password** — no
  login rate-limiting, no audit log, no 2FA. One brute-forced password = root RCE.
- Env/secrets (APP_KEY, DB passwords, API keys) are **plaintext in SQLite** and shown
  plaintext in the dashboard env editor.
- **No DNS pre-check** before ACME → a mis-pointed domain becomes a silent cert failure.

## Priority order (what unlocks "someone else can use it")

1. **Make failures self-service** — **[DONE]**
   - Failures diagnosed into a plain-English reason + fix hint (`src/diagnose.js`), stored on
     the deploy record and shown in the CLI (`why:` / `fix:`) and the dashboard (red card
     panel). On a health-check failure it reads the app log tail to find the real cause.
   - **Live streaming:** `sh.run` now streams build output to the log as it happens (was
     buffered `execSync`); a Server-Sent Events endpoint (`/api/apps/:name/stream`) tails the
     log file; the dashboard Logs modal renders it live via `EventSource` with a ● live
     indicator, and Deploy / New Project auto-open it so you watch the build stream in.
2. **Process supervision + rollback** — **[DONE]**
   - **Supervision:** the dashboard process runs a supervisor (`superviseOnce`, every 8s) that
     relaunches any proxy app whose process has died — runtime crash or a reboot that left a
     stale pid — via `engine.restart` (same port, no rebuild), with exponential backoff to
     avoid hammering a crash-looping app. Verified: `kill -9` → back up in ~6s.
   - **Rollback:** `justdeploy rollback <name>` and a dashboard Rollback button redeploy the
     previous successful commit. `sync()` now checks out an explicit SHA (latest `origin/HEAD`
     normally, a past SHA on rollback), so it works from the detached HEAD a rollback leaves.
3. **git-push webhook** — **[DONE]** an unauthenticated-but-verified endpoint on the dashboard
   (`POST /api/webhook`) accepts GitHub/GitLab/Gitea push payloads, verifies a GitHub-style
   HMAC signature (or a URL-embedded secret for providers without signing), and redeploys every
   app matching the pushed repo — only on the default branch, ignoring ping/non-push events.
   Enable + get setup with `justdeploy webhook`. Verified: valid push → deploy; bad sig → 401;
   ping → ignored; wrong branch → no-op.
4. **Config-truth claim** — **[DONE — resolved by decision]** SQLite `state.db` is now the
   acknowledged source of truth; docs (CONCEPT/port-swap) and code comments were rewritten to
   stop claiming "config in files you own," and the vestigial per-app `.yml` auto-write (to a
   random cwd, never read back) was removed. yml files are now purely an optional `add` input /
   export snapshot. **Consequence, now the top open item:** with SQLite as the single record,
   **backups matter** — `state.db` + app data volumes are the only irreplaceable state and are
   currently unbacked. A periodic off-box copy is the missing safety net.

## The honest framing

None of these are architectural dead-ends — they're all "wrap the engine that already
exists." But they are exactly the hard 20% the concept note said it would skip, and
"usable by someone who isn't you" lives almost entirely in that 20%. The real decision:
is this a sharp **personal tool** (then it's basically done) or a **platform others use**
(then the work so far was the easy part)?
