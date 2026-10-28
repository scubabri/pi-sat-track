#!/usr/bin/env bash
# Build a versioned self-extracting archive for pi-sat-track.
# Usage:
#   ./build-sfx.sh [path-to-app-tree]
# Env:
#   VERSION   alpha build number (default: 0)
#   BRANCH    git branch name (default: unknown) — sanitized for filenames
#   OUT_DIR   output directory (default: script dir)
#
# Produces:
#   pi-sat-track-<BRANCH>-alpha.<VERSION>.run
#
# Version stamp written to tree + by the .run into ~/.rpitrack/version:
#   <BRANCH>-alpha.<VERSION>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-}"
VERSION="${VERSION:-0}"
VERSION="$(echo "${VERSION}" | tr -cd '0-9.')"
[[ -n "${VERSION}" ]] || VERSION="0"

# Sanitize branch for filenames: keep alnum, dot, underscore, hyphen
BRANCH_RAW="${BRANCH:-unknown}"
BRANCH="$(echo "${BRANCH_RAW}" | sed 's#refs/heads/##' | tr -c 'A-Za-z0-9._-' '-' | sed 's/--*/-/g;s/^-//;s/-$//')"
[[ -n "${BRANCH}" ]] || BRANCH="unknown"

VERSION_LABEL="${BRANCH}-alpha.${VERSION}"

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

OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}}"
mkdir -p "${OUT_DIR}"
PAYLOAD="${OUT_DIR}/payload.tar.gz"
HEADER="${OUT_DIR}/sfx-header.sh"
RUN_VER="${OUT_DIR}/pi-sat-track-${BRANCH}-alpha.${VERSION}.run"

# Stamp VERSION into the tree so extract always has it
echo "${VERSION_LABEL}" > "${SRC}/VERSION"
echo "${VERSION_LABEL}" > "${SRC}/version.txt"

echo "==> Version label: ${VERSION_LABEL}"
echo "==> Branch:        ${BRANCH}"
echo "==> Archiving ${SRC} as top-level pi-sat-track/"
PARENT="$(dirname "${SRC}")"
BASE="$(basename "${SRC}")"
tar -czf "${PAYLOAD}" \
  --exclude='.git' \
  --exclude='.git/*' \
  --exclude='node_modules' \
  --exclude='node_modules/*' \
  --exclude='.rpitrack' \
  --exclude='.github' \
  --exclude='.github/*' \
  --exclude='dist' \
  --exclude='dist/*' \
  --exclude='build-sfx.sh' \
  --exclude='*.run' \
  --exclude='build-sfx.meta' \
  --exclude="${BASE}/test" \
  --exclude="${BASE}/.gitignore" \
  --exclude="${BASE}/create_dist.sh" \
  --exclude='server.log*' \
  --transform "s,^${BASE},pi-sat-track," \
  -C "${PARENT}" "${BASE}"

echo "==> Writing extractor + installer header"
# Build-time values first (expanded now), then the stub body (quoted heredoc,
# copied as is). The stub must run on macOS too: bash 3.2 + BSD tools only.
cat > "${HEADER}" << EOF
#!/usr/bin/env bash
# Self-extracting pi-sat-track archive: detect the platform, extract, install.
#   Raspberry Pi / Linux: extract next to this .run, run install-pi.sh
#   macOS:                extract to ~/pi-sat-track, run install-mac.sh
# Build: ${VERSION_LABEL}
PI_SAT_TRACK_VERSION="${VERSION_LABEL}"
PI_SAT_TRACK_BRANCH="${BRANCH}"
EOF
cat >> "${HEADER}" << 'EOF'
# Options (all others go to the platform installer, e.g. --update, --no-nginx):
#   --print-platform   show what was detected and where it would install; no changes
# Test overrides: PST_FORCE_PLATFORM=pi|linux|mac|other  PST_FORCE_MODEL="..."
#                 PST_MAC_DEST=<dir>  (macOS app folder parent, default $HOME)
set -euo pipefail

PRINT_ONLY=0
if [ "${1:-}" = "--print-platform" ]; then PRINT_ONLY=1; shift; fi

# ---- platform detection ----
OS="$(uname -s)"
ARCH="$(uname -m)"
MODEL=""
for f in /proc/device-tree/model /sys/firmware/devicetree/base/model; do
  if [ -r "$f" ]; then MODEL="$(tr -d '\000' < "$f")"; break; fi
done
MODEL="${PST_FORCE_MODEL:-$MODEL}"
PLATFORM="${PST_FORCE_PLATFORM:-}"
if [ -z "$PLATFORM" ]; then
  case "$OS" in
    Darwin) PLATFORM=mac ;;
    Linux)  case "$MODEL" in *"Raspberry Pi"*) PLATFORM=pi ;; *) PLATFORM=linux ;; esac ;;
    *)      PLATFORM=other ;;
  esac
fi
case "$PLATFORM" in
  pi)    echo "Detected Raspberry Pi (${MODEL:-unknown model})" ;;
  linux) DISTRO="$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-$ID}") || echo unknown distro)"
         echo "Detected Linux ($ARCH, $DISTRO)" ;;
  mac)   echo "Detected macOS ($ARCH)" ;;
  *)     echo "ERROR: unsupported system: $OS $ARCH." >&2
         echo "This installer is for Raspberry Pi, Linux and macOS. On Windows use install-win.bat (docs/Home.md)." >&2
         exit 1 ;;
