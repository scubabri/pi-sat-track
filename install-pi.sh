#!/usr/bin/env bash
# =============================================================================
# install-pi.sh — Pi Sat Track (Node web UI) installer
# =============================================================================
#
# Installs and configures everything needed to run the dual-radio Node sat
# tracker on Raspberry Pi OS (Bookworm / Trixie) or similar Debian-based hosts.
#
# Covers:
#   • system packages (build tools, udev for serialport, nginx)
#   • Node.js 22.x LTS (NodeSource)
#   • npm install (satellite.js, serialport, ws)
#   • dialout group for CI-V / serial radios
#   • ~/.rpitrack cache directory
#   • nginx reverse proxy :80 → Node :3000 (WebSocket headers)
#   • systemd --user service "sat-tracker"
#   • optional git pull on --upgrade (stays on current branch, e.g. CAT)
#
# Usage (run as a normal user — script sudo's only for apt / nginx / linger):
#
#   cd ~/pi-sat-track/node/sat-tracker   # or repo root
#   chmod +x install-pi.sh
#   ./install-pi.sh
#
# Flags:
#   --no-nginx      Skip nginx install and site config
#   --no-service    Skip systemd user service
#   --update        Re-run npm install only (no apt / nginx / git)
#   --upgrade       git pull + npm install + restart service
#   --branch NAME   On --upgrade, checkout/pull NAME (default: keep current)
#   -h, --help      Show this header
#
# Day-to-day after first install:
#   ./install-pi.sh --upgrade
#
# =============================================================================

set -euo pipefail

# -------------------- defaults --------------------
NODE_MAJOR=22
PROXY_PORT=3000
NGINX_SITE="sat-tracker"
SERVICE_NAME="sat-tracker"

INSTALL_NGINX=1
INSTALL_SERVICE=1
UPDATE_ONLY=0
UPGRADE=0
BRANCH=""   # empty = keep current branch on upgrade

# -------------------- args --------------------
for arg in "$@"; do
  case "$arg" in
    --no-nginx)   INSTALL_NGINX=0 ;;
    --no-service) INSTALL_SERVICE=0 ;;
    --update)     UPDATE_ONLY=1 ;;
    --upgrade)    UPGRADE=1; UPDATE_ONLY=1; INSTALL_NGINX=0; INSTALL_SERVICE=0 ;;
    --branch)
      # handled below with shift-style parse
      ;;
    --branch=*)
      BRANCH="${arg#--branch=}"
      ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      if [[ "${PREV_ARG:-}" == "--branch" ]]; then
        BRANCH="$arg"
      fi
      ;;
  esac
  PREV_ARG="$arg"
done

# -------------------- paths / user --------------------
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

# Git root (may be APP_DIR or a parent)
GIT_ROOT="${APP_DIR}"
if git -C "${APP_DIR}" rev-parse --show-toplevel >/dev/null 2>&1; then
  GIT_ROOT="$(git -C "${APP_DIR}" rev-parse --show-toplevel)"
elif git -C "${SCRIPT_DIR}" rev-parse --show-toplevel >/dev/null 2>&1; then
  GIT_ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel)"
fi

if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  APP_USER="${SUDO_USER}"
  APP_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"
else
  APP_USER="$(id -un)"
  APP_HOME="${HOME}"
fi

if [[ "${APP_USER}" == "root" ]]; then
  echo "Do not run this installer as root."
  echo "Run as a normal user; the script will sudo only for apt / nginx / linger."
  exit 1
fi

need_sudo() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Ensure user systemd bus works over SSH / headless
ensure_user_systemd() {
  if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u "${APP_USER}")"
  fi
  if [[ ! -d "${XDG_RUNTIME_DIR}" ]]; then
    need_sudo mkdir -p "${XDG_RUNTIME_DIR}"
    need_sudo chown "${APP_USER}:${APP_USER}" "${XDG_RUNTIME_DIR}"
    need_sudo chmod 700 "${XDG_RUNTIME_DIR}"
  fi
  # Import environment so systemctl --user works without a login session
  if ! systemctl --user status >/dev/null 2>&1; then
    if command -v loginctl >/dev/null 2>&1; then
      need_sudo loginctl enable-linger "${APP_USER}" || true
    fi
    # Give linger a moment
    sleep 1
  fi
}

# -------------------- banner --------------------
echo
echo "============================================================"
echo "  Pi Sat Track installer"
echo "============================================================"
echo "  User     ${APP_USER}"
echo "  Home     ${APP_HOME}"
echo "  App      ${APP_DIR}"
echo "  Git root ${GIT_ROOT}"
if [[ $UPGRADE -eq 1 ]]; then
  echo "  Mode     UPGRADE"
elif [[ $UPDATE_ONLY -eq 1 ]]; then
  echo "  Mode     UPDATE (npm only)"
else
  echo "  Mode     FULL INSTALL"
fi
echo "============================================================"
echo

# -------------------- upgrade: git pull --------------------
if [[ $UPGRADE -eq 1 ]]; then
  if ! git -C "${GIT_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "Not a git repo: ${GIT_ROOT}"
  fi

  CURRENT_BRANCH="$(git -C "${GIT_ROOT}" rev-parse --abbrev-ref HEAD)"
  TARGET_BRANCH="${BRANCH:-$CURRENT_BRANCH}"

  log "Git: on branch ${CURRENT_BRANCH}"
  if [[ "${TARGET_BRANCH}" != "${CURRENT_BRANCH}" ]]; then
    log "Checking out ${TARGET_BRANCH}"
    git -C "${GIT_ROOT}" fetch origin
    git -C "${GIT_ROOT}" checkout "${TARGET_BRANCH}"
  else
    log "Pulling origin/${TARGET_BRANCH}"
    git -C "${GIT_ROOT}" fetch origin
    # Prefer rebase to avoid noisy merge commits on a Pi
    if ! git -C "${GIT_ROOT}" pull --rebase origin "${TARGET_BRANCH}"; then
      warn "git pull --rebase failed — trying plain pull"
      git -C "${GIT_ROOT}" pull origin "${TARGET_BRANCH}"
    fi
  fi
  echo "    HEAD $(git -C "${GIT_ROOT}" rev-parse --short HEAD) ($(git -C "${GIT_ROOT}" rev-parse --abbrev-ref HEAD))"
