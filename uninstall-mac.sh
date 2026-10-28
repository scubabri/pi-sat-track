#!/usr/bin/env bash
# =============================================================================
# Pi Sat Track - macOS uninstall
#   ./uninstall-mac.sh            remove the app folder (settings in ~/.rpitrack kept)
#   ./uninstall-mac.sh --data     also delete ~/.rpitrack (profiles, offsets, logs)
#   ./uninstall-mac.sh --yes      no confirmation prompt
# Node.js is left installed (brew uninstall node, or see nodejs.org, to remove).
# =============================================================================
set -euo pipefail

DATA=0
YES=0
for a in "$@"; do
  case "$a" in
    --data|--all) DATA=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a (try --help)" >&2; exit 1 ;;
  esac
done

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="$HOME/.rpitrack"
[[ -f "$APP_DIR/package.json" && -f "$APP_DIR/server.js" ]] || { echo "ERROR: not a Pi Sat Track folder: $APP_DIR" >&2; exit 1; }
[[ "$APP_DIR" != "$HOME" && "$APP_DIR" != "/" ]] || { echo "ERROR: refusing to delete $APP_DIR" >&2; exit 1; }

if lsof -nP -iTCP:3000 -sTCP:LISTEN 2>/dev/null | grep -q node; then
  echo "Pi Sat Track seems to be running (port 3000). Stop it first (Ctrl+C in its Terminal window)." >&2
  exit 1
fi

echo "This removes:  $APP_DIR"
if [[ $DATA -eq 1 ]]; then echo "          and:  $CACHE_DIR  (all profiles and settings)"
else echo "Kept:          $CACHE_DIR  (use --data to delete it too)"; fi
if [[ $YES -eq 0 ]]; then
  read -r -p "Type YES to continue: " ans
  [[ "$ans" == YES ]] || { echo "Cancelled."; exit 0; }
fi

cd "$HOME"
rm -rf "$APP_DIR"
echo "Removed $APP_DIR"
if [[ $DATA -eq 1 && -d "$CACHE_DIR" ]]; then rm -rf "$CACHE_DIR"; echo "Removed $CACHE_DIR"; fi
echo "Done. Node.js was left installed."
