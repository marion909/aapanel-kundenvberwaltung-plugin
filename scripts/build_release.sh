#!/usr/bin/env bash
# Baut das installierbare Plugin-ZIP: build/customer_mgr-v<VERSION>.zip
#
#   scripts/build_release.sh 1.2.3
#
# Das ZIP enthält den Ordner customer_mgr/ (info.json + install.sh darin), so wie
# ihn aaPanel beim Import unter App Store -> Plugin importieren erwartet bzw. wie
# er nach /www/server/panel/plugin/customer_mgr entpackt wird.
# Die Versionsnummer wird in info.json und portal/package.json eingetragen.
set -euo pipefail

VERSION="${1:?Version fehlt, z. B. scripts/build_release.sh 1.2.3}"
VERSION="${VERSION#v}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Ungültige Version: $VERSION (erwartet X.Y.Z)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NAME=customer_mgr
OUT="$ROOT/build"
STAGE="$OUT/stage/$NAME"

rm -rf "$OUT/stage"
mkdir -p "$STAGE"

# Nur versionierte Dateien, ohne Entwicklungs-/CI-Dateien und Tests
git ls-files -z | while IFS= read -r -d '' f; do
  case "$f" in
    .github/*|scripts/*|tests/*|portal/test/*|.gitignore|*.md) ;;
    *) mkdir -p "$STAGE/$(dirname "$f")"; cp -p "$f" "$STAGE/$f" ;;
  esac
done
# Deployment-Anleitung des Portals gehört ins Paket
cp -p portal/README.md "$STAGE/portal/README.md"

python3 - "$STAGE" "$VERSION" <<'PY'
import json, sys, time
stage, version = sys.argv[1], sys.argv[2]
p = stage + '/info.json'
info = json.load(open(p, encoding='utf-8'))
info['versions'] = version
info['date'] = time.strftime('%Y-%m-%d')
json.dump(info, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
p = stage + '/portal/package.json'
pkg = json.load(open(p, encoding='utf-8'))
pkg['version'] = version
json.dump(pkg, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY

ZIP="$OUT/${NAME}-v${VERSION}.zip"
rm -f "$ZIP"
(cd "$OUT/stage" && zip -qr -X "$ZIP" "$NAME")
rm -rf "$OUT/stage"
echo "$ZIP"
