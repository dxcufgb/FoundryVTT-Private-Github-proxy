#!/usr/bin/env bash
# Prints the top of a release's notes: per-OS download links and install commands, as Markdown.
#
#   ./scripts/release-notes.sh VERSION OWNER/REPO > notes.md
#
# release.yml passes the file to `gh release create --notes-file ... --generate-notes`, so GitHub's list of merged pull
# requests follows it. The asset names must match scripts/build-release.sh and the installer step in release.yml.
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "usage: $0 VERSION OWNER/REPO" >&2
    exit 2
fi
VERSION="$1"
REPO="$2"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "version '$VERSION' is not MAJOR.MINOR.PATCH" >&2
    exit 1
fi
if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "repository '$REPO' is not OWNER/REPO" >&2
    exit 1
fi

TAG="v$VERSION"
BASE="https://github.com/$REPO/releases"
DL="$BASE/download/$TAG"
LATEST="$BASE/latest/download"

cat <<EOF
## Downloads

| OS | File | This release | Always the latest |
| --- | --- | --- | --- |
| Windows 10/11 (x64) | Installer, brings its own Node.js | [FoundryReleaseProxy-Setup-$VERSION.exe]($DL/FoundryReleaseProxy-Setup-$VERSION.exe) ([sha256]($DL/FoundryReleaseProxy-Setup-$VERSION.exe.sha256)) | [FoundryReleaseProxy-Setup.exe]($LATEST/FoundryReleaseProxy-Setup.exe) |
| Windows (manual / PowerShell) | Archive | [foundry-release-proxy-$VERSION.zip]($DL/foundry-release-proxy-$VERSION.zip) | [foundry-release-proxy-windows.zip]($LATEST/foundry-release-proxy-windows.zip) |
| Linux / Raspberry Pi (x64, arm64, armv7) | Archive with \`install.sh\` | [foundry-release-proxy-$VERSION.tar.gz]($DL/foundry-release-proxy-$VERSION.tar.gz) | [foundry-release-proxy-linux.tar.gz]($LATEST/foundry-release-proxy-linux.tar.gz) |

Checksums of the archives: [SHA256SUMS]($DL/SHA256SUMS).
The repository is private, so the links only work when you are signed in to GitHub with access to it;
on a headless machine use \`gh\` (below).

### Linux / Raspberry Pi

\`\`\`sh
gh release download $TAG --repo $REPO --pattern 'foundry-release-proxy-$VERSION.tar.gz' --pattern SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf foundry-release-proxy-$VERSION.tar.gz
cd foundry-release-proxy-$VERSION
sudo ./install.sh
\`\`\`

### Windows

Run \`FoundryReleaseProxy-Setup-$VERSION.exe\` and follow the wizard (it asks for administrator rights). Running it over an
existing install upgrades it and keeps the token and \`config.json\`. Unattended install and the manual PowerShell route are
in the README.

Installs with automatic updates turned on pick this release up within a day.
EOF
