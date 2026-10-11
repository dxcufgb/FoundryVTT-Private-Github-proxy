#!/usr/bin/env bash
# Builds the release archives and their checksums from the working tree:
#
#   ./scripts/build-release.sh [OUT_DIR]       (default: dist)
#
#   OUT_DIR/foundry-release-proxy-<version>.tar.gz   for Linux
#   OUT_DIR/foundry-release-proxy-<version>.zip      for Windows
#   OUT_DIR/foundry-release-proxy-linux.tar.gz       the same files under a fixed name, so that
#   OUT_DIR/foundry-release-proxy-windows.zip        .../releases/latest/download/<name> always points at the newest release
#   OUT_DIR/SHA256SUMS                               sha256sum of all four (the auto-updater checks the versioned names)
#
# Both archives hold one folder, foundry-release-proxy-<version>/, with src/, scripts/, install.sh, package.json, the README
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
cp -r "$ROOT/src" "$ROOT/scripts" "$ROOT/install.sh" "$ROOT/package.json" "$ROOT/README.md" \
    "$ROOT/config.example.json" "$ROOT/.env.example" "$stage/$NAME/"
chmod 755 "$stage/$NAME"/install.sh "$stage/$NAME"/scripts/*.sh

LINUX="foundry-release-proxy-linux.tar.gz"
WINDOWS="foundry-release-proxy-windows.zip"
rm -f "$OUT/$NAME.tar.gz" "$OUT/$NAME.zip" "$OUT/$LINUX" "$OUT/$WINDOWS" "$OUT/SHA256SUMS"
tar -C "$stage" --owner=0 --group=0 --numeric-owner --sort=name -czf "$OUT/$NAME.tar.gz" "$NAME"
(cd "$stage" && zip -qrX "$OUT/$NAME.zip" "$NAME")
cp "$OUT/$NAME.tar.gz" "$OUT/$LINUX"
cp "$OUT/$NAME.zip" "$OUT/$WINDOWS"
(cd "$OUT" && sha256sum "$NAME.tar.gz" "$NAME.zip" "$LINUX" "$WINDOWS" > SHA256SUMS)
echo "Built $OUT/$NAME.tar.gz, $OUT/$NAME.zip, $OUT/$LINUX, $OUT/$WINDOWS and $OUT/SHA256SUMS"
