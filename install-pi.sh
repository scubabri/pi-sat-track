#!/usr/bin/env bash
# install-pi.sh
# Raspberry Pi setup for the Node sat-tracker web UI.
#
# Run from either:
#   ~/pi-sat-track/                  (repo root)
#   ~/pi-sat-track/node/sat-tracker/ (app dir — where package.json lives)
#
#   chmod +x install-pi.sh
#   ./install-pi.sh
#
# Flags:
#   --no-nginx     Skip nginx install/config
#   --no-service   Skip systemd user service
#   --update       Re-run npm install only (no apt/nginx/git)
#   --upgrade      git pull + npm install + restart service

set -euo pipefail

NODE_MAJOR=22
PROXY_PORT=3000
NGINX_SITE="sat-tracker"

INSTALL_NGINX=1
INSTALL_SERVICE=1
UPDATE_ONLY=0
UPGRADE=0

for arg in "$@"; do
  case "$arg" in
    --no-nginx)   INSTALL_NGINX=0 ;;
    --no-service) INSTALL_SERVICE=0 ;;
    --update)     UPDATE_ONLY=1 ;;
    --upgrade)    UPGRADE=1; UPDATE_ONLY=1; INSTALL_NGINX=0; INSTALL_SERVICE=0 ;;
    -h|--help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect app dir: script may live in repo root or in node/sat-tracker
if [[ -f "${SCRIPT_DIR}/package.json" ]]; then
  APP_DIR="${SCRIPT_DIR}"
elif [[ -f "${SCRIPT_DIR}/node/sat-tracker/package.json" ]]; then
  APP_DIR="${SCRIPT_DIR}/node/sat-tracker"
else
  echo "ERROR: package.json not found relative to ${SCRIPT_DIR}"
  echo "Expected either:"
  echo "  ${SCRIPT_DIR}/package.json"
  echo "  ${SCRIPT_DIR}/node/sat-tracker/package.json"
  exit 1
fi

# Find git root (may be APP_DIR or a parent)
GIT_ROOT="${APP_DIR}"
if git -C "${APP_DIR}" rev-parse --show-toplevel >/dev/null 2>&1; then
  GIT_ROOT="$(git -C "${APP_DIR}" rev-parse --show-toplevel)"
elif git -C "${SCRIPT_DIR}" rev-parse --show-toplevel >/dev/null 2>&1; then
  GIT_ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel)"
fi

if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  APP_USER="${SUDO_USER}"
  APP_HOME=$(getent passwd "${APP_USER}" | cut -d: -f6)
else
  APP_USER="$(id -un)"
  APP_HOME="${HOME}"
fi

if [[ "${APP_USER}" == "root" ]]; then
  echo "Do not run as root."
  echo "Run as a normal user; the script will sudo only for apt/nginx."
  exit 1
fi

need_sudo() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Ensure user systemd bus is available (SSH / no graphical session)
ensure_user_systemd() {
  if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi
  if [[ ! -d "${XDG_RUNTIME_DIR}" ]]; then
    echo "WARN: ${XDG_RUNTIME_DIR} missing — is lingering enabled?"
    echo "      sudo loginctl enable-linger ${APP_USER}"
  fi
}

echo "============================================================"
echo " Pi Sat Track – Node web UI installer"
echo " User: ${APP_USER}"
echo " App:  ${APP_DIR}"
if [[ $UPGRADE -eq 1 ]]; then
  echo " Mode: --upgrade (git pull + npm + restart)"
fi
echo "============================================================"

# ---------- upgrade: git pull ----------
if [[ $UPGRADE -eq 1 ]]; then
  if [[ ! -d "${GIT_ROOT}/.git" ]]; then
    echo "ERROR: not a git repo (${GIT_ROOT})"
    echo "Clone once with: git clone https://github.com/scubabri/pi-sat-track.git"
    exit 1
  fi
  echo "==> git pull in ${GIT_ROOT}"
  git -C "${GIT_ROOT}" fetch origin
  # Prefer main, fall back to master
  BRANCH="$(git -C "${GIT_ROOT}" rev-parse --abbrev-ref HEAD)"
  if git -C "${GIT_ROOT}" show-ref --verify --quiet "refs/remotes/origin/${BRANCH}"; then
    git -C "${GIT_ROOT}" pull --ff-only origin "${BRANCH}"
  elif git -C "${GIT_ROOT}" show-ref --verify --quiet refs/remotes/origin/main; then
    git -C "${GIT_ROOT}" checkout main
    git -C "${GIT_ROOT}" pull --ff-only origin main
  else
    git -C "${GIT_ROOT}" pull --ff-only
  fi
  echo "    HEAD: $(git -C "${GIT_ROOT}" rev-parse --short HEAD)"
fi

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

# ---------- nginx (optional, full install only) ----------
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

# ---------- systemd user service ----------
# Full install: write unit + enable
# --upgrade: restart if unit exists
if [[ $INSTALL_SERVICE -eq 1 && $UPDATE_ONLY -eq 0 ]]; then
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

  ensure_user_systemd
  systemctl --user daemon-reload
  systemctl --user enable sat-tracker.service
  systemctl --user restart sat-tracker.service

  echo "    systemd user service: sat-tracker (enabled)"
  echo "    logs: journalctl --user -u sat-tracker -f"
fi

if [[ $UPGRADE -eq 1 ]]; then
  ensure_user_systemd
  if systemctl --user list-unit-files sat-tracker.service >/dev/null 2>&1; then
    echo "==> Restarting sat-tracker service"
    systemctl --user daemon-reload
    systemctl --user restart sat-tracker.service
    systemctl --user --no-pager --full status sat-tracker.service || true
  else
    echo "WARN: sat-tracker.service not installed — start manually:"
    echo "      cd ${APP_DIR} && node server.js"
  fi
fi

# ---------- summary ----------
PI_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

============================================================
  Done
============================================================

  App      ${APP_DIR}
  Node     $(node -v 2>/dev/null || echo '?') / npm $(npm -v 2>/dev/null || echo '?')
  Cache    ${APP_HOME}/.rpitrack

  URL:
    http://127.0.0.1:${PROXY_PORT}/
    http://${PI_IP:-<pi-ip>}/

  Day-to-day update:
    cd ${APP_DIR}
    ./install-pi.sh --upgrade

  Service:
    systemctl --user status sat-tracker
    systemctl --user restart sat-tracker
    journalctl --user -u sat-tracker -f

============================================================
EOF