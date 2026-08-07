#!/usr/bin/env bash
# =============================================================================
# Pi Sat Track — install / update (zip distribution)
# =============================================================================
# Expects this script to live inside an extracted release tree that already
# contains package.json and server.js. Does NOT clone or pull from any remote.
#
# Typical first install:
#   unzip pi-sat-track-*.zip -d ~/pi-sat-track
#   cd ~/pi-sat-track
#   chmod +x install-pi.sh
#   ./install-pi.sh
#
# Flags:
#   --no-nginx    Skip nginx reverse-proxy setup
#   --no-service  Skip systemd user service
#   --update      npm install only (no apt / nginx / service changes)
# =============================================================================

set -euo pipefail

NODE_MAJOR=22
PROXY_PORT=3000
SERVICE_NAME="sat-tracker"
NGINX_SITE="sat-tracker"

INSTALL_NGINX=1
INSTALL_SERVICE=1
UPDATE_ONLY=0

die()  { echo "ERROR: $*" >&2; exit 1; }
log()  { echo; echo "==> $*"; }
warn() { echo "WARN: $*" >&2; }

need_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

ensure_user_systemd() {
  if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi
  if [[ ! -S "${XDG_RUNTIME_DIR}/bus" ]]; then
    warn "User systemd bus not available — service commands may fail until you log in graphically or via linger"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-nginx)   INSTALL_NGINX=0 ;;
    --no-service) INSTALL_SERVICE=0 ;;
    --update)     UPDATE_ONLY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      die "Unknown option: $1 (try --help)"
      ;;
  esac
  shift
done

# -------------------- identity / paths --------------------
if [[ "$(id -u)" -eq 0 && -z "${SUDO_USER:-}" ]]; then
  die "Run as a normal user (not root). The script will sudo when needed."
fi

APP_USER="${SUDO_USER:-$(id -un)}"
APP_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"
[[ -n "${APP_HOME}" && -d "${APP_HOME}" ]] || die "Cannot resolve home for ${APP_USER}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# App root = directory that contains package.json + server.js
APP_DIR=""
if [[ -f "${SCRIPT_DIR}/package.json" && -f "${SCRIPT_DIR}/server.js" ]]; then
  APP_DIR="${SCRIPT_DIR}"
elif [[ -f "${SCRIPT_DIR}/node/sat-tracker/package.json" ]]; then
  APP_DIR="${SCRIPT_DIR}/node/sat-tracker"
else
  # Walk up a level (script in scripts/ or similar)
  if [[ -f "${SCRIPT_DIR}/../package.json" && -f "${SCRIPT_DIR}/../server.js" ]]; then
    APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
  fi
fi
[[ -n "${APP_DIR}" ]] || die "Cannot find package.json + server.js near ${SCRIPT_DIR}. Extract the full zip first."

cd "${APP_DIR}"

echo
echo "============================================================"
echo "  Pi Sat Track install"
echo "============================================================"
echo "  User     ${APP_USER}"
echo "  Home     ${APP_HOME}"
echo "  App      ${APP_DIR}"
if [[ $UPDATE_ONLY -eq 1 ]]; then
  echo "  Mode     UPDATE (npm only)"
else
  echo "  Mode     FULL install"
  echo "  nginx    $([[ $INSTALL_NGINX -eq 1 ]] && echo yes || echo no)"
  echo "  service  $([[ $INSTALL_SERVICE -eq 1 ]] && echo yes || echo no)"
fi
echo "============================================================"

# -------------------- system packages --------------------
if [[ $UPDATE_ONLY -eq 0 ]]; then
  log "Updating package lists"
  need_sudo apt-get update -qq

  log "Installing system packages"
  # build-essential + python3: node-gyp for serialport native build
  # libudev-dev: serialport udev bindings
  PKGS=(
    curl
    ca-certificates
    gnupg
    build-essential
    python3
    libudev-dev
    pkg-config
  )
  if [[ $INSTALL_NGINX -eq 1 ]]; then
    PKGS+=(nginx)
  fi
  need_sudo apt-get install -y --no-install-recommends "${PKGS[@]}"

  if getent group dialout >/dev/null 2>&1; then
    if id -nG "${APP_USER}" | tr ' ' '\n' | grep -qx dialout; then
      echo "    ${APP_USER} already in dialout"
    else
      log "Adding ${APP_USER} to dialout (serial radios)"
      need_sudo usermod -aG dialout "${APP_USER}"
      warn "dialout membership applies on next login (or: newgrp dialout)"
    fi
  fi
fi

# -------------------- Node.js --------------------
if [[ $UPDATE_ONLY -eq 0 ]]; then
  NEED_NODE=0
  if ! command -v node >/dev/null 2>&1; then
    NEED_NODE=1
  else
    MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0)"
    if [[ "${MAJOR}" -lt "${NODE_MAJOR}" ]]; then
      NEED_NODE=1
    fi
  fi

  if [[ $NEED_NODE -eq 1 ]]; then
    log "Installing Node.js ${NODE_MAJOR}.x LTS (NodeSource)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | need_sudo bash -
    need_sudo apt-get install -y nodejs
  else
    log "Node.js already present: $(node -v)"
  fi
fi

command -v node >/dev/null 2>&1 || die "node not found after install"
command -v npm  >/dev/null 2>&1 || die "npm not found after install"
echo "    node  $(node -v)"
echo "    npm   $(npm -v)"

