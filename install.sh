#!/usr/bin/env bash
# DROP install / upgrade script
# Usage:
#   sudo bash install.sh                  # fresh install
#   sudo bash install.sh --upgrade        # force upgrade
#   sudo bash install.sh --dir=/opt/drop --root=/var/drop --branch=develop
#   sudo bash install.sh --link           # also run npm link (for CLI access)
#
#   # Public the platform on a real domain with automatic HTTPS:
#   sudo bash install.sh --domain=example.com --https --acme-email=you@example.com
#     • apps are served at  https://<app>.example.com
#     • the apex (example.com) serves the DROP dashboard
#   These settings persist in /etc/drop/drop.env and survive upgrades/deploys.
set -euo pipefail

# Force a root-owned, non-group-writable PATH before anything else runs.
# Every helper below resolves systemctl/install/visudo/setcap/caddy/node/etc.
# through PATH by bare name, and sudo's secure_path typically starts with
# /usr/local/sbin:/usr/local/bin — the latter (like /usr/local/sbin) is
# root:staff 2775 on stock Debian/Ubuntu, so anything writable there by a
# 'staff'-group member could otherwise shadow a system binary this script (or
# the root-owned $PROVISION_BIN copy of it, run via sudo) resolves and execs
# as root. Assigning PATH here overrides whatever was inherited, regardless
# of how this script was invoked.
PATH=/usr/sbin:/usr/bin:/sbin:/bin

# BASH_SOURCE[0] is unset when this script is read from stdin (e.g.
# `curl ... | bash`) — under `set -u` that would die two lines below with an
# opaque "unbound variable" error, before argument parsing even runs, and (if
# `set -u` were ever relaxed) silently produce an empty $SELF instead. Either
# way, fail loudly and actionably here: a piped invocation has no on-disk
# file for install_provision_script (DROP-071) to seed $PROVISION_BIN from,
# and skipping that seed is NOT a safe fallback — the box would still expect
# --provision to work, and there is nothing else it could point at except the
# drop-writable legacy path this fix removes. See docs/HETZNER-DEPLOY.md for
# the save-then-run form.
if [[ -z "${BASH_SOURCE[0]:-}" ]]; then
  echo "DROP's install.sh must be run from a saved file, not piped (e.g. curl | bash)." >&2
  echo "Save it first, then run it, e.g.:" >&2
  echo "  curl -fsSL <url> -o install.sh && sudo bash install.sh [flags]" >&2
  exit 1
fi
# Absolute path to the currently-executing copy of this script, resolved once
# up front (BASH_SOURCE[0] may be relative, e.g. "install.sh" when invoked as
# `bash install.sh`). install_provision_script() (DROP-071) later reads
# $SELF's on-disk bytes to seed/refresh the root-owned provisioning script —
# by the time it does, on --upgrade, fetch_code has already git-pulled fresh
# content onto this same path, so that read still picks up what root just
# pulled, not a stale in-memory copy of this script.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

REPO_URL="https://github.com/JulesNsenda/drop.git"
INSTALL_DIR="/opt/drop"
DROP_ROOT="/var/drop"
DROP_USER="drop"
BRANCH="main"
SERVICE_NAME="drop-platform"
API_PORT="3000"
ENV_FILE="/etc/drop/drop.env"
# Root-owned copy of this script that the sudoers --provision rule targets
# (DROP-071). Lives outside $INSTALL_DIR — which is chown'd to $DROP_USER, see
# ensure_root_dir/fetch_code — in a directory the drop user cannot write to.
PROVISION_BIN="/usr/local/sbin/drop-provision"
UPGRADE=false
DO_LINK=false
PROVISION=false
BOOTSTRAP=false
DOMAIN=""
ACME_EMAIL=""
ENABLE_HTTPS=false
DEPLOY_PUBKEY=""
ISOLATION=""       # "docker" to enable container isolation; empty to leave unchanged

# ── colour helpers ───────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[DROP]${NC} $*"; }
warn()  { echo -e "${YELLOW}[DROP]${NC} $*"; }
error() { echo -e "${RED}[DROP]${NC} $*" >&2; exit 1; }

# apt-get wrapper: wait up to 5 min for the dpkg lock so we don't race the
# unattended-upgrades / apt-daily jobs that run on a freshly-booted box.
# DEBIAN_FRONTEND=noninteractive keeps apt from opening a dialog (debconf or a
# needrestart service prompt) on a TTY-less deploy SSH session, where it would
# hang until the job times out rather than fail fast.
aptget() { DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 "$@"; }

# ── argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --upgrade)         UPGRADE=true ;;
    --provision)       PROVISION=true ;;
    --bootstrap)       BOOTSTRAP=true ;;
    --link)            DO_LINK=true ;;
    --https)           ENABLE_HTTPS=true ;;
    --dir=*)           INSTALL_DIR="${1#*=}" ;;
    --root=*)          DROP_ROOT="${1#*=}" ;;
    --user=*)          DROP_USER="${1#*=}" ;;
    --branch=*)        BRANCH="${1#*=}" ;;
    --domain=*)        DOMAIN="${1#*=}" ;;
    --acme-email=*)    ACME_EMAIL="${1#*=}" ;;
    --deploy-pubkey=*) DEPLOY_PUBKEY="${1#*=}" ;;
    --port=*)          API_PORT="${1#*=}" ;;
    --isolation=*)     ISOLATION="${1#*=}" ;;
    *) error "Unknown option: $1 (try --bootstrap, --upgrade, --provision, --domain=, --https, --acme-email=, --deploy-pubkey=, --isolation=docker, --dir=, --root=, --branch=, --link)" ;;
  esac
  shift
done

[[ $EUID -ne 0 ]] && error "Run as root: sudo bash install.sh"

# Auto-detect upgrade when install dir already contains a clone
[[ -d "$INSTALL_DIR/.git" ]] && UPGRADE=true

# ── Node.js ──────────────────────────────────────────────────────────────────
ensure_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -e "console.log(parseInt(process.version.slice(1)))" 2>/dev/null || echo 0)
    if [[ $ver -ge 20 ]]; then
      info "Node.js $(node --version) already installed"
      return 0
    fi
    warn "Node.js $ver found — need 20+, upgrading via NodeSource..."
  else
    info "Node.js not found — installing via NodeSource..."
  fi
  if ! command -v curl &>/dev/null; then
    aptget update -qq && aptget install -y curl
  fi
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  aptget install -y nodejs
  info "Node.js $(node --version) installed"
}

# ── build tools (native npm deps: bcrypt) ────────────────────────────────────
# bcrypt is a native runtime dependency; CI's `npm ci` compiles it on the box, so
# a freshly-bootstrapped server needs a C toolchain present even though the build
# itself happens during deploy.
# python3-venv is what lets a Python app build at all under isolation:none:
# the builder installs deps into an in-app-dir `.venv`, and on Debian/Ubuntu
# `python3 -m venv` fails with "ensurepip is not available" unless python3-venv
# is present. Debian's bare `python3` ships neither venv nor pip, which is why
# this must be provisioned rather than assumed.
# No python3-pip on purpose: python3-venv brings ensurepip, so each app's
# .venv gets its own pip, and every command the builder emits goes through
# `.venv/bin/python -m pip`. A system-wide pip would only add a way for an
# install to land outside the app dir and still look like it worked.
ensure_build_tools() {
  if dpkg -s build-essential &>/dev/null \
    && dpkg -s python3-venv &>/dev/null \
    && command -v python3 &>/dev/null; then
    info "Build tools already installed"
    return 0
  fi
  info "Installing build tools (build-essential, python3, python3-venv)..."
  # Refresh the index first: on an already-bootstrapped server this runs from
  # the deploy's --provision pass, where the cached lists can be months stale
  # and would resolve python3-venv to a version that no longer exists.
  aptget update -qq
  aptget install -y build-essential python3 python3-venv
}

# ── Docker Engine (container isolation) ─────────────────────────────────────
# Installs Docker Engine from the official apt repo (not the snap/distro pkg).
# Adds the DROP service user to the 'docker' group so it can manage containers.
# Call only when --isolation=docker is passed.
ensure_docker() {
  if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    info "Docker Engine already installed and running"
  else
    info "Installing Docker Engine (official apt repo)..."
    aptget install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list
    aptget update -qq
    aptget install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    info "Docker Engine installed"
  fi

  # Add the DROP service user to the 'docker' group so it can manage containers
  # without sudo. The service must be restarted after this for the group change to
  # take effect — handled in the run section below.
  if ! groups "$DROP_USER" 2>/dev/null | grep -q '\bdocker\b'; then
    info "Adding $DROP_USER to the 'docker' group..."
    usermod -aG docker "$DROP_USER"
  fi

  # Pre-pull the base images used by DROP so the first container start is fast.
  info "Pre-pulling DROP base images (this may take a few minutes)..."
  for img in node:20-slim python:3.12-slim nginx:alpine golang:1.22-alpine; do
    docker pull "$img" 2>&1 | tail -1 || warn "Failed to pre-pull $img — will retry on first deploy"
  done
}

