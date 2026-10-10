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
  --transform "s,^${BASE},pi-sat-track," \
  -C "${PARENT}" "${BASE}"

echo "==> Writing extractor + installer header"
cat > "${HEADER}" << EOF
#!/usr/bin/env bash
# Self-extracting pi-sat-track archive — extract then run install-pi.sh
# Build: ${VERSION_LABEL}
set -euo pipefail

PI_SAT_TRACK_VERSION="${VERSION_LABEL}"
PI_SAT_TRACK_BRANCH="${BRANCH}"
DEST="\$(cd "\$(dirname "\$0")" && pwd)"
APP="\${DEST}/pi-sat-track"
ARCHIVE_LINE="\$(awk '/^__ARCHIVE__\$/{print NR + 1; exit 0;}' "\$0")"
if [[ -z "\${ARCHIVE_LINE}" ]]; then
  echo "ERROR: archive marker not found" >&2
  exit 1
fi

echo "pi-sat-track \${PI_SAT_TRACK_VERSION}"
echo "Extracting to \${APP} ..."
tail -n +"\${ARCHIVE_LINE}" "\$0" | tar -xzf - -C "\${DEST}"
if [[ ! -d "\${APP}" ]]; then
  echo "ERROR: \${APP} missing after extract" >&2
  exit 1
fi
if [[ ! -f "\${APP}/install-pi.sh" ]]; then
  echo "ERROR: install-pi.sh not found in \${APP}" >&2
  exit 1
fi
chmod +x "\${APP}/install-pi.sh"

# Record installed version in ~/.rpitrack (and app tree)
RPITRACK="\${HOME}/.rpitrack"
mkdir -p "\${RPITRACK}"
echo "\${PI_SAT_TRACK_VERSION}" > "\${RPITRACK}/version"
echo "\${PI_SAT_TRACK_BRANCH}" > "\${RPITRACK}/branch"
echo "\${PI_SAT_TRACK_VERSION}" > "\${APP}/VERSION"
echo "\${PI_SAT_TRACK_VERSION}" > "\${APP}/version.txt"
echo "Recorded version \${PI_SAT_TRACK_VERSION} → \${RPITRACK}/version"

echo
echo "Running installer ..."
echo "============================================================"
cd "\${APP}"
./install-pi.sh "\$@"
echo
echo "============================================================"
echo "Extract + install finished."
echo "App:     \${APP}"
echo "Version: \${PI_SAT_TRACK_VERSION}"
echo "Branch:  \${PI_SAT_TRACK_BRANCH}"
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
echo "On the Pi:"
echo "  chmod +x pi-sat-track-${BRANCH}-alpha.${VERSION}.run"
echo "  ./pi-sat-track-${BRANCH}-alpha.${VERSION}.run"
