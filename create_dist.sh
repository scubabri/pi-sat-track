#!/usr/bin/env bash
# Build a self-extracting archive for pi-sat-track that extracts + installs.
# Usage:
#   ./build-sfx.sh [path-to-app-tree]
# Default: ./pi-sat-track  or current dir if it has package.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-}"

if [[ -z "${SRC}" ]]; then
  if [[ -f "${SCRIPT_DIR}/pi-sat-track/package.json" ]]; then
    SRC="${SCRIPT_DIR}/pi-sat-track"
  elif [[ -f "${SCRIPT_DIR}/package.json" ]]; then
    SRC="${SCRIPT_DIR}"
  else
    echo "Usage: $0 /path/to/pi-sat-track" >&2
    exit 1
  fi
fi

SRC="$(cd "${SRC}" && pwd)"
[[ -f "${SRC}/package.json" ]] || { echo "No package.json in ${SRC}" >&2; exit 1; }
[[ -f "${SRC}/install-pi.sh" ]] || { echo "No install-pi.sh in ${SRC}" >&2; exit 1; }

OUT_DIR="${SCRIPT_DIR}"
PAYLOAD="${OUT_DIR}/payload.tar.gz"
HEADER="${OUT_DIR}/sfx-header.sh"
RUNFILE="${OUT_DIR}/pi-sat-track-alpha.run"

echo "==> Archiving ${SRC} as top-level pi-sat-track/"
PARENT="$(dirname "${SRC}")"
BASE="$(basename "${SRC}")"

tar -czf "${PAYLOAD}" \
  --exclude='.git' \
  --exclude='.git/*' \
  --exclude='node_modules' \
  --exclude='node_modules/*' \
  --exclude='.rpitrack' \
  --transform "s,^${BASE},pi-sat-track," \
  -C "${PARENT}" "${BASE}"

echo "==> Writing extractor + installer header"
cat > "${HEADER}" << 'EOF'
#!/usr/bin/env bash
# Self-extracting pi-sat-track archive — extract then run install-pi.sh
set -euo pipefail

DEST="$(cd "$(dirname "$0")" && pwd)"
APP="${DEST}/pi-sat-track"
ARCHIVE_LINE="$(awk '/^__ARCHIVE__$/{print NR + 1; exit 0;}' "$0")"

if [[ -z "${ARCHIVE_LINE}" ]]; then
  echo "ERROR: archive marker not found" >&2
  exit 1
fi

echo "Extracting to ${APP} ..."
tail -n +"${ARCHIVE_LINE}" "$0" | tar -xzf - -C "${DEST}"

if [[ ! -d "${APP}" ]]; then
  echo "ERROR: ${APP} missing after extract" >&2
  exit 1
fi

if [[ ! -f "${APP}/install-pi.sh" ]]; then
  echo "ERROR: install-pi.sh not found in ${APP}" >&2
  exit 1
fi

chmod +x "${APP}/install-pi.sh"

echo
echo "Running installer ..."
echo "============================================================"
cd "${APP}"
# Pass through any flags given to the .run file (e.g. --no-nginx)
./install-pi.sh "$@"

echo
echo "============================================================"
echo "Extract + install finished."
echo "App: ${APP}"
exit 0
__ARCHIVE__
EOF

echo "==> Assembling ${RUNFILE}"
cat "${HEADER}" "${PAYLOAD}" > "${RUNFILE}"
chmod +x "${RUNFILE}"
rm -f "${PAYLOAD}" "${HEADER}"

echo
echo "Created: ${RUNFILE}"
echo "Size:    $(du -h "${RUNFILE}" | awk '{print $1}')"
echo
echo "On the Pi:"
echo "  chmod +x pi-sat-track-alpha.run"
echo "  ./pi-sat-track-alpha.run"
echo "  # or with flags:"
echo "  ./pi-sat-track-alpha.run --no-nginx"