# -------------------- cache dir --------------------
CACHE_DIR="${APP_HOME}/.rpitrack"
log "Ensuring cache directory ${CACHE_DIR}"
mkdir -p "${CACHE_DIR}"
if [[ -n "${SUDO_USER:-}" ]]; then
  need_sudo chown -R "${APP_USER}:${APP_USER}" "${CACHE_DIR}" 2>/dev/null || true
fi

# -------------------- npm install --------------------
log "npm install in ${APP_DIR}"
cd "${APP_DIR}"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev 2>/dev/null || npm install --omit=dev
else
  npm install --omit=dev
fi
echo "    node_modules ready"

# -------------------- nginx --------------------
if [[ $INSTALL_NGINX -eq 1 && $UPDATE_ONLY -eq 0 ]]; then
  log "Configuring nginx reverse proxy (:80 → 127.0.0.1:${PROXY_PORT})"

  need_sudo tee "/etc/nginx/sites-available/${NGINX_SITE}" >/dev/null <<NGX
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location / {
        proxy_pass         http://127.0.0.1:${PROXY_PORT};
        proxy_http_version 1.1;

        # WebSocket (tracker + radio status)
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection \$connection_upgrade;

        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;

        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }
}
NGX

  need_sudo ln -sfn \
    "/etc/nginx/sites-available/${NGINX_SITE}" \
    "/etc/nginx/sites-enabled/${NGINX_SITE}"

  if [[ -e /etc/nginx/sites-enabled/default ]]; then
    need_sudo rm -f /etc/nginx/sites-enabled/default
  fi

  need_sudo nginx -t
  need_sudo systemctl enable nginx
  need_sudo systemctl reload nginx
  echo "    nginx :80 → 127.0.0.1:${PROXY_PORT} (WebSocket enabled)"
fi

# -------------------- systemd user service --------------------
if [[ $INSTALL_SERVICE -eq 1 && $UPDATE_ONLY -eq 0 ]]; then
  UNIT_DIR="${APP_HOME}/.config/systemd/user"
  mkdir -p "${UNIT_DIR}"

  NODE_BIN="$(command -v node)"
  log "Writing systemd user unit ${UNIT_DIR}/${SERVICE_NAME}.service"

  cat > "${UNIT_DIR}/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Pi Sat Track (Node web UI / dual-radio)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=HOME=${APP_HOME}

[Install]
WantedBy=default.target
UNIT

  if [[ -n "${SUDO_USER:-}" ]]; then
    need_sudo chown -R "${APP_USER}:${APP_USER}" "${APP_HOME}/.config/systemd" 2>/dev/null || true
  fi

  if command -v loginctl >/dev/null 2>&1; then
    need_sudo loginctl enable-linger "${APP_USER}" || true
  fi

  ensure_user_systemd
  systemctl --user daemon-reload
  systemctl --user enable "${SERVICE_NAME}.service"
  systemctl --user restart "${SERVICE_NAME}.service"

  echo "    systemd user service: ${SERVICE_NAME} (enabled + started)"
  echo "    logs: journalctl --user -u ${SERVICE_NAME} -f"
fi

# --update: restart service if present
if [[ $UPDATE_ONLY -eq 1 ]]; then
  ensure_user_systemd
  if systemctl --user list-unit-files "${SERVICE_NAME}.service" 2>/dev/null | grep -q "${SERVICE_NAME}"; then
    log "Restarting ${SERVICE_NAME} service"
    systemctl --user daemon-reload
    systemctl --user restart "${SERVICE_NAME}.service"
    sleep 1
    systemctl --user --no-pager --full status "${SERVICE_NAME}.service" || true
  else
    warn "${SERVICE_NAME}.service not installed — start manually:"
    echo "      cd ${APP_DIR} && node server.js"
  fi
fi

# -------------------- health probe --------------------
log "Health probe (localhost:${PROXY_PORT})"
PROBE_OK=0
for _ in 1 2 3 4 5 6; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PROXY_PORT}/" 2>/dev/null; then
    PROBE_OK=1
    break
  fi
  sleep 1
done
if [[ $PROBE_OK -eq 1 ]]; then
  echo "    HTTP 200 from Node on :${PROXY_PORT}"
else
  warn "Node not answering on :${PROXY_PORT} yet"
  echo "    Check: journalctl --user -u ${SERVICE_NAME} -n 50 --no-pager"
  echo "    Or run foreground: cd ${APP_DIR} && node server.js"
fi

# -------------------- summary --------------------
PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

cat <<SUM

============================================================
  Done
============================================================

  App        ${APP_DIR}
  Node       $(node -v 2>/dev/null || echo '?') / npm $(npm -v 2>/dev/null || echo '?')
  Cache      ${CACHE_DIR}

  URL
    http://127.0.0.1:${PROXY_PORT}/
    http://${PI_IP:-<pi-ip>}/

  Config is in the browser (gear icon): radios, rotors, profiles.

  Update from a new release zip
    1. Stop service:  systemctl --user stop ${SERVICE_NAME}
    2. Extract zip over this tree (or into a new folder)
    3. cd into the app directory
    4. ./install-pi.sh --update
       (or full ./install-pi.sh if system packages changed)

  Service
    systemctl --user status ${SERVICE_NAME}
    systemctl --user restart ${SERVICE_NAME}
    journalctl --user -u ${SERVICE_NAME} -f

  Serial radios
    User should be in dialout. Re-login if you were just added.
    Devices are often /dev/ttyACM0 or /dev/ttyUSB0

============================================================
SUM
