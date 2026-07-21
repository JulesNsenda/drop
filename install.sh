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

REPO_URL="https://github.com/JulesNsenda/drop.git"
INSTALL_DIR="/opt/drop"
DROP_ROOT="/var/drop"
DROP_USER="drop"
BRANCH="main"
SERVICE_NAME="drop-platform"
API_PORT="3000"
ENV_FILE="/etc/drop/drop.env"
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
aptget() { apt-get -o DPkg::Lock::Timeout=300 "$@"; }

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
ensure_build_tools() {
  if dpkg -s build-essential &>/dev/null && command -v python3 &>/dev/null; then
    info "Build tools already installed"
    return 0
  fi
  info "Installing build tools (build-essential, python3) for native npm deps..."
  aptget install -y build-essential python3
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

# ── sudoers: let drop user start/stop the service (needed for CI deploy) ─────
write_sudoers() {
  local f="/etc/sudoers.d/${DROP_USER}-deploy"
  info "Writing sudoers rule for $DROP_USER..."
  rm -f "$f"
  echo "${DROP_USER} ALL=(ALL) NOPASSWD: /bin/systemctl stop ${SERVICE_NAME}"    >> "$f"
  echo "${DROP_USER} ALL=(ALL) NOPASSWD: /bin/systemctl start ${SERVICE_NAME}"   >> "$f"
  echo "${DROP_USER} ALL=(ALL) NOPASSWD: /bin/systemctl restart ${SERVICE_NAME}" >> "$f"
  echo "${DROP_USER} ALL=(ALL) NOPASSWD: /bin/systemctl status ${SERVICE_NAME}"  >> "$f"
  # Let the CI deploy re-apply system provisioning (Caddy, unit, env, apex route)
  # by running install.sh in --provision mode as root. This is what lets infra
  # changes in install.sh land on the server via a normal git-push deploy.
  echo "${DROP_USER} ALL=(ALL) NOPASSWD: /usr/bin/bash ${INSTALL_DIR}/install.sh --provision" >> "$f"
  chmod 440 "$f"
  visudo -c -f "$f" || error "sudoers syntax error — check $f"
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
# Idempotent. Re-run on every deploy via `install.sh --provision` so that infra
# changes in this script (Caddy, the systemd unit, the apex route) land on the
# server without a manual install. Code itself is shipped as a prebuilt artifact.
provision_system() {
  ensure_root_dir
  ensure_caddy
  ensure_removeipc_off
  write_env_config
  write_service      # (re)writes the unit + daemon-reload + enable
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
