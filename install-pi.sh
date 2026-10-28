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
#   --update      Refresh npm + rewrite/restart user service WorkingDirectory
#   --no-bluetooth  Skip Bluetooth setup (bluez, bluetooth service + group) for
#                 Bluetooth KISS TNCs such as the Kenwood TH-D74/D75
#                 (runs on full install and --update; idempotent)
#   SKIP_HAMLIB=1 ./install-pi.sh   Do not install Hamlib (libhamlib-utils); it is
#                 only needed for radios set to "Hamlib serial (rigctld)"
# =============================================================================

set -euo pipefail

NODE_MAJOR=22
PROXY_PORT=3000
SERVICE_NAME="sat-tracker"
NGINX_SITE="sat-tracker"

INSTALL_NGINX=1
INSTALL_SERVICE=1
UPDATE_ONLY=0
INSTALL_BLUETOOTH=1

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
    --no-bluetooth) INSTALL_BLUETOOTH=0 ;;
    -h|--help)
      sed -n '2,21p' "$0"
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
  echo "  Mode     UPDATE (npm + user service)"
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

# -------------------- Hamlib (rigctld for "Hamlib serial" radios) --------------------
# Optional: only radios set to Connection = "Hamlib serial (rigctld)" use it. The
# app also offers Configure → Radio → Update (apt) later. SKIP_HAMLIB=1 skips.
if [[ "${SKIP_HAMLIB:-0}" != 1 ]]; then  # full install and --update; idempotent
  if command -v rigctld >/dev/null 2>&1; then
    echo "    Hamlib present: $(rigctld --version 2>/dev/null | head -n1)"
  else
    log "Installing Hamlib (libhamlib-utils: rigctl / rigctld / rotctld)"
    need_sudo apt-get install -y --no-install-recommends libhamlib-utils || warn "Could not install libhamlib-utils (Hamlib radios will not work; native drivers are unaffected)"
  fi
fi