fi

# -------------------- system packages --------------------
if [[ $UPDATE_ONLY -eq 0 ]]; then
  log "Updating package lists"
  need_sudo apt-get update -qq

  log "Installing system packages"
  # build-essential + python3: only for compiling serialport (node-gyp).
  # No Python app is installed or run — Node-only stack (no RTL-SDR tools).
  # libudev-dev: serialport udev bindings
  PKGS=(
    curl
    ca-certificates
    gnupg
    git
    build-essential
    python3
    libudev-dev
    pkg-config
  )
  if [[ $INSTALL_NGINX -eq 1 ]]; then
    PKGS+=(nginx)
  fi
  need_sudo apt-get install -y --no-install-recommends "${PKGS[@]}"

  # dialout for serial CI-V (Icom etc.)
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
# If we were sudo'd somehow, fix ownership
if [[ -n "${SUDO_USER:-}" ]]; then
  need_sudo chown -R "${APP_USER}:${APP_USER}" "${CACHE_DIR}" 2>/dev/null || true
fi

# -------------------- npm install --------------------
log "npm install in ${APP_DIR}"
cd "${APP_DIR}"
# Prefer clean install when package-lock exists
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev 2>/dev/null || npm install --omit=dev
else
  npm install --omit=dev
fi

# Sanity: drivers load
log "Sanity-check radio drivers"
node -e '
  const path = require("path");
  const fs = require("fs");
  // node -e sets __dirname to "." — always resolve to absolute paths
  const root = process.cwd();
  const radios = require(path.join(root, "lib", "radios"));
  const dir = path.join(root, "lib", "radios");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".js") && f !== "index.js" && f !== "flex-api.js");
  console.log("    radio modules:", files.map(f => f.replace(/\.js$/, "")).join(", "));
  for (const f of files) {
    require(path.resolve(dir, f));
  }
  console.log("    drivers OK");
' || warn "Driver load check failed — start server manually to see errors"

# -------------------- nginx --------------------
if [[ $INSTALL_NGINX -eq 1 && $UPDATE_ONLY -eq 0 ]]; then
  log "Writing nginx site: /etc/nginx/sites-available/${NGINX_SITE}"

  need_sudo tee "/etc/nginx/sites-available/${NGINX_SITE}" >/dev/null <<EOF
# Pi Sat Track – Node UI reverse proxy
# Node listens on 127.0.0.1:${PROXY_PORT}

map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Optional static shortcut (if you ever publish a build/ folder)
    location /static/ {
        alias ${APP_DIR}/public/;
        expires 7d;
        access_log off;
    }

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
EOF

  need_sudo ln -sfn \
    "/etc/nginx/sites-available/${NGINX_SITE}" \
    "/etc/nginx/sites-enabled/${NGINX_SITE}"

  # Avoid fighting with default site on :80
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

  cat > "${UNIT_DIR}/${SERVICE_NAME}.service" <<EOF
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
# Uncomment if you need more open files for many WS clients:
# LimitNOFILE=65535

[Install]
WantedBy=default.target
EOF

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

# --upgrade: restart if unit exists
if [[ $UPGRADE -eq 1 ]]; then
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

# -------------------- quick health probe --------------------
log "Health probe (localhost:${PROXY_PORT})"
PROBE_OK=0
for i in 1 2 3 4 5 6; do
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
BRANCH_NOW="?"
if git -C "${GIT_ROOT}" rev-parse --abbrev-ref HEAD >/dev/null 2>&1; then
  BRANCH_NOW="$(git -C "${GIT_ROOT}" rev-parse --abbrev-ref HEAD) @ $(git -C "${GIT_ROOT}" rev-parse --short HEAD)"
fi

cat <<EOF

============================================================
  Done
============================================================

  App        ${APP_DIR}
  Branch     ${BRANCH_NOW}
  Node       $(node -v 2>/dev/null || echo '?') / npm $(npm -v 2>/dev/null || echo '?')
  Cache      ${CACHE_DIR}

  URL
    http://127.0.0.1:${PROXY_PORT}/
    http://${PI_IP:-<pi-ip>}/

  Dual-radio config is in the browser (gear icon):
    Radio UL (TX)  and  Radio DL (RX)  are independent
    (TCI / Flex CAT / Icom CI-V / rigctl TCP can be mixed)

  Day-to-day update
    cd ${APP_DIR}
    ./install-pi.sh --upgrade
    # or stay on a branch:
    ./install-pi.sh --upgrade --branch CAT

  Service
    systemctl --user status ${SERVICE_NAME}
    systemctl --user restart ${SERVICE_NAME}
    journalctl --user -u ${SERVICE_NAME} -f

  Serial radios
    User should be in dialout. Re-login if you just got added.
    Default device often /dev/ttyACM0 or /dev/ttyUSB0

  Rotors (optional, separate)
    Green Heron RT-21 via dual rotctld, e.g.:
      rotctld -m 601 -r /dev/ttyUSB0 -s 9600 -t 4535   # AZ
      rotctld -m 601 -r /dev/ttyUSB1 -s 9600 -t 4536   # EL

============================================================
EOF