# ── system user ──────────────────────────────────────────────────────────────
ensure_user() {
  if ! id -u "$DROP_USER" &>/dev/null; then
    info "Creating system user '$DROP_USER'..."
    useradd -m -s /bin/bash "$DROP_USER"
  fi
}

# ── CI deploy key ────────────────────────────────────────────────────────────
# Seed the GitHub Actions deploy public key into the drop user's authorized_keys
# so the CI pipeline (deploy.yml) can scp the build artifact and restart the
# service over SSH. Idempotent — only appends if the key isn't already present.
seed_deploy_key() {
  [[ -z "$DEPLOY_PUBKEY" ]] && return 0
  local ssh_dir="/home/$DROP_USER/.ssh"
  local auth="$ssh_dir/authorized_keys"
  info "Seeding CI deploy public key into $auth..."
  mkdir -p "$ssh_dir"
  touch "$auth"
  if ! grep -qF "$DEPLOY_PUBKEY" "$auth" 2>/dev/null; then
    echo "$DEPLOY_PUBKEY" >> "$auth"
  fi
  chmod 700 "$ssh_dir"
  chmod 600 "$auth"
  chown -R "$DROP_USER:$DROP_USER" "$ssh_dir"
}

# ── postgresql (system package — avoids EDB binary download) ─────────────────
ensure_postgres() {
  if ls /usr/lib/postgresql/*/bin/postgres &>/dev/null 2>&1; then
    info "PostgreSQL already installed"
    return 0
  fi
  info "Installing PostgreSQL via apt..."
  aptget install -y postgresql
  systemctl stop postgresql || true
  systemctl disable postgresql || true
  info "PostgreSQL installed (managed by DROP, not systemd)"
}

# ── Caddy (reverse proxy + automatic HTTPS) ──────────────────────────────────
# DROP spawns and manages its own Caddy process, so we install the binary but
# disable the packaged systemd service, and grant the binary cap_net_bind_service
# so the non-root drop user's Caddy can bind :80/:443.
ensure_caddy() {
  if ! command -v caddy &>/dev/null; then
    info "Installing Caddy..."
    aptget install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    aptget update -qq
    aptget install -y caddy
  else
    info "Caddy already installed"
  fi
  # DROP manages the Caddy process itself — keep the packaged service out of the way.
  systemctl disable --now caddy &>/dev/null || true
  # Let the non-root drop user's Caddy bind privileged ports 80/443.
  if ! command -v setcap &>/dev/null; then
    aptget install -y libcap2-bin || true
  fi
  local caddy_bin; caddy_bin="$(command -v caddy)"
  if command -v setcap &>/dev/null && [[ -n "$caddy_bin" ]]; then
    setcap 'cap_net_bind_service=+ep' "$caddy_bin" \
      || warn "setcap failed — Caddy may not bind :80/:443 as the '$DROP_USER' user"
  fi
}

# ── logind RemoveIPC ─────────────────────────────────────────────────────────
# systemd-logind's default RemoveIPC=yes deletes ALL POSIX/SysV shared memory
# owned by a non-system user the moment that user's last login session ends —
# even while a system service still runs as that user. The bundled PostgreSQL
# runs as $DROP_USER (a regular useradd user), and CI deploys SSH in and out
# as that same user, so every deploy wiped the live server's dynamic shared
# memory ("could not open shared memory segment /PostgreSQL.N: No such file or
# directory" on the next parallel query). RemoveIPC=no is the fix PostgreSQL's
# own docs prescribe for running as a non-system user under systemd.
ensure_removeipc_off() {
  local dropin_dir="/etc/systemd/logind.conf.d"
  local dropin="$dropin_dir/99-drop-removeipc.conf"
  if grep -qs '^RemoveIPC=no' "$dropin"; then
    return 0
  fi
  info "Disabling systemd-logind RemoveIPC (protects the bundled PostgreSQL)..."
  mkdir -p "$dropin_dir"
  cat > "$dropin" << 'EOF'
# Written by DROP install.sh — do not remove.
# The bundled PostgreSQL runs as a regular (non-system) user; logind's default
# RemoveIPC=yes would delete its shared memory whenever that user's last SSH
# session ends, breaking queries with "could not open shared memory segment".
[Login]
RemoveIPC=no
EOF
  # logind does not re-read its config on HUP; restart it so the setting takes
  # effect now. Safe on a headless box — active sessions (including the one
  # running this script) survive a logind restart via /run/systemd state.
  systemctl restart systemd-logind \
    || warn "Could not restart systemd-logind — RemoveIPC=no takes effect after reboot"
}

# ── platform config (domain / HTTPS) — persisted, survives upgrades & deploys ─
# Written to an EnvironmentFile that systemd re-reads on every start, so config
# changes take effect on the next service restart without rewriting the unit.
# Only keys passed as flags are touched; existing keys are preserved.
write_env_config() {
  if [[ -z "$DOMAIN" && -z "$ACME_EMAIL" && "$ENABLE_HTTPS" != "true" && -z "$ISOLATION" ]]; then
    return 0
  fi
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  upsert() {
    local k="$1" v="$2"
    if grep -q "^${k}=" "$ENV_FILE" 2>/dev/null; then
      sed -i "s|^${k}=.*|${k}=${v}|" "$ENV_FILE"
    else
      echo "${k}=${v}" >> "$ENV_FILE"
    fi
  }
  [[ -n "$DOMAIN" ]]              && upsert DROP_DOMAIN_SUFFIX "$DOMAIN"
  [[ "$ENABLE_HTTPS" == "true" ]] && upsert DROP_ENABLE_HTTPS true
  [[ -n "$ACME_EMAIL" ]]         && upsert DROP_ACME_EMAIL "$ACME_EMAIL"
  [[ -n "$ISOLATION" ]]          && upsert DROP_ISOLATION "$ISOLATION"
  # 600, root-owned: systemd reads EnvironmentFile as root before dropping
  # privileges, so tenant apps (and other local users) can't read ACME email or
  # any future secrets persisted here.
  chmod 600 "$ENV_FILE"
  info "Platform config written to $ENV_FILE"
}

# Resolve the configured domain suffix: explicit flag wins, else read the
# persisted env file (so --provision deploys keep routing the apex correctly).
resolve_domain() {
  if [[ -z "$DOMAIN" && -f "$ENV_FILE" ]]; then
    DOMAIN="$(sed -n 's|^DROP_DOMAIN_SUFFIX=||p' "$ENV_FILE" | tail -n1)"
  fi
}

# Resolve whether HTTPS is enabled: explicit --https flag wins, else read the
# persisted DROP_ENABLE_HTTPS so --provision deploys keep the apex on the right
# scheme/port.
resolve_https() {
  [[ "$ENABLE_HTTPS" == "true" ]] && return 0
  if [[ -f "$ENV_FILE" ]] \
    && [[ "$(sed -n 's|^DROP_ENABLE_HTTPS=||p' "$ENV_FILE" | tail -n1)" == "true" ]]; then
    ENABLE_HTTPS=true
  fi
}

# ── apex route: serve the DROP dashboard/API at the bare domain over HTTPS ─────
# DROP imports hosts/*.caddy and never rewrites hand-managed files there, so this
# persists. Apps are still served at <app>.<domain> via the domain suffix.
ensure_apex_route() {
  resolve_domain
  [[ -z "$DOMAIN" ]] && return 0
  resolve_https
  # In HTTP-only mode bind the apex explicitly on :80 (http://). A bare hostname
  # makes Caddy serve the site on :443, which has no certificate until HTTPS is
  # enabled — so plain HTTP would never be served. With HTTPS on, the bare
  # hostname lets Caddy auto-manage the cert and add the :80→:443 redirect.
  local site="$DOMAIN"
  [[ "$ENABLE_HTTPS" != "true" ]] && site="http://$DOMAIN"
  local hosts_dir="$DROP_ROOT/data/appconf/caddy/hosts"
  info "Routing apex $site → dashboard (localhost:$API_PORT)..."
  mkdir -p "$hosts_dir"
  cat > "$hosts_dir/${DOMAIN}.caddy" <<EOF
# Managed by install.sh — the apex domain serves the DROP dashboard/API.
# Delete this file to stop routing $DOMAIN to the control plane.
${site} {
    encode gzip zstd
    reverse_proxy localhost:${API_PORT}
}
EOF
  chown -R "$DROP_USER:$DROP_USER" "$hosts_dir"
}

# ── runtime dir: ensure DROP_ROOT exists and is owned by the service user ─────
ensure_root_dir() {
  mkdir -p "$DROP_ROOT"
  chown "$DROP_USER:$DROP_USER" "$DROP_ROOT"
  # Platform state dir holds secrets.json, encryption.key, api-credentials.json and
  # the Postgres superuser password file — restrict listing to the drop user only.
  mkdir -p "$DROP_ROOT/data/drop-svc"
  chmod 700 "$DROP_ROOT/data/drop-svc"
  chown -R "$DROP_USER:$DROP_USER" "$DROP_ROOT/data"
}

# ── root-owned provisioning script (DROP-071) ────────────────────────────────
# $INSTALL_DIR is chown'd to $DROP_USER (ensure_root_dir/fetch_code), and under
# DROP_ISOLATION=none that's the same OS user tenant apps run as — so a
# compromised app could rewrite $INSTALL_DIR/install.sh and, if the sudoers
# --provision rule ever pointed there, get root to execute whatever it wrote,
# unconditionally, any time it chose to. $PROVISION_BIN is a COPY of this
# script (not a wrapper that execs $INSTALL_DIR/install.sh — a wrapper would
# just re-introduce the same hole under a new name) installed outside
# $INSTALL_DIR, root:root 0755, in a directory the drop user cannot write to.
#
# Defence in depth, not a full drop-is-non-root-equivalent claim: this closes
# ONE way $DROP_USER could reach root (rewrite install.sh, ride the sudoers
# rule). Under DROP_ISOLATION=docker, ensure_docker adds $DROP_USER to the
# 'docker' group so it can manage containers — and docker-group membership is
# itself a second, independent root-equivalent door (e.g.
# `docker run -v /:/mnt alpine chroot /mnt sh`), unaffected by anything here.
# On a DROP_ISOLATION=docker box (dropkit.sh included), this fix removes one
# of two doors, not the only one. It IS the only door on DROP_ISOLATION=none
# boxes (no docker group involved there), which is why it's worth shipping
# regardless — just don't read it as "drop is no longer root-equivalent".
#
# Trust chain: this function only ever runs on paths that are ALREADY
# root-authenticated by something other than the drop-reachable NOPASSWD rule
# — --bootstrap, a fresh install, and --upgrade, all of which require a real
# interactive `sudo`/root session (see the "run" section below). It is
# deliberately NOT called unconditionally from provision_system(), which is
# also reachable via the --provision sudoers rule: if it were, a drop-level
# actor could rewrite $INSTALL_DIR/install.sh and simply invoke --provision
# themselves to get that content copied into $PROVISION_BIN and executed —
# the exact vulnerability this is meant to close, just renamed. The one
# exception is a seed-if-missing guard in provision_system() for migrating an
# already-bootstrapped box off the old rule — see write_sudoers below.
#
# This does mean provisioning-logic changes no longer ride along on every
# ordinary CI deploy the way they used to: only --bootstrap/--upgrade/install
# refresh $PROVISION_BIN. A deploy that only runs --provision keeps re-applying
# whatever provisioning logic was last installed that way. Closing that gap
# without giving it up would require root to distinguish CI-authored bytes
# from drop-authored bytes — which needs either a secret the drop user cannot
# read (e.g. a CI-held HMAC key checked against a root-only key file) or a
# deploy channel that authenticates as root directly, neither of which exists
# today. That's a bigger change than this fix; this trades per-deploy
# freshness for closing the install.sh-rewrite escalation path.
#
# Operational contract: provisioning-logic changes (systemd unit, Caddy,
# sudoers, apex route) require a root-authenticated run of --bootstrap or
# --upgrade; deploys that only run --provision will NOT apply them. deploy.yml
# runs an advisory (unauthenticated, non-fatal) sha256sum comparison against
# the shipped install.sh so that staleness is visible rather than silent.
install_provision_script() {
  info "Installing root-owned provisioning script to $PROVISION_BIN..."
  harden_provision_dir
  # GNU install refuses to copy a file onto itself — true when this IS
  # already $PROVISION_BIN (e.g. an operator running
  # `sudo bash /usr/local/sbin/drop-provision --upgrade` directly). Skip the
  # no-op rather than aborting: this runs after fetch_code/build_drop, and an
  # abort here would leave the box mid-upgrade — code rebuilt, provisioning
  # not yet (re)applied.
  [[ "$SELF" -ef "$PROVISION_BIN" ]] || install -o root -g root -m 0755 "$SELF" "$PROVISION_BIN"
}

# Root-owned, non-group-writable home for $PROVISION_BIN. Called
# unconditionally, every time — not just when (re)installing the script —
# because /usr/local/sbin is root:staff 2775 on stock Debian/Ubuntu (any
# 'staff'-group member can write there) until this hardens it. If hardening
# only ran when the seed guard below decided to reinstall, a directory left
# group-writable from before this fix ever ran could let a 'staff'-group
# member plant something at $PROVISION_BIN ahead of the check, which would
# then read as already-trusted and never get hardened or overwritten.
harden_provision_dir() {
  install -d -o root -g root -m 0755 "$(dirname "$PROVISION_BIN")"
}

# True only if $PROVISION_BIN is a root-owned REGULAR file — not a symlink.
# `-x` alone follows symlinks and asserts nothing about ownership: a symlink
# planted at $PROVISION_BIN pointing at $INSTALL_DIR/install.sh (drop-
# writable) would satisfy `-x`, which would both skip the reseed below AND
# leave the sudoers rule pointed at a symlink sudo happily follows onto
# drop-authored content — root would execute it just the same.
provision_bin_is_trusted() {
  [[ -f "$PROVISION_BIN" && ! -L "$PROVISION_BIN" ]] || return 1
  [[ "$(stat -c %u "$PROVISION_BIN")" == "0" ]]
}

# ── sudoers: let drop user start/stop the service (needed for CI deploy) ─────
write_sudoers() {
  local f="/etc/sudoers.d/${DROP_USER}-deploy"
  local tmp
  # Staged in the SAME directory as $f (not /tmp), so the `mv -f` below is a
  # same-filesystem rename — atomic. Writing straight into $f (even via a
  # copy validated beforehand) risks a truncated file if interrupted mid-copy,
  # and a truncated /etc/sudoers.d/${DROP_USER}-deploy makes sudo refuse
  # everything for everyone, not just this rule.
  tmp="$(mktemp "${f}.XXXXXX")"
  info "Writing sudoers rule for $DROP_USER..."
  {
    # (root), not (ALL): none of these commands ever need to run as a target
    # user other than root, so don't grant the option.
    echo "${DROP_USER} ALL=(root) NOPASSWD: /bin/systemctl stop ${SERVICE_NAME}"
    echo "${DROP_USER} ALL=(root) NOPASSWD: /bin/systemctl start ${SERVICE_NAME}"
    echo "${DROP_USER} ALL=(root) NOPASSWD: /bin/systemctl restart ${SERVICE_NAME}"
    echo "${DROP_USER} ALL=(root) NOPASSWD: /bin/systemctl status ${SERVICE_NAME}"
    # Let the CI deploy re-apply system provisioning (Caddy, unit, env, apex
    # route) by running the root-owned provisioning script — see
    # install_provision_script above for why it's a copy at $PROVISION_BIN
    # rather than $INSTALL_DIR/install.sh. The interpreter is pinned to an
    # absolute, root-owned /usr/bin/bash (not left to $PROVISION_BIN's own
    # #!/usr/bin/env bash shebang): sudo resolves an unqualified command
    # through secure_path, whose /usr/local/bin entry is group-writable by
    # 'staff' on stock Debian/Ubuntu, so an unqualified `bash` could resolve
    # to something other than the real interpreter. deploy.yml's invocation
    # must match this exactly (interpreter + path + args) or sudo will refuse
    # it. By the time this line runs, provision_system has already guaranteed
    # $PROVISION_BIN exists via harden_provision_dir/provision_bin_is_trusted
    # above — there is no legacy fallback rule here to fall open to.
    echo "${DROP_USER} ALL=(root) NOPASSWD: /usr/bin/bash ${PROVISION_BIN} --provision"
  } > "$tmp"
  chmod 0440 "$tmp"
  # Validate before this ever becomes the live file — a malformed rule here
  # would otherwise briefly lock out provisioning (and, for the systemctl
  # lines, the CI deploy's stop/start/restart too).
  if ! visudo -c -f "$tmp"; then
    rm -f "$tmp"
    error "sudoers syntax error — check the generated rule"
  fi
  mv -f "$tmp" "$f"
}

# ── code: clone or pull ──────────────────────────────────────────────────────
fetch_code() {
  if $UPGRADE; then
    info "Pulling latest code (branch: $BRANCH)..."
    sudo -u "$DROP_USER" git -C "$INSTALL_DIR" fetch origin
    sudo -u "$DROP_USER" git -C "$INSTALL_DIR" checkout "$BRANCH"
    sudo -u "$DROP_USER" git -C "$INSTALL_DIR" pull origin "$BRANCH"
  else
    info "Cloning DROP into $INSTALL_DIR..."
    git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    chown -R "$DROP_USER:$DROP_USER" "$INSTALL_DIR"
  fi
}

# ── build ────────────────────────────────────────────────────────────────────
build_drop() {
  info "Installing server dependencies..."
  sudo -u "$DROP_USER" bash -c "cd '$INSTALL_DIR' && npm ci"
  info "Building server..."
  sudo -u "$DROP_USER" bash -c "cd '$INSTALL_DIR' && npm run build:server"
  if [[ -f "$INSTALL_DIR/src/dashboard/package.json" ]]; then
    info "Installing dashboard dependencies..."
    sudo -u "$DROP_USER" bash -c "cd '$INSTALL_DIR/src/dashboard' && npm ci"
    info "Building dashboard..."
    sudo -u "$DROP_USER" bash -c "cd '$INSTALL_DIR/src/dashboard' && npm run build"
    # Public marketing site (landing/docs/reference, DROP-070) — a separate
    # Vite build from the dashboard above (vite.site.config.ts), same
    # dependencies. Each writes into its own dist/dashboard / dist/site
    # subdirectory with its own emptyOutDir, so ordering between the two
    # builds is free; kept after the dashboard build here only to match CI
    # (deploy.yml) so the two can't drift apart.
    info "Building site..."
    sudo -u "$DROP_USER" bash -c "cd '$INSTALL_DIR/src/dashboard' && npm run build:site"
  fi
  if $DO_LINK; then
    info "Linking CLI globally (drop command)..."
    bash -c "cd '$INSTALL_DIR' && npm link"
  fi
}

# ── systemd service ──────────────────────────────────────────────────────────
write_service() {
  local node_bin
  node_bin=$(command -v node)

  # Determine the effective isolation mode: flag > env file > default (none).
  local eff_isolation="${ISOLATION}"
  if [[ -z "$eff_isolation" && -f "$ENV_FILE" ]]; then
    eff_isolation="$(sed -n 's|^DROP_ISOLATION=||p' "$ENV_FILE" | tail -n1)"
  fi

  # When running Docker isolation, the platform must start after Docker.
  local docker_deps=""
  if [[ "$eff_isolation" == "docker" ]]; then
    docker_deps=$'\nAfter=docker.service\nRequires=docker.service'
  fi

  info "Writing systemd service $SERVICE_NAME..."
  cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF
[Unit]
Description=DROP Platform
After=network.target${docker_deps}

[Service]
Type=simple
User=$DROP_USER
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
Environment=DROP_ROOT=$DROP_ROOT
# Optional domain/HTTPS/isolation config. The leading '-' makes it optional;
# systemd re-reads it on every start, so deploys pick up config changes
# without a daemon-reload.
EnvironmentFile=-$ENV_FILE
ExecStart=$node_bin $INSTALL_DIR/dist/index.js serve
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
}

# ── system provisioning (root-level, no code build) ──────────────────────────
# Idempotent. Re-run on every deploy via `install.sh --provision` (through
# $PROVISION_BIN, see install_provision_script) so that infra changes in this
# script (Caddy, the systemd unit, the apex route) land on the server without
# a manual install. Code itself is shipped as a prebuilt artifact. Note this
# only picks up provisioning-logic changes as of the last --bootstrap/
# --upgrade/install — a deploy that only ever runs --provision re-applies
# whatever was last installed into $PROVISION_BIN, not necessarily this
# deploy's install.sh (DROP-071 trade-off, see install_provision_script).
provision_system() {
  ensure_root_dir
  ensure_caddy
  ensure_removeipc_off
  write_env_config
  write_service      # (re)writes the unit + daemon-reload + enable
  # DROP-071 migration only: seed $PROVISION_BIN if it's missing. This is what
  # lets a box still running the pre-DROP-071 sudoers rule (which targets
  # $INSTALL_DIR/install.sh directly) converge the very first time --provision
  # runs after the fix ships — see write_sudoers for the rule this feeds. It
  # never overwrites an existing copy, so it can't become a self-refresh path:
  # once $PROVISION_BIN exists, a drop-level actor invoking --provision has no
  # way to change what's in it (root-owned dir, drop can't write or unlink).
  # Ongoing refreshes only happen on --bootstrap/--upgrade/install, below.
  #
  # Harden the directory FIRST, unconditionally: /usr/local/sbin ships
  # root:staff 2775 on stock Debian/Ubuntu, so hardening it only from inside
  # the branch the check can skip leaves the check protecting itself. And test
  # with provision_bin_is_trusted, not `-x`: `-x` follows symlinks and asserts
  # nothing about ownership, so a symlink planted at $PROVISION_BIN pointing at
  # the drop-writable $INSTALL_DIR/install.sh would satisfy it — the seed would
  # be skipped, write_sudoers would emit a rule naming the symlink, and sudo
  # (which stats through it) would hand root the drop-writable target. That is
  # this whole ticket's vulnerability wearing a new filename.
  harden_provision_dir
  provision_bin_is_trusted || install_provision_script
  write_sudoers
  ensure_apex_route
}

# ── run ──────────────────────────────────────────────────────────────────────
if $BOOTSTRAP; then
  # First-boot system provisioning only — NO code fetch/build/start. The CI
  # pipeline (deploy.yml) ships the built artifact over SSH and starts the
  # service. Use this to stand up a fresh box that CI then deploys to.
  info "Bootstrapping system (no code fetch — CI will deploy the app)..."
  ensure_node
  ensure_postgres
  ensure_user
  ensure_build_tools
  [[ "$ISOLATION" == "docker" ]] && ensure_docker
  ensure_root_dir
  seed_deploy_key
  # CI (deploy.yml) untars the build artifact into $INSTALL_DIR and runs
  # `install.sh --provision` from there, so the dir must exist and be owned by the
  # drop user before the first deploy. The bootstrap fetches no code itself.
  info "Preparing install directory $INSTALL_DIR for CI deploys..."
  mkdir -p "$INSTALL_DIR"
  chown "$DROP_USER:$DROP_USER" "$INSTALL_DIR"
  # Seed the root-owned provisioning script from this real root session —
  # never from the drop-reachable --provision sudoers rule. See
  # install_provision_script for why.
  install_provision_script
  provision_system        # Caddy, env, systemd unit (enabled, NOT started), sudoers, apex
  echo ""
  info "Bootstrap complete — box provisioned; $SERVICE_NAME installed but not yet started."
  info "Next steps:"
  info "  1. Set GitHub 'hetzner' env secrets:"
  info "       DEPLOY_HOST=<this server's IP>  DEPLOY_USER=$DROP_USER  DEPLOY_KEY_B64=<base64 of the deploy private key>"
  info "  2. Push to a deploy branch (e.g. develop) — CI builds, ships, and starts the service."
  info "  3. After the first deploy, retrieve the admin password:"
  info "       journalctl -u $SERVICE_NAME -b --no-pager | grep -A1 'Default Admin Credentials'"
  if [[ -n "$DOMAIN" ]]; then
    echo ""
    warn "  Open ports 80 and 443 in your cloud firewall; keep 5432/5433 (Postgres) closed."
  fi
elif $PROVISION; then
  info "Provisioning system (Caddy, unit, env, apex route)..."
  [[ "$ISOLATION" == "docker" ]] && ensure_docker
  # Deploys run `--provision`, so this is the only path that reaches an
  # already-bootstrapped server. Re-run the package step here or host
  # requirements added after bootstrap (python3-venv) never land. Non-fatal
  # under `set -e`: an apt mirror hiccup must not abort a deploy that has
  # already unpacked the new artifact but not yet restarted the service.
  ensure_build_tools || warn "Host build tools incomplete — Python apps may fail to build under isolation:none"
  provision_system
  info "Restarting $SERVICE_NAME..."
  systemctl restart "$SERVICE_NAME"
  # If Docker was just installed or the drop user was just added to the docker
  # group, the running service process won't have the group yet. A restart picks
  # up the new group membership since systemd respects it on exec.
  if [[ "$ISOLATION" == "docker" ]]; then
    info "Restarting $SERVICE_NAME to pick up docker group membership..."
    systemctl restart "$SERVICE_NAME"
  fi
  info "Provision complete."
elif $UPGRADE; then
  info "Upgrading DROP..."
  fetch_code
  build_drop
  # Refresh the root-owned provisioning script from the code this real root
  # session just pulled — this (not --provision) is how provisioning-logic
  # changes reach an already-bootstrapped box. See install_provision_script.
  install_provision_script
  provision_system
  info "Restarting $SERVICE_NAME..."
  systemctl restart "$SERVICE_NAME"
  info "Upgrade complete."
else
  info "Installing DROP..."
  ensure_node
  ensure_postgres
  ensure_user
  ensure_build_tools
  [[ "$ISOLATION" == "docker" ]] && ensure_docker
  ensure_root_dir
  fetch_code
  build_drop
  install_provision_script
  provision_system
  systemctl start "$SERVICE_NAME"
  echo ""
  info "DROP is running!"
  if [[ -n "$DOMAIN" ]]; then
    local_scheme="http"; [[ "$ENABLE_HTTPS" == "true" ]] && local_scheme="https"
    info "  Dashboard: ${local_scheme}://${DOMAIN}"
    info "  Apps:      ${local_scheme}://<app>.${DOMAIN}"
    warn "  Open ports 80 and 443 in your cloud firewall for HTTPS to work."
  else
    info "  Dashboard: http://localhost:${API_PORT}/dashboard"
    info "  API:       http://localhost:${API_PORT}/api/v1/health"
  fi
  echo ""
  info "Retrieve the one-time admin password:"
  info "  journalctl -u $SERVICE_NAME -b --no-pager | grep -A1 'Default Admin Credentials'"
  echo ""
  info "Data directory: $DROP_ROOT"
  info "Install directory: $INSTALL_DIR"
fi