# -------------------- Bluetooth (KISS over RFCOMM) --------------------
# Bluetooth KISS TNCs (Kenwood TH-D74/D75, ...) are opened by MAC address
# through lib/kiss/rfcomm-bridge.py (python3 standard library RFCOMM socket):
# needs BlueZ running and unblocked; the bluetooth group lets the app list
# paired devices (bluetoothctl). No root, no rfcomm bind, no capabilities.
# Runs on full install and --update; every step checks first (idempotent).
if [[ $INSTALL_BLUETOOTH -eq 1 ]]; then
  log "Bluetooth (KISS TNCs over RFCOMM)"
  BT_PKGS=()
  dpkg -s bluez >/dev/null 2>&1 || BT_PKGS+=(bluez)
  dpkg -s python3 >/dev/null 2>&1 || BT_PKGS+=(python3)
  if [[ ${#BT_PKGS[@]} -gt 0 ]]; then
    echo "    installing: ${BT_PKGS[*]}"
    need_sudo apt-get install -y --no-install-recommends "${BT_PKGS[@]}" || warn "Could not install ${BT_PKGS[*]} (Bluetooth KISS needs them)"
  else
    echo "    bluez + python3 present"
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files bluetooth.service >/dev/null 2>&1; then
    if systemctl is-enabled --quiet bluetooth 2>/dev/null && systemctl is-active --quiet bluetooth 2>/dev/null; then
      echo "    bluetooth service enabled + running"
    else
      need_sudo systemctl enable --now bluetooth || warn "Could not start the bluetooth service"
    fi
  fi
  # rfkill: Raspberry Pi OS ships "options rfkill default_state=0"
  # (raspberrypi-sys-mods, /etc/modprobe.d/rfkill_default.conf): every radio,
  # Bluetooth included, starts soft-blocked at boot and systemd-rfkill restores
  # the last saved state (/var/lib/systemd/rfkill/*:bluetooth). Unblocking once
  # with root saves "0" there, so it stays unblocked across reboots. rfkill
  # lives in /usr/sbin (not on a normal user's PATH): state is read from sysfs.
  bt_rfkill() { # prints "soft hard" for the first bluetooth rfkill entry, or nothing
    local d
    for d in /sys/class/rfkill/rfkill*; do
      [[ -r "$d/type" ]] && [[ "$(cat "$d/type")" == bluetooth ]] && { echo "$(cat "$d/soft") $(cat "$d/hard")"; return; }
    done
  }
  RFKILL_BIN="$(PATH="$PATH:/usr/sbin:/sbin" command -v rfkill || true)"
  if [[ -z "$RFKILL_BIN" ]] && ! dpkg -s rfkill >/dev/null 2>&1; then
    need_sudo apt-get install -y --no-install-recommends rfkill || warn "Could not install rfkill"
    RFKILL_BIN="$(PATH="$PATH:/usr/sbin:/sbin" command -v rfkill || true)"
  fi
  RF="$(bt_rfkill)"
  if [[ -z "$RF" ]]; then
    echo "    no Bluetooth rfkill entry (no adapter yet, or Bluetooth disabled in config.txt)"
  elif [[ "${RF#* }" == 1 ]]; then
    warn "Bluetooth is hard-blocked (hardware / firmware switch); software cannot unblock it"
  elif [[ "${RF% *}" == 1 ]]; then
    log "Unblocking Bluetooth (rfkill, soft block)"
    if [[ -n "$RFKILL_BIN" ]]; then need_sudo "$RFKILL_BIN" unblock bluetooth || true; fi
    sleep 1
    if [[ "$(bt_rfkill)" == "0 "* ]]; then
      echo "    Bluetooth unblocked"
    else
      warn "Bluetooth is still soft-blocked: run sudo rfkill unblock bluetooth"
    fi
  else
    echo "    Bluetooth not rfkill-blocked"
  fi
  # Persistence: systemd-rfkill saves the state on every change. Make sure the
  # saved Bluetooth state is "unblocked" and that boot restores it.
  if [[ -n "$RF" && "$(bt_rfkill)" == "0 "* ]]; then
    for f in /var/lib/systemd/rfkill/*:bluetooth; do
      [[ -e "$f" ]] || continue
      if [[ "$(need_sudo cat "$f" 2>/dev/null)" != 0 ]]; then
        echo "    saved rfkill state $f -> 0 (unblocked at boot)"
        echo 0 | need_sudo tee "$f" >/dev/null || warn "Could not write $f"
      fi
    done
    if systemctl is-enabled systemd-rfkill.socket 2>/dev/null | grep -qx masked || systemctl is-enabled systemd-rfkill.service 2>/dev/null | grep -qx masked; then
      warn "systemd-rfkill is masked: the Bluetooth unblock will not survive a reboot (sudo systemctl unmask systemd-rfkill.socket systemd-rfkill.service)"
    fi
    if grep -qw "systemd.restore_state=0" /proc/cmdline 2>/dev/null; then
      warn "kernel cmdline has systemd.restore_state=0: rfkill state is not restored at boot, so Bluetooth may start blocked (remove it from /boot/firmware/cmdline.txt)"
    fi
  fi
  for CFG in /boot/firmware/config.txt /boot/config.txt; do
    if [[ -r "$CFG" ]] && sed 's/#.*//' "$CFG" | grep -Eqi '^[[:space:]]*dtoverlay[[:space:]]*=[[:space:]]*(pi3-)?disable-bt'; then
      warn "Bluetooth is disabled in $CFG (dtoverlay=disable-bt): remove that line and reboot to use a Bluetooth TNC"
    fi
  done
  if [[ -n "$RF" && "$(bt_rfkill)" == "0 "* ]] && command -v bluetoothctl >/dev/null 2>&1; then
    if ! bluetoothctl show 2>/dev/null | grep -q "Powered: yes"; then
      for d in 0.5 1 2 4; do # Busy right after an unblock while the adapter initializes
        bluetoothctl power on 2>&1 | grep -q "succeeded" && break
        sleep "$d"
      done
      bluetoothctl show 2>/dev/null | grep -q "Powered: yes" && echo "    Bluetooth adapter powered on" || warn "Bluetooth adapter did not power on (try: sudo systemctl restart bluetooth)"
    fi
  fi
  if getent group bluetooth >/dev/null 2>&1; then
    if id -nG "${APP_USER}" | tr ' ' '\n' | grep -qx bluetooth; then
      echo "    ${APP_USER} already in bluetooth"
    else
      log "Adding ${APP_USER} to bluetooth (list paired Bluetooth TNCs)"
      need_sudo usermod -aG bluetooth "${APP_USER}"
      warn "bluetooth membership applies on next login / service restart after re-login"
    fi
  fi
  if command -v python3 >/dev/null 2>&1 && ! python3 -c "import socket; socket.AF_BLUETOOTH; socket.BTPROTO_RFCOMM" >/dev/null 2>&1; then
    warn "python3 has no Bluetooth RFCOMM sockets here; Bluetooth KISS connections will not work"
  fi
  echo "    pair the radio in Configure → KISS / APRS → Scan / Pair (or bluetoothctl, docs/APRS.md)"
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
NODE_BIN="$(command -v node)"

write_user_service() {
  local unit_dir="${APP_HOME}/.config/systemd/user"
  mkdir -p "${unit_dir}"

  log "Writing systemd user unit ${unit_dir}/${SERVICE_NAME}.service"
  cat > "${unit_dir}/${SERVICE_NAME}.service" <<UNIT
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
}

if [[ $INSTALL_SERVICE -eq 1 && $UPDATE_ONLY -eq 0 ]]; then
  write_user_service

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

# --update: rewrite and restart service if present
if [[ $UPDATE_ONLY -eq 1 && $INSTALL_SERVICE -eq 1 ]]; then
  ensure_user_systemd
  if systemctl --user list-unit-files "${SERVICE_NAME}.service" 2>/dev/null | grep -q "${SERVICE_NAME}"; then
    write_user_service
    log "Refreshing ${SERVICE_NAME} service"
    systemctl --user daemon-reload
    systemctl --user enable "${SERVICE_NAME}.service"
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

  Bluetooth KISS (TH-D74/D75)
    Pair once: bluetoothctl → pair <MAC> → trust <MAC>; then Configure →
    KISS / APRS → Kenwood TH-D74/D75. Details: docs/APRS.md

============================================================
SUM
