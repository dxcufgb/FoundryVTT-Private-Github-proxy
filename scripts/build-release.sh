#!/usr/bin/env bash
# Builds the release archives and their checksums from the working tree:
#
#   ./scripts/build-release.sh [OUT_DIR]       (default: dist)
#
#   OUT_DIR/foundry-release-proxy-<version>.tar.gz   for Linux
#   OUT_DIR/foundry-release-proxy-<version>.zip      for Windows
#   OUT_DIR/SHA256SUMS                               sha256sum of both (checked by the auto-updater)
#
# Both archives hold one folder, foundry-release-proxy-<version>/, with src/, scripts/, package.json, the README
# and the example config files. Needs tar, zip and sha256sum (all present on GitHub's Ubuntu runners).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${1:-dist}" && cd "${1:-dist}" && pwd)"
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "package.json version '$VERSION' is not MAJOR.MINOR.PATCH" >&2
    exit 1
fi
NAME="foundry-release-proxy-${VERSION}"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/$NAME"
cp -r "$ROOT/src" "$ROOT/scripts" "$ROOT/package.json" "$ROOT/README.md" \
    "$ROOT/config.example.json" "$ROOT/.env.example" "$stage/$NAME/"
chmod 755 "$stage/$NAME"/scripts/*.sh

rm -f "$OUT/$NAME.tar.gz" "$OUT/$NAME.zip" "$OUT/SHA256SUMS"
tar -C "$stage" --owner=0 --group=0 --numeric-owner --sort=name -czf "$OUT/$NAME.tar.gz" "$NAME"
(cd "$stage" && zip -qrX "$OUT/$NAME.zip" "$NAME")
(cd "$OUT" && sha256sum "$NAME.tar.gz" "$NAME.zip" > SHA256SUMS)
echo "Built $OUT/$NAME.tar.gz, $OUT/$NAME.zip and $OUT/SHA256SUMS"
