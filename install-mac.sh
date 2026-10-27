#!/usr/bin/env bash
# =============================================================================
# Pi Sat Track - macOS install / update (macOS 12+, Apple Silicon or Intel)
# Run from the app folder (git checkout or extracted zip), as your normal user:
#   cd ~/pi-sat-track && ./install-mac.sh            install
#   ./install-mac.sh --update                         git pull (checkout) + npm
#   ./install-mac.sh --dry-run                        show what would happen
# Sets up the app where it is (no copy), no background service, no sudo.
# Settings stay in ~/.rpitrack. Start it with: node server.js
# =============================================================================
set -euo pipefail

NODE_MAJOR=22
PORT=3000
UPDATE=0
DRY=0

die()  { echo "ERROR: $*" >&2; exit 1; }
log()  { echo; echo "==> $*"; }
run()  { if [[ $DRY -eq 1 ]]; then echo "    [dry-run] $*"; else "$@"; fi; }

for a in "$@"; do
  case "$a" in
    --update)  UPDATE=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "Unknown option: $a (try --help)" ;;
  esac
done

[[ "$(uname -s)" == Darwin || $DRY -eq 1 ]] || die "This is the macOS installer (use install-pi.sh on Linux)."
[[ "$(id -u)" -ne 0 ]] || die "Run as your normal user, not with sudo."

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$APP_DIR/package.json" && -f "$APP_DIR/server.js" ]] \
  || die "Cannot find package.json + server.js in $APP_DIR. Run this from the full app folder."
CACHE_DIR="$HOME/.rpitrack"

echo "Pi Sat Track macOS $( [[ $UPDATE -eq 1 ]] && echo update || echo install ) - app: $APP_DIR ($(uname -m))"

# ---- Node.js (>= NODE_MAJOR) ----
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }
if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt $NODE_MAJOR ]]; then
  # Homebrew is not always on PATH in a fresh shell
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [[ -x "$b" ]] && eval "$("$b" shellenv)" && break
  done
  if command -v brew >/dev/null 2>&1; then
    log "Installing Node.js with Homebrew (brew install node)"
    run brew install node
  else
    cat >&2 <<MSG

Node.js $NODE_MAJOR or newer is required ($(command -v node >/dev/null && node -v || echo "not installed")).
Install it, then run this script again:
  - Download the macOS installer (LTS) from https://nodejs.org/
  - or install Homebrew (https://brew.sh) and run: brew install node
MSG
    exit 1
  fi
fi
if [[ $DRY -eq 0 ]]; then
  [[ "$(node_major)" -ge $NODE_MAJOR ]] || die "Node.js $NODE_MAJOR+ needed, found $(node -v)."
  echo "    node $(node -v), npm $(npm -v)"
fi

# ---- update the app files (git checkout only; a zip: extract the new one over this folder first) ----
if [[ $UPDATE -eq 1 && -d "$APP_DIR/.git" ]]; then
  log "Updating app files (git pull --ff-only)"
  run git -C "$APP_DIR" pull --ff-only
fi

# ---- data folder (kept on update and by default on uninstall) ----
run mkdir -p "$CACHE_DIR"

# ---- npm (serialport ships prebuilt binaries for Apple Silicon and Intel) ----
log "npm install in $APP_DIR"
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  run npm ci --omit=dev || run npm install --omit=dev
else
  run npm install --omit=dev
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

cat <<SUM

============================================================
  Pi Sat Track is installed. Settings / data: $CACHE_DIR

  Start:     cd "$APP_DIR" && node server.js
  Open:      http://127.0.0.1:$PORT$( [[ -n "$LAN_IP" ]] && printf '\n             http://%s:%s  (other devices on your network)' "$LAN_IP" "$PORT" )
  Stop:      Ctrl+C in that Terminal window
  Update:    cd "$APP_DIR" && ./install-mac.sh --update
  Uninstall: cd "$APP_DIR" && ./uninstall-mac.sh   (--data also deletes $CACHE_DIR)

  Serial radios / rotors: /dev/cu.usbserial-* or /dev/cu.usbmodem*
  (some USB-serial adapters need the vendor's macOS driver).
============================================================
SUM