esac

if [ "$PLATFORM" = mac ]; then
  DEST="${PST_MAC_DEST:-$HOME}"
  INSTALLER=install-mac.sh
else
  # Pi / Linux: next to this .run, as always
  DEST="$(cd "$(dirname "$0")" && pwd)"
  INSTALLER=install-pi.sh
fi
APP="${DEST}/pi-sat-track"

# Per-OS files: install only this platform's installer files (paths relative to the app folder).
# Runtime files (server.js, lib/, js/, ...) are shared and always installed.
WIN_ONLY="install-win.bat uninstall-win.bat open-when-ready.ps1 win-network.ps1 installer"
MAC_ONLY="install-mac.sh uninstall-mac.sh"
PI_ONLY="install-pi.sh"
REPO_ONLY=".gitattributes"
if [ "$PLATFORM" = mac ]; then DROP="$WIN_ONLY $PI_ONLY $REPO_ONLY"; else DROP="$WIN_ONLY $MAC_ONLY $REPO_ONLY"; fi

echo "pi-sat-track ${PI_SAT_TRACK_VERSION}"
if [ "$PLATFORM" = mac ] && [ -e "${APP}/.git" ]; then
  echo "ERROR: ${APP} is a git checkout; not extracting a release over it." >&2
  echo "Update it with: cd ${APP} && ./install-mac.sh --update   (or set PST_MAC_DEST=<other folder>)" >&2
  exit 1
fi
if [ "$PRINT_ONLY" -eq 1 ]; then
  echo "Would extract to ${APP} and run ${INSTALLER}${1:+ $*}"
  echo "Skipped (other OS): ${DROP}"
  [ -d "$APP" ] && echo "(existing install there: updated in place; ~/.rpitrack is kept)"
  exit 0
fi

ARCHIVE_LINE="$(awk '/^__ARCHIVE__$/{print NR + 1; exit 0;}' "$0")"
if [ -z "${ARCHIVE_LINE}" ]; then
  echo "ERROR: archive marker not found" >&2
  exit 1
fi

mkdir -p "${DEST}"
echo "Extracting to ${APP} ..."
set -f  # DROP holds plain names; no globbing
EXCL=""
for f in $DROP; do EXCL="$EXCL --exclude=pi-sat-track/$f"; done
# shellcheck disable=SC2086
tail -n +"${ARCHIVE_LINE}" "$0" | tar -xzf - $EXCL -C "${DEST}"
# An earlier .run left the other OS's files: remove them (never in a git checkout).
if [ ! -e "${APP}/.git" ]; then
  for f in $DROP; do
    [ -e "${APP}/$f" ] && rm -rf "${APP:?}/$f" && echo "  removed ${f} (not used on this OS)"
  done
fi
set +f
if [ ! -d "${APP}" ]; then
  echo "ERROR: ${APP} missing after extract" >&2
  exit 1
fi
if [ ! -f "${APP}/${INSTALLER}" ]; then
  echo "ERROR: ${INSTALLER} not found in ${APP}" >&2
  exit 1
fi
chmod +x "${APP}/${INSTALLER}"
[ -f "${APP}/uninstall-mac.sh" ] && chmod +x "${APP}/uninstall-mac.sh"

# Record installed version in ~/.rpitrack (and app tree): /api/version label
RPITRACK="${HOME}/.rpitrack"
mkdir -p "${RPITRACK}"
echo "${PI_SAT_TRACK_VERSION}" > "${RPITRACK}/version"
echo "${PI_SAT_TRACK_BRANCH}" > "${RPITRACK}/branch"
echo "${PI_SAT_TRACK_VERSION}" > "${APP}/VERSION"
echo "${PI_SAT_TRACK_VERSION}" > "${APP}/version.txt"
echo "Recorded version ${PI_SAT_TRACK_VERSION} → ${RPITRACK}/version"

echo
echo "Running installer ..."
echo "============================================================"
cd "${APP}"
./"${INSTALLER}" ${1+"$@"}
echo
echo "============================================================"
echo "Extract + install finished."
echo "App:     ${APP}"
echo "Version: ${PI_SAT_TRACK_VERSION}"
echo "Branch:  ${PI_SAT_TRACK_BRANCH}"
exit 0
__ARCHIVE__
EOF

echo "==> Assembling ${RUN_VER}"
cat "${HEADER}" "${PAYLOAD}" > "${RUN_VER}"
chmod +x "${RUN_VER}"
rm -f "${PAYLOAD}" "${HEADER}"

# Emit names for CI
echo "run_file=$(basename "${RUN_VER}")" > "${OUT_DIR}/build-sfx.meta"
echo "version_label=${VERSION_LABEL}" >> "${OUT_DIR}/build-sfx.meta"
echo "branch=${BRANCH}" >> "${OUT_DIR}/build-sfx.meta"

echo
echo "Created: ${RUN_VER}"
echo "Label:   ${VERSION_LABEL}"
echo "Size:    $(du -h "${RUN_VER}" | awk '{print $1}')"
echo
echo "On a Pi, Linux or Mac (detects which):"
echo "  chmod +x pi-sat-track-${BRANCH}-alpha.${VERSION}.run"
echo "  ./pi-sat-track-${BRANCH}-alpha.${VERSION}.run"
