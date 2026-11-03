# Maintainer notes

Maintainer notes, moved out of the README. User documentation is in the wiki.

## Releases

**Releasing**: *Actions → Release → Run workflow* → type the version (e.g. `1.2.3`; a leading `v` is dropped,
`1.2.3-rc.1` makes a pre-release). Fallback: publish a release `vX.Y.Z` on GitHub; the files are attached afterwards.
No version bump in the code: the version comes from the tag (`package.json` in the repository keeps the last release's
version; the build stamps the release version into the copy it packs).

`.github/workflows/release.yml` runs the whole CI (`ci.yml`: tests, shellcheck, PSScriptAnalyzer, a real `install.sh`
run and a silent install of the Windows installer), builds the archives with `scripts/build-release.sh dist <version>`,
builds the Windows installer on a Windows runner from the Windows archive (and installs and uninstalls it once), and only
then publishes the release. A manual run creates a draft on main's head and publishes it when everything is attached;
if a run fails, fix the cause and run it again: a draft left by the failed run is replaced. A published release is never
changed, and a run refuses to publish if the tag meanwhile points at a different commit than the one it built. For a
release published by hand the files are uploaded to it and the download table is put in front of its notes.

After publishing, the workflow asks the [Workshop site](https://github.com/dxcufgb/FVTT-dev-showcase) to rebuild (a
`module-released` repository dispatch) when the repository secret `SITE_DISPATCH_TOKEN` is set: a fine-grained token
with access to only `dxcufgb/FVTT-dev-showcase` and **Contents: Read and write**. Without it the site picks the
release up at its next 6-hourly build; a refused ping is only a warning.

Files of a release `X.Y.Z`:

| File | What |
| --- | --- |
| `foundry-release-proxy-X.Y.Z-linux.tar.gz` | Linux archive; one folder `foundry-release-proxy-X.Y.Z/` with `install.sh` at its top |
| `foundry-release-proxy-X.Y.Z-windows.zip` | Windows archive (same folder) |
| `foundry-release-proxy-X.Y.Z-setup.exe` | Windows setup wizard |
| `foundry-release-proxy-linux.tar.gz`, `foundry-release-proxy-windows.zip`, `foundry-release-proxy-setup.exe` | the same three under fixed names, so `releases/latest/download/<name>` links never change |
| `SHA256SUMS.txt` | `sha256sum` of every other file of the release |
| `foundry-release-proxy-X.Y.Z.tar.gz`, `foundry-release-proxy-X.Y.Z.zip`, `FoundryReleaseProxy-Setup-X.Y.Z.exe`, `FoundryReleaseProxy-Setup.exe` (+ `.sha256`), `SHA256SUMS` | legacy names of 1.1.1 and older, byte-identical copies, so the updaters of installed 1.1.1 and older keep working |

The legacy names are one marked block (`LEGACY_ASSETS`) in `scripts/build-release.sh`; it can go once every installation
runs 1.2.0 or newer. From 1.2.0 on, the updaters use only the new names (`-linux.tar.gz` / `-windows.zip` and
`SHA256SUMS.txt`); a newer release without them is reported as an error in the update log and nothing is installed.

The release notes start with a download table per OS (`scripts/release-notes.sh`: links to this release's files, the
always-latest links and the Linux install commands), followed by GitHub's list of merged pull requests.

**Stable per-OS links**:

| OS | Link |
| --- | --- |
| Windows installer | `https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/releases/latest/download/foundry-release-proxy-setup.exe` |
| Windows archive | `https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/releases/latest/download/foundry-release-proxy-windows.zip` |
| Linux / Raspberry Pi | `https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/releases/latest/download/foundry-release-proxy-linux.tar.gz` |

On a machine without a browser: `gh release download --repo dxcufgb/FoundryVTT-Private-Github-proxy --pattern
foundry-release-proxy-linux.tar.gz`, or the install one-liner in the README.

Build the same files locally with `./scripts/build-release.sh dist 9.9.9` (needs `tar`, `zip`, `sha256sum`; check them
with `cd dist && sha256sum -c SHA256SUMS.txt`) and the Windows installer with
`.\packaging\windows\build-installer.ps1 -Version 9.9.9` (needs Inno Setup 6.3+, e.g. `choco install innosetup`); then
`./scripts/build-release.sh --finish dist 9.9.9` adds the installer's copies and checksums.
CI also runs `install.sh` on an Ubuntu runner and the Windows installer on a Windows runner for every push.

## Development

`npm test` runs the unit tests (no dependencies to install).

The **Security** workflow (`.github/workflows/security.yml`; this repository is public, so GitHub's own secret scanning
and CodeQL (default setup) run on it too) runs on every pull request, on pushes to `main` and weekly: `Secrets (gitleaks)` scans the
whole git history, `Code (Semgrep)` runs the Semgrep registry rules, `Dependencies` checks that the proxy still has no
npm dependencies (nothing to audit). The same checks locally (gitleaks 8.30.1, semgrep 1.180.0):

```sh
gitleaks git --redact --log-opts="--full-history --diff-filter=tuxdb --diff-merges=first-parent HEAD" .
semgrep scan --metrics=off --error --severity WARNING --severity ERROR \
  --config p/python --config p/javascript --config p/security-audit \
  --config p/secrets --config p/github-actions --config r/bash
```

Mark a Semgrep false positive with `// nosemgrep: <rule-id>` (JavaScript) or `# nosemgrep: <rule-id>` (shell, YAML,
PowerShell) on the matched line or the line immediately before it, with a reason. Mark a gitleaks false positive with
a narrow, commented allowlist entry in `.gitleaks.toml`; the file must have `[extend]` with `useDefault = true` (the
workflow checks this), or it would replace the default rules. Before scanning, the workflow checks that the pinned
gitleaks, with that configuration, detects a token generated at run time; it scans only the checked-out commit's
history (`HEAD`, merge commits against their first parent), not every branch.

## Branch protection

`main` can only be changed through pull requests: squash merge only, one approval, and the tests, shellcheck,
PSScriptAnalyzer, the `install.sh` run, the Windows installer build and the three Security checks (gitleaks, Semgrep,
dependencies) must pass. Nobody can delete `main` or force-push it; the repository admin can bypass the rules only by
merging a pull request. Release tags `v*` cannot be moved or deleted (the admin can, to clean up a broken release). These
are the same rulesets as in the other FoundryVTT repositories, enforced by GitHub (GitHub Pro); the branch ruleset is also
kept in `.github/ruleset-protect-main.json` (*Settings → Rules → Rulesets → Import a ruleset* to re-create it). Pull
requests are squash merged, the branch is deleted afterwards, and Dependabot alerts, malware alerts and security updates
are on.
