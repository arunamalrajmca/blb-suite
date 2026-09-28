#!/usr/bin/env bash
set -euo pipefail

VERSION="$1"
mkdir -p "$2"
OUT_DIR="$(cd "$2" && pwd)"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
OUT_FILE="$OUT_DIR/Blue-Letter-Bible-Suite-${VERSION}.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE" "$OUT_FILE.sha256"

node - "$EXT_DIR/manifest.json" "$VERSION" <<'NODE'
const fs = require('fs');
const [manifestPath, expected] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.version !== expected) {
  throw new Error('manifest version ' + manifest.version + ' does not match release ' + expected);
}
if (manifest.manifest_version !== 3) {
  throw new Error('release is not an MV3 extension');
}
NODE

SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT_DIR" show -s --format=%ct HEAD)}"
find "$EXT_DIR" -type f -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

(
  cd "$EXT_DIR"
  find . -type f -print0 | sort -z | tr '\0' '\n' | sed 's#^./##' |
    zip -X -q "$OUT_FILE" -@
)

sha256sum "$OUT_FILE" | tee "$OUT_FILE.sha256"
