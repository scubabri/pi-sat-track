#!/usr/bin/env bash
# install-pi.sh
# Raspberry Pi setup for the Node sat-tracker web UI.
#
# Assumes you already cloned the repo, e.g.:
#   git clone https://github.com/scubabri/pi-sat-track.git
#   cd pi-sat-track
#   ./install-pi.sh
#
# - System packages (Node.js, nginx, build tools) via sudo when needed
# - npm install of node/sat-tracker as the normal user
# - Optional nginx reverse proxy (port 80 → Node :3000) with WebSocket support
# - Optional systemd user service
#
# Flags:
#   --no-nginx     Skip nginx install/config
#   --no-service   Skip systemd user service
#   --update       Re-run npm install only (no apt/nginx)

set -euo pipefail

NODE_MAJOR=22
PROXY_PORT=3000
NGINX_SITE="sat-tracker"

INSTALL_NGINX=1
INSTALL_SERVICE=1
UPDATE_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --no-nginx)   INSTALL_NGINX=0 ;;
    --no-service) INSTALL_SERVICE=0 ;;
    --update)     UPDATE_ONLY=1 ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
  esac
done

# Resolve repo root from this script's location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${SCRIPT_DIR}"
APP_DIR="${REPO_DIR}/node/sat-tracker"

# Who owns the app (never root for npm)
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  APP_USER="${SUDO_USER}"
  APP_HOME=$(getent passwd "${APP_USER}" | cut -d: -f6)
else
  APP_USER="$(id -un)"
  APP_HOME="${HOME}"
fi

if [[ "${APP_USER}" == "root" ]]; then
  echo "Do not run as root."
  echo "Clone and run as a normal user; the script will sudo only for apt/nginx."
  exit 1
fi

if [[ ! -f "${APP_DIR}/package.json" ]]; then
  echo "ERROR: ${APP_DIR}/package.json not found."
  echo "Run this script from the repo root after cloning:"
  echo "  git clone https://github.com/scubabri/pi-sat-track.git"
  echo "  cd pi-sat-track"
  echo "  ./install-pi.sh"
  exit 1
fi

need_sudo() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

echo "============================================================"
echo " Pi Sat Track – Node web UI installer"
echo " User: ${APP_USER}"
echo " Repo: ${REPO_DIR}"
echo " App:  ${APP_DIR}"
echo "============================================================"

# ---------- system packages ----------
if [[ $UPDATE_ONLY -eq 0 ]]; then
  echo "==> Installing system packages (apt)"
  need_sudo apt-get update -qq
  need_sudo apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    git \
    build-essential \
    python3

  if [[ $INSTALL_NGINX -eq 1 ]]; then
    need_sudo apt-get install -y --no-install-recommends nginx
  fi

  NEED_NODE=0
  if ! command -v node >/dev/null 2>&1; then
    NEED_NODE=1
  else
    CUR_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
    if [[ "${CUR_MAJOR}" -lt $NODE_MAJOR ]]; then
      NEED_NODE=1
    fi
  fi

  if [[ $NEED_NODE -eq 1 ]]; then
    echo "==> Installing Node.js ${NODE_MAJOR}.x (NodeSource)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | need_sudo bash -
    need_sudo apt-get install -y nodejs
  else
    echo "==> Node.js already present: $(node -v)"
  fi

  echo "    node $(node -v)"
  echo "    npm  $(npm -v)"
fi

# ---------- npm dependencies ----------
echo "==> npm install in ${APP_DIR}"
cd "${APP_DIR}"
npm install --omit=dev

mkdir -p "${APP_HOME}/.rpitrack"

# ---------- nginx (optional) ----------
if [[ $INSTALL_NGINX -eq 1 && $UPDATE_ONLY -eq 0 ]]; then
  echo "==> Configuring nginx reverse proxy → 127.0.0.1:${PROXY_PORT}"

  need_sudo tee "/etc/nginx/sites-available/${NGINX_SITE}" >/dev/null <<EOF
# Pi Sat Track – Node UI reverse proxy
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location / {
        proxy_pass         http://127.0.0.1:${PROXY_PORT};
        proxy_http_version 1.1;

        # WebSocket (/ws)
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";

        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;

        proxy_read_timeout  86400;
        proxy_send_timeout  86400;
    }

    location ~ /\\. {
        deny all;
    }
}
EOF

  need_sudo ln -sf "/etc/nginx/sites-available/${NGINX_SITE}" \
                   "/etc/nginx/sites-enabled/${NGINX_SITE}"

  if [[ -e /etc/nginx/sites-enabled/default ]]; then
    need_sudo rm -f /etc/nginx/sites-enabled/default
  fi

  need_sudo nginx -t
  need_sudo systemctl enable nginx
  need_sudo systemctl reload nginx
  echo "    nginx listening on :80 → Node :${PROXY_PORT}"
fi

# ---------- systemd user service (optional) ----------
if [[ $INSTALL_SERVICE -eq 1 ]]; then
  UNIT_DIR="${APP_HOME}/.config/systemd/user"
  mkdir -p "${UNIT_DIR}"

  cat > "${UNIT_DIR}/sat-tracker.service" <<EOF
[Unit]
Description=Pi Sat Track (Node web UI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=HOME=${APP_HOME}

[Install]
WantedBy=default.target
EOF

  if command -v loginctl >/dev/null 2>&1; then
    need_sudo loginctl enable-linger "${APP_USER}" || true
  fi

  systemctl --user daemon-reload
  systemctl --user enable sat-tracker.service
  systemctl --user restart sat-tracker.service

  echo "    systemd user service: sat-tracker (enabled)"
  echo "    logs: journalctl --user -u sat-tracker -f"
fi

# ---------- summary ----------
PI_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

============================================================
  Install complete
============================================================

  Repo     ${REPO_DIR}
  App      ${APP_DIR}
  Node     $(node -v) / npm $(npm -v)
  Cache    ${APP_HOME}/.rpitrack

  Start manually:
    cd ${APP_DIR}
    npm start
    # or: node server.js

  URL:
    http://127.0.0.1:${PROXY_PORT}/
EOF

if [[ $INSTALL_NGINX -eq 1 ]]; then
  echo "    http://${PI_IP:-<pi-ip>}/   (via nginx)"
fi

if [[ $INSTALL_SERVICE -eq 1 ]]; then
  cat <<EOF

  Service:
    systemctl --user status sat-tracker
    systemctl --user restart sat-tracker
    journalctl --user -u sat-tracker -f
EOF
fi

cat <<EOF

  Update later:
    cd ${REPO_DIR}
    git pull
    ./install-pi.sh --update

  TCI note:
    AetherSDR on the Mac must listen on the LAN (not only 127.0.0.1).
    Point lib/config.js TCI_URI at ws://<mac-ip>:50001

============================================================
EOF