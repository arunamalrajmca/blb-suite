#!/usr/bin/env bash
set -euo pipefail

VERSION="$1"
mkdir -p "$2"
OUT_DIR="$(cd "$2" && pwd)"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
OUT_FILE="$OUT_DIR/Blue-Letter-Bible-Suite-${VERSION}.zip"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
STAGED_EXT="$STAGE_DIR/extension"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE" "$OUT_FILE.sha256"

node - "$EXT_DIR/manifest.json" "$VERSION" "$STAGED_EXT" <<'NODE'
const fs = require('fs');
const path = require('path');
const [manifestPath, expected, stagedDir] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.version !== expected) {
  throw new Error('manifest version ' + manifest.version + ' does not match release ' + expected);
}
if (manifest.manifest_version !== 3) {
  throw new Error('release is not an MV3 extension');
}
fs.mkdirSync(stagedDir, { recursive: true });
NODE

# Build a separate Chrome Web Store package. Keep chatgpt.com access in the
# source manifest for the developer's local unpacked installation, but never
# include that required host permission in the publicly distributed store ZIP.
cp -a "$EXT_DIR/." "$STAGED_EXT/"
node - "$STAGED_EXT/manifest.json" <<'NODE'
const fs = require('fs');
const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = (manifest.host_permissions || [])
  .filter(host => host !== 'https://chatgpt.com/*');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
if ((manifest.host_permissions || []).includes('https://chatgpt.com/*')) {
  throw new Error('Chrome Web Store package must not require chatgpt.com host access');
}
NODE

SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT_DIR" show -s --format=%ct HEAD)}"
find "$STAGED_EXT" -type f -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

(
  cd "$STAGED_EXT"
  find . -type f -print0 | sort -z | tr '\0' '\n' | sed 's#^./##' |
    zip -X -q "$OUT_FILE" -@
)

sha256sum "$OUT_FILE" | tee "$OUT_FILE.sha256"
