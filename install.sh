#!/usr/bin/env bash
# DROP install / upgrade script
# Usage:
#   sudo bash install.sh                  # fresh install
#   sudo bash install.sh --upgrade        # force upgrade
#   sudo bash install.sh --dir=/opt/drop --root=/var/drop --branch=develop
#   sudo bash install.sh --link           # also run npm link (for CLI access)
set -euo pipefail

REPO_URL="https://github.com/JulesNsenda/drop.git"
INSTALL_DIR="/opt/drop"
DROP_ROOT="/var/drop"
DROP_USER="drop"
BRANCH="main"
SERVICE_NAME="drop-platform"
UPGRADE=false
DO_LINK=false

# ── colour helpers ───────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[DROP]${NC} $*"; }
warn()  { echo -e "${YELLOW}[DROP]${NC} $*"; }
error() { echo -e "${RED}[DROP]${NC} $*" >&2; exit 1; }

# ── argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --upgrade)      UPGRADE=true ;;
    --link)         DO_LINK=true ;;
    --dir=*)        INSTALL_DIR="${1#*=}" ;;
    --root=*)       DROP_ROOT="${1#*=}" ;;
    --user=*)       DROP_USER="${1#*=}" ;;
    --branch=*)     BRANCH="${1#*=}" ;;
    *) error "Unknown option: $1 (try --upgrade, --dir=, --root=, --branch=, --link)" ;;
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

# ── sudoers: let drop user start/stop the service (needed for CI deploy) ─────
write_sudoers() {
  local f="/etc/sudoers.d/${DROP_USER}-deploy"
  info "Writing sudoers rule for $DROP_USER..."
  rm -f "$f"
  echo "${DROP_USER} ALL=(ALL) NOPASSWD: /bin/systemctl stop ${SERVICE_NAME}"    >> "$f"
  echo "${DROP_USER} ALL=(ALL) NOPASSWD: /bin/systemctl start ${SERVICE_NAME}"   >> "$f"
  echo "${DROP_USER} ALL=(ALL) NOPASSWD: /bin/systemctl restart ${SERVICE_NAME}" >> "$f"
  echo "${DROP_USER} ALL=(ALL) NOPASSWD: /bin/systemctl status ${SERVICE_NAME}"  >> "$f"
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

# ── run ──────────────────────────────────────────────────────────────────────
if $UPGRADE; then
  info "Upgrading DROP..."
  fetch_code
  build_drop
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    info "Restarting $SERVICE_NAME..."
    systemctl restart "$SERVICE_NAME"
  else
    warn "$SERVICE_NAME is not running — start it with: systemctl start $SERVICE_NAME"
  fi
  info "Upgrade complete."
else
  info "Installing DROP..."
  ensure_node
  ensure_postgres
  ensure_user
  fetch_code
  build_drop
  write_service
  write_sudoers
  systemctl start "$SERVICE_NAME"
  echo ""
  info "DROP is running!"
  info "  Dashboard: http://localhost:3000/dashboard"
  info "  API:       http://localhost:3000/api/v1/health"
  echo ""
  info "Retrieve the one-time admin password:"
  info "  journalctl -u $SERVICE_NAME -n 100 | grep -i 'admin password'"
  echo ""
  info "Data directory: $DROP_ROOT"
  info "Install directory: $INSTALL_DIR"
fi
