#!/usr/bin/env bash
# JustDeploy one-command installer for a fresh Debian/Ubuntu VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/codellyson/justdeploy/master/install.sh | bash
#
# It installs the one dependency JustDeploy needs to run itself — Node ≥ 22.5 — then clones
# the repo, links the `justdeploy` CLI, and hands off to `justdeploy setup`, which installs
# and wires up everything else (Caddy + Docker). Re-running is safe: each step checks first.
set -euo pipefail

REPO="${JUSTDEPLOY_REPO:-https://github.com/codellyson/justdeploy}"
DIR="${JUSTDEPLOY_DIR:-/opt/justdeploy}"

say() { printf '\033[36m→\033[0m %s\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this installer supports Linux (Debian/Ubuntu) only."
command -v apt-get >/dev/null 2>&1 || die "this installer needs apt-get (Debian/Ubuntu)."
[ "$(id -u)" = "0" ] || die "run as root:  curl -fsSL <url> | sudo bash"

# --- Node >= 22.5 --------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'
}
if node_ok; then
  say "Node $(node --version) already present."
else
  say "installing Node 22 (NodeSource)…"
  apt-get update
  apt-get install -y ca-certificates curl gnupg git
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# --- JustDeploy ----------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "updating existing checkout at $DIR…"
  git -C "$DIR" pull --ff-only
else
  say "cloning JustDeploy into $DIR…"
  command -v git >/dev/null 2>&1 || apt-get install -y git
  git clone "$REPO" "$DIR"
fi

say "linking the justdeploy CLI…"
( cd "$DIR" && npm link >/dev/null 2>&1 ) || ln -sf "$DIR/bin/justdeploy" /usr/local/bin/justdeploy

# --- hand off to setup (installs Caddy + Docker) -------------------------
say "running justdeploy setup…"
echo ""
justdeploy setup "$@"
