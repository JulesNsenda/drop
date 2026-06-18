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
DOMAIN=""
ACME_EMAIL=""
ENABLE_HTTPS=false

# ── colour helpers ───────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[DROP]${NC} $*"; }
warn()  { echo -e "${YELLOW}[DROP]${NC} $*"; }
error() { echo -e "${RED}[DROP]${NC} $*" >&2; exit 1; }

# ── argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --upgrade)      UPGRADE=true ;;
    --provision)    PROVISION=true ;;
    --link)         DO_LINK=true ;;
    --https)        ENABLE_HTTPS=true ;;
    --dir=*)        INSTALL_DIR="${1#*=}" ;;
    --root=*)       DROP_ROOT="${1#*=}" ;;
    --user=*)       DROP_USER="${1#*=}" ;;
    --branch=*)     BRANCH="${1#*=}" ;;
    --domain=*)     DOMAIN="${1#*=}" ;;
    --acme-email=*) ACME_EMAIL="${1#*=}" ;;
    --port=*)       API_PORT="${1#*=}" ;;
    *) error "Unknown option: $1 (try --upgrade, --provision, --domain=, --https, --acme-email=, --dir=, --root=, --branch=, --link)" ;;
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
    apt-get update -qq && apt-get install -y curl
  fi
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  info "Node.js $(node --version) installed"
}

# ── system user ──────────────────────────────────────────────────────────────
ensure_user() {
  if ! id -u "$DROP_USER" &>/dev/null; then
    info "Creating system user '$DROP_USER'..."
    useradd -m -s /bin/bash "$DROP_USER"
  fi
}

# ── postgresql (system package — avoids EDB binary download) ─────────────────
ensure_postgres() {
  if ls /usr/lib/postgresql/*/bin/postgres &>/dev/null 2>&1; then
    info "PostgreSQL already installed"
    return 0
  fi
  info "Installing PostgreSQL via apt..."
  apt-get install -y postgresql
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
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y caddy
  else
    info "Caddy already installed"
  fi
  # DROP manages the Caddy process itself — keep the packaged service out of the way.
  systemctl disable --now caddy &>/dev/null || true
  # Let the non-root drop user's Caddy bind privileged ports 80/443.
  if ! command -v setcap &>/dev/null; then
    apt-get install -y libcap2-bin || true
  fi
  local caddy_bin; caddy_bin="$(command -v caddy)"
  if command -v setcap &>/dev/null && [[ -n "$caddy_bin" ]]; then
    setcap 'cap_net_bind_service=+ep' "$caddy_bin" \
      || warn "setcap failed — Caddy may not bind :80/:443 as the '$DROP_USER' user"
  fi
}

# ── platform config (domain / HTTPS) — persisted, survives upgrades & deploys ─
# Written to an EnvironmentFile that systemd re-reads on every start, so config
# changes take effect on the next service restart without rewriting the unit.
# Only keys passed as flags are touched; existing keys are preserved.
write_env_config() {
  if [[ -z "$DOMAIN" && -z "$ACME_EMAIL" && "$ENABLE_HTTPS" != "true" ]]; then
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
  [[ -n "$DOMAIN" ]]            && upsert DROP_DOMAIN_SUFFIX "$DOMAIN"
  [[ "$ENABLE_HTTPS" == "true" ]] && upsert DROP_ENABLE_HTTPS true
  [[ -n "$ACME_EMAIL" ]]       && upsert DROP_ACME_EMAIL "$ACME_EMAIL"
  chmod 644 "$ENV_FILE"
  info "Platform config written to $ENV_FILE"
}

# Resolve the configured domain suffix: explicit flag wins, else read the
# persisted env file (so --provision deploys keep routing the apex correctly).
resolve_domain() {
  if [[ -z "$DOMAIN" && -f "$ENV_FILE" ]]; then
    DOMAIN="$(sed -n 's|^DROP_DOMAIN_SUFFIX=||p' "$ENV_FILE" | tail -n1)"
  fi
}

# ── apex route: serve the DROP dashboard/API at the bare domain over HTTPS ─────
# DROP imports hosts/*.caddy and never rewrites hand-managed files there, so this
# persists. Apps are still served at <app>.<domain> via the domain suffix.
ensure_apex_route() {
  resolve_domain
  [[ -z "$DOMAIN" ]] && return 0
  local hosts_dir="$DROP_ROOT/data/appconf/caddy/hosts"
  info "Routing apex $DOMAIN → dashboard (localhost:$API_PORT)..."
  mkdir -p "$hosts_dir"
  cat > "$hosts_dir/${DOMAIN}.caddy" <<EOF
# Managed by install.sh — the apex domain serves the DROP dashboard/API.
# Delete this file to stop routing $DOMAIN to the control plane.
${DOMAIN} {
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
  info "Writing systemd service $SERVICE_NAME..."
  cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF
[Unit]
Description=DROP Platform
After=network.target

[Service]
Type=simple
User=$DROP_USER
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
Environment=DROP_ROOT=$DROP_ROOT
# Optional domain/HTTPS config (DROP_DOMAIN_SUFFIX, DROP_ENABLE_HTTPS,
# DROP_ACME_EMAIL). The leading '-' makes it optional; systemd re-reads it on
# every start, so deploys pick up config changes without a daemon-reload.
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
  write_env_config
  write_service      # (re)writes the unit + daemon-reload + enable
  write_sudoers
  ensure_apex_route
}

# ── run ──────────────────────────────────────────────────────────────────────
if $PROVISION; then
  info "Provisioning system (Caddy, unit, env, apex route)..."
  provision_system
  info "Restarting $SERVICE_NAME..."
  systemctl restart "$SERVICE_NAME"
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
  info "  journalctl -u $SERVICE_NAME -n 100 | grep -i 'admin password'"
  echo ""
  info "Data directory: $DROP_ROOT"
  info "Install directory: $INSTALL_DIR"
fi
