# Foundry release proxy

<a href="https://dxcufgb.github.io/FVTT-dev-showcase/"><img src="https://dxcufgb.github.io/FVTT-dev-showcase/assets/img/workshop-badge.png" alt="Dxcufgb's Workshop: every Foundry VTT project, video and changelog in one place" width="650"></a>

A tiny HTTP proxy that lets a self-hosted **Foundry VTT** server install and update modules whose releases live in
**private GitHub repositories**. Foundry cannot authenticate to GitHub, so the proxy holds a read-only token, serves
the module manifest, and passes the zip through from a short-lived GitHub URL with the module's own `module.json`
pointed at the proxy, so that Foundry's update checks come back to it. Node.js only, no npm dependencies. Runs as a systemd service on Linux (e.g. a Raspberry Pi) or as a
scheduled task on Windows, and can optionally keep itself up to date from this repository's releases (and e-mail you
when it did). A password-protected **administration page** (`/_admin/`) lists the modules, adds, edits and deletes them,
copies a module's link for Foundry, and manages the notification e-mail addresses.

## Installation

Linux (including a Raspberry Pi):

```bash
curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundry-release-proxy
```

Windows: download and run `foundry-release-proxy-setup.exe` from the
[latest release](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/releases/latest).

Create the GitHub token first, and see the wiki for everything else: [Create the GitHub Token](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Create-the-GitHub-Token),
[Install on Linux](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Install-on-Linux), [Install on Windows](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Install-on-Windows),
[Foundry in Docker](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Foundry-in-Docker).

## Documentation

The full guide is in the [wiki](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki):

- [Create the GitHub Token](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Create-the-GitHub-Token): a fine-grained, read-only token, and rotating it
- [Install on Linux](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Install-on-Linux): installer options, unattended install, updating and removing
- [Install on Windows](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Install-on-Windows): setup wizard, silent install, PowerShell install
- [Foundry in Docker](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Foundry-in-Docker): host networking or the Docker bridge address
- [Install a Module in Foundry](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Install-a-Module-in-Foundry): the manifest URL, and how zips are patched for updates
- [Adding Another Private Module](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Adding-Another-Private-Module): on the admin page or by hand
- [Admin Page](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Admin-Page): modules, GitHub token, notifications, password, security
- [Admin Page in Your Browser](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Admin-Page-in-Your-Browser), [Trusting the Certificate](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Trusting-the-Certificate)
  and [Admin Page on a Public Address](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Admin-Page-on-a-Public-Address): the admin page from other computers
- [Notifications and Daily Check](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Notifications-and-Daily-Check): e-mails about setup problems and updates
- [Automatic Updates](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Automatic-Updates): opt-in daily updates, the updater's token, **Update now**
- [How the Proxy Works](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/How-the-Proxy-Works): every request and its result
- [Configuration Reference](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Configuration-Reference): `config.json`, `env` and the environment variables
- [Troubleshooting](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Troubleshooting)

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
foundry-release-proxy-linux.tar.gz`, or the one-liner above.

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

## License

[MIT](LICENSE), Copyright (c) 2026 Dxcufgb.
