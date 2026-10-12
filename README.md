# Foundry release proxy

A tiny HTTP proxy that lets a self-hosted **Foundry VTT** server install and update modules whose releases live in
**private GitHub repositories**. Foundry cannot authenticate to GitHub, so the proxy holds a read-only token, serves
the module manifest, and redirects the zip download to a short-lived GitHub URL (the zip never passes through the
proxy). Node.js only, no npm dependencies. Runs as a systemd service on Linux (e.g. a Raspberry Pi) or as a
scheduled task on Windows, and can optionally keep itself up to date from this repository's releases.

```
Foundry ──manifest URL──▶ proxy ──token──▶ GitHub API (latest release, manifest asset)
Foundry ◀── manifest with download/manifest rewritten to the proxy
Foundry ──download URL──▶ proxy ──302──▶ pre-signed GitHub URL ──▶ Foundry (zip straight from GitHub)
```

| Request | Result |
| --- | --- |
| `GET /<module-id>/module.json` | manifest of the **latest** release (`manifest` and `download` rewritten to the proxy) |
| `GET /<module-id>/<tag>/module.json` | manifest of that tag, rewritten the same way |
| `GET /<module-id>/<tag>/module.zip` | `302` to the pre-signed GitHub download of that tag's zip |
| anything else / unknown module / missing asset or release | `404` |
| GitHub error | `502` (log shows module id and GitHub status, never the token) |

Rewritten links always use `PUBLIC_BASE_URL`, never the request's `Host` header. A `404` for a release can also mean
the token cannot see that repo (GitHub hides private repos with 404), so check the token's repository access first.

## Configuration

`config.json` (path from `CONFIG_FILE`, default `./config.json`; see `config.example.json`):

```json
{
  "transformations": { "repo": "dxcufgb/FoundryVTT-ghpg-Transformations" }
}
```

Optional per-module overrides: `"manifestAsset"` (default `module.json`) and `"zipAsset"` (default `module.zip`).
The file is validated at startup; a malformed one makes the proxy refuse to start with a clear message. It is read
once at startup: add a module, restart the service.

Environment variables (see `.env.example`): `GITHUB_TOKEN` (required), `PORT` (default `8787`), `HOST` (default
`127.0.0.1`), `PUBLIC_BASE_URL` (default `http://localhost:<PORT>`), `CONFIG_FILE`.

Run locally: `GITHUB_TOKEN=... CONFIG_FILE=config.example.json node src/server.js`. Tests: `npm test` (proxy and
updater; no network needed).

## 1. Create the GitHub token

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner**: the account/org that owns the module repos.
3. **Expiration**: set one (e.g. 90 days to 1 year) and put the date in your calendar.
4. **Repository access → Only select repositories**: pick **only** the module repos listed in `config.json`
   (e.g. `FoundryVTT-ghpg-Transformations`).
5. **Permissions → Repository permissions → Contents: Read-only**. This also covers releases and their assets. Leave
   everything else at "No access" (Metadata: read-only is added automatically).
6. Generate and copy the `github_pat_...` token (shown once).

**Rotating**: before the expiry, generate a new token the same way (or use *Regenerate token* on the existing one),
then on the Pi `sudo nano /etc/foundry-release-proxy/env`, replace `GITHUB_TOKEN`, and
`sudo systemctl restart foundry-release-proxy`. Delete the old token on GitHub afterwards.

## 2. Install on Linux (Raspberry Pi)

```bash
curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundry-release-proxy
```

This repository is private, so the one-liner asks for a fine-grained GitHub token with read-only *Contents* access to
this repository (it only uses it to download the release). Or download `foundry-release-proxy-linux.tar.gz` from the
[latest release](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/releases/latest) and run:

```bash
tar xzf foundry-release-proxy-linux.tar.gz
cd foundry-release-proxy-X.Y.Z
sudo ./install.sh
```

| Option | Meaning |
| --- | --- |
| (none) | install or upgrade in place, interactive (asks for what it needs) |
| `--yes`, `-y` | non-interactive: no questions; missing required settings → clear error |
| `--auto-update` / `--no-auto-update` | turn automatic updates on / off as part of this install |
| `--enable-auto-update` / `--disable-auto-update` | turn them on / off on an existing install, nothing else |
| `--check-update` | only check: exit 0 = up to date, 10 = newer release available, other = error |
| `--update-now` | install the latest release now (same path as the daily updater) |
| `--uninstall` [`--purge`] | remove (keep / also delete settings and data) |
| `--help` | usage listing exactly these first, then the repo-specific options |

Options of this installer: `--module ID=OWNER/REPO` (first install: put this module in `config.json`; repeatable),
`--install-node` / `--no-install-node` (download Node.js without asking / never), and the older name `--check` (=
`--check-update`). Tokens are never taken as arguments: the proxy's token comes from a hidden prompt or
`FOUNDRY_PROXY_GITHUB_TOKEN`, the updater's from `UPDATER_GITHUB_TOKEN` or `INSTALL_GITHUB_TOKEN` (see
[automatic updates](#automatic-updates)). With `--yes`, a first install needs `FOUNDRY_PROXY_GITHUB_TOKEN`, and Node.js is
downloaded if none is usable.

`install.sh` is the single entry point: it looks for a usable Node.js (18 or newer, system-wide, not nvm in a home
directory, because the service runs as its own user). If there is none it offers to download the official Node.js 22
for your CPU from nodejs.org (checked against nodejs.org's SHA-256, unpacked to `/opt/foundry-release-proxy-node`).
Then it runs `scripts/install-service.sh` with the other options (that script still works on its own with the same
options). Unattended, with everything on the command line:

```bash
sudo --preserve-env=FOUNDRY_PROXY_GITHUB_TOKEN env FOUNDRY_PROXY_GITHUB_TOKEN=github_pat_... \
  ./install.sh --yes --auto-update --module transformations=dxcufgb/FoundryVTT-ghpg-Transformations
```

(`--module` only applies to a first install. Without it the example config is installed and you edit it afterwards.)
A clone of this repository works the same way (`git clone ...`, `cd`, `sudo ./install.sh`).

The script creates a `foundry-proxy` system user and installs:

- `/opt/foundry-release-proxy/`: the code (replaced each run)
- `/etc/foundry-release-proxy/config.json`: your module mapping (never overwritten; survives code updates)
- `/etc/foundry-release-proxy/env`: token and settings (`chmod 600`, owned by the service user)
- a systemd unit `foundry-release-proxy` with `Restart=always`, enabled on boot

It asks for the token (input hidden); press Enter to skip and paste it into the `env` file later. The service is only
started once a token is present. Then edit `/etc/foundry-release-proxy/config.json` if needed and restart.
At the end it asks whether to turn on [automatic updates](#automatic-updates) (default: no).

**Updating the proxy**: run the one-liner or `sudo ./install.sh` from a newer release again (config, env and the
auto-update choice are kept), or `sudo ./install.sh --update-now` to install the latest release.
**Removing**: `sudo ./install.sh --uninstall` (removes the service, the updater timer, the updater token, the code and a
Node.js that `install.sh` downloaded; keeps `/etc/foundry-release-proxy/config.json` and `env`); add `--purge` to delete
`/etc/foundry-release-proxy` and the `foundry-proxy` user as well.

### Check that it runs

```bash
systemctl status foundry-release-proxy
journalctl -u foundry-release-proxy -f
curl -s  http://localhost:8787/transformations/module.json   # manifest; "download" points at the proxy
curl -sI http://localhost:8787/transformations/v1.2.0/module.zip   # expect HTTP 302 and a Location: header
```

Use the tag of a real release in the second command. Day to day: `sudo systemctl status|restart|stop foundry-release-proxy`.

## 2b. Install on Windows

**With the installer (recommended).** Download `foundry-release-proxy-<version>-setup.exe` (or
`foundry-release-proxy-setup.exe`) from the [releases](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/releases) page and run it (it asks for administrator
rights). Nothing else has to be installed: it brings its own Node.js. The wizard asks for

1. the GitHub token (hidden), the id of your first module (e.g. `transformations`) and its repository (`owner/name`),
2. whether to turn on [automatic updates](#automatic-updates),

and then installs the code, writes `config.json`, creates the data folder with locked-down permissions and registers
the scheduled task that runs the proxy at boot, as described below. If a token and config already exist (installing a
newer version over an old one) it does not ask again and keeps them. The installer is not code-signed, so Windows
SmartScreen may say "Windows protected your PC": choose *More info → Run anyway*. Check the download against
`SHA256SUMS.txt` on the release page if you like (`Get-FileHash`).

Unattended install (PowerShell, as administrator; the token goes through the environment, not the command line):

```powershell
$env:FOUNDRY_PROXY_GITHUB_TOKEN = 'github_pat_...'
.\foundry-release-proxy-1.2.0-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /MODULEID=transformations /REPO=dxcufgb/FoundryVTT-ghpg-Transformations /AUTOUPDATE=1
```

Uninstall from *Settings → Apps*, or `unins000.exe /VERYSILENT` in `C:\Program Files\FoundryReleaseProxy`. It removes
the tasks, the code and the bundled Node.js and asks whether to delete `C:\ProgramData\FoundryReleaseProxy` (config,
token, logs; a silent uninstall keeps it unless you add `/DELETEDATA=1`). If the install fails, the reason is in
`C:\Program Files\FoundryReleaseProxy\install.log`. The bundled Node.js is not updated by the automatic updates; install
a newer installer to get a newer Node.js.

**Without the installer (PowerShell).** Needs Node.js **20.6 or newer** installed for all users (the normal installer
puts it in `C:\Program Files\nodejs`; not nvm in a user profile, because the proxy runs as `LOCAL SERVICE`). Download
`foundry-release-proxy-<version>-windows.zip` from the releases page, unpack it, and in an **elevated** Windows PowerShell
(Run as administrator) in the unpacked folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-service.ps1
```

Either way this is what ends up on the machine:

- `C:\Program Files\FoundryReleaseProxy\`: the code (replaced each run)
- `C:\ProgramData\FoundryReleaseProxy\config.json`: your module mapping (never overwritten)
- `C:\ProgramData\FoundryReleaseProxy\env`: token and settings (never overwritten; only Administrators and SYSTEM have
  access, plus read access for `LOCAL SERVICE`; `Users`/`Everyone` get nothing)
- `C:\ProgramData\FoundryReleaseProxy\logs\proxy.log`: the proxy's log (rotated at 5 MB)
- a scheduled task `FoundryReleaseProxy` that runs `node --env-file=...\env src\server.js` as `LOCAL SERVICE` at boot
  (and re-checks every 5 minutes, so a crashed proxy comes back)

It asks for the token (input hidden; or set `FOUNDRY_PROXY_GITHUB_TOKEN` in the environment first); press Enter to
skip, then put it into the `env` file and run `Enable-ScheduledTask FoundryReleaseProxy; Start-ScheduledTask FoundryReleaseProxy`.
The defaults are the same as on Linux: `HOST=127.0.0.1`, `PORT=8787`. Use `-NodePath C:\path\to\node.exe` if `node`
is not on the PATH.

Other switches: `-AutoUpdate` (turn on [automatic updates](#automatic-updates) without asking),
`-EnableAutoUpdate` / `-DisableAutoUpdate`, `-Check`, `-UpdateNow`, and `-Uninstall` (removes both tasks, the updater
token and the code; keeps `C:\ProgramData\FoundryReleaseProxy` with config, env and logs).
Day to day: `Get-ScheduledTask FoundryReleaseProxy`, `Stop-ScheduledTask` / `Start-ScheduledTask FoundryReleaseProxy`,
`Get-Content -Wait C:\ProgramData\FoundryReleaseProxy\logs\proxy.log`.

## 3. Is Foundry running in Docker?

Check on the Pi: `docker ps`. If you see a Foundry container, `localhost` **inside the container is the container, not
the Pi**, so `http://localhost:8787` would not reach the proxy. If Foundry runs directly on the Pi (no container,
e.g. under systemd/pm2), skip this section.

Pick one option:

**A. Host networking** (simplest): run the container with `network_mode: host` (compose) or `--network host`
(`docker run`). Then `localhost` is the Pi, the proxy can stay on `127.0.0.1`, and the manifest URL is
`http://localhost:8787/<module-id>/module.json`. Note that with host networking Docker's port mappings are
ignored, so Foundry is simply reachable on its own port on the Pi.

**B. Docker bridge address**: keep Foundry's normal networking and make the proxy listen on the bridge address,
usually `172.17.0.1` (find it with `ip -4 addr show docker0`; compose projects use their own bridge, see
`docker network inspect <network>` → Gateway). Edit `/etc/foundry-release-proxy/env`:

```
HOST=172.17.0.1
PUBLIC_BASE_URL=http://172.17.0.1:8787
```

Restart the service and use `http://172.17.0.1:8787/<module-id>/module.json` in Foundry. `PUBLIC_BASE_URL` must be set to
this address, because it is what gets written into the manifest's `download` link, and that link is fetched from
inside the container. The bridge address is not reachable from your LAN, so only containers on this Pi can use the
proxy. If the Pi runs a firewall (ufw), allow port 8787 from the Docker subnet (`sudo ufw allow from 172.17.0.0/16 to any port 8787`).
Do **not** bind to `0.0.0.0` unless you understand the consequence: anyone on your network could then download your private modules.

Test from inside the container: `docker exec <foundry-container> curl -sI http://172.17.0.1:8787/transformations/module.json`
(or `wget -qSO- ...` if the image has no curl).

## 4. Install a module in Foundry

**Setup → Add-on Modules → Install Module**, paste the **Manifest URL**
`http://localhost:8787/<module-id>/module.json` (e.g. `.../transformations/module.json`; use the Docker-specific URL
from section 3 if it applies), then **Install**. Foundry fetches the manifest from the proxy and downloads the zip via
the proxy's redirect. Updates then appear like any other module's: Foundry re-fetches the same manifest URL and compares
`version`, so publishing a new GitHub release is all that's needed.

## Adding another private module

1. Add an entry to `/etc/foundry-release-proxy/config.json`:
   ```json
   {
     "transformations": { "repo": "dxcufgb/FoundryVTT-ghpg-Transformations" },
     "other-module": { "repo": "dxcufgb/Some-Other-Private-Module" }
   }
   ```
   The key is the Foundry module id and is used in the URL.
2. Add the repo to the token's repository access (GitHub → Settings → Developer settings → your token → Repository
   access), keeping **Contents: Read-only**.
3. Make sure the repo has a release workflow that attaches `module.zip` and `module.json` to each published release, like
   `.github/workflows/release.yml` in `dxcufgb/FoundryVTT-ghpg-Transformations`. Tags look like `v1.2.0`. (If your
   assets are named differently, set `manifestAsset` / `zipAsset` in the config entry.)
4. `sudo systemctl restart foundry-release-proxy` (check `journalctl -u foundry-release-proxy` for config errors).
5. In Foundry install it with its own manifest URL: `http://localhost:8787/other-module/module.json`.

## Automatic updates

Off by default. When turned on, the machine checks once a day whether this repository has a newer release and, if so,
installs it. Linux: a systemd timer (`foundry-release-proxy-update.timer`, daily with up to 6 hours of random delay)
runs `foundry-release-proxy-update.service` as root. Windows: the scheduled task `FoundryReleaseProxy-Update` runs as
SYSTEM daily at 03:00 plus up to 6 hours of random delay.

| | Linux | Windows (elevated PowerShell) |
| --- | --- | --- |
| turn on while installing | `sudo ./install.sh --auto-update` (or answer `y` to the prompt) | `.\scripts\install-service.ps1 -AutoUpdate` |
| turn on later | `sudo ./install.sh --enable-auto-update` | `.\scripts\install-service.ps1 -EnableAutoUpdate` |
| turn off | `sudo ./install.sh --disable-auto-update` | `.\scripts\install-service.ps1 -DisableAutoUpdate` |
| check only (exit 0 = current, 10 = update available) | `sudo ./install.sh --check-update` | `.\scripts\install-service.ps1 -Check` |
| update now | `sudo ./install.sh --update-now` | `.\scripts\install-service.ps1 -UpdateNow` |
| log | `journalctl -u foundry-release-proxy-update` | `C:\ProgramData\FoundryReleaseProxy\auto-update.log` |

On Linux `sudo ./scripts/install-service.sh` takes the same options (`--check` is the older name of `--check-update`).
The commands also work from the installed copy (`/opt/foundry-release-proxy/scripts/install-service.sh`,
`C:\Program Files\FoundryReleaseProxy\scripts\install-service.ps1`). Re-running the installer keeps the choice
(`auto-update.conf` next to `env`; `--no-auto-update` / `-NoAutoUpdate` turn it off while re-installing).
`--check-update` and `--update-now` work whether or not the daily updates are on. While another update run holds the lock,
`--check-update` (`-Check`) exits 75 ("could not check") instead of 0 or 10.

**What an update does**: `src/updater.js` asks `https://api.github.com/repos/dxcufgb/FoundryVTT-Private-Github-proxy/releases/latest`
(drafts and pre-releases never count) and compares the tag with the installed `package.json` version by semantic
versioning; only a strictly newer release is installed (the version of an installed copy is the one stamped into its
`package.json` when the release was built). It downloads `SHA256SUMS.txt` and the archive
(`foundry-release-proxy-<version>-linux.tar.gz` on Linux, `-windows.zip` on Windows) through the API asset URL, follows GitHub's redirect to the pre-signed
download **without** the token, refuses anything that is not HTTPS or larger than 20 MB, and checks the archive's
SHA-256. The script then unpacks it into a fresh temporary folder (refusing paths outside the archive's top folder),
copies the current code to `/opt/foundry-release-proxy.prev` (`C:\Program Files\FoundryReleaseProxy.prev`), runs the
new release's installer in upgrade mode (non-interactive) and checks that the proxy is running again. If anything
fails, the previous version is reinstalled from that copy and checked to be running again; if that also fails, the
log says `ROLLBACK FAILED` with the command to reinstall it by hand from the `.prev` folder. A lock (`flock` / a named mutex) stops two runs at once.
`config.json`, `env` and their owners, modes and ACLs are never changed by an update.

**Token for the updater.** This repository is private, so the updater needs a GitHub token that can read its releases.
When you turn updates on you can:

- reuse the proxy's own `GITHUB_TOKEN` from `env` (the default): add `dxcufgb/FoundryVTT-Private-Github-proxy` to that
  token's **Repository access**, keeping **Contents: Read-only**. The proxy itself then can also see this repository,
  which is harmless (it only serves the repos listed in `config.json`); or
- give the updater its own fine-grained token (only this repository, **Contents: Read-only**): answer `n` to the
  question, or set `UPDATER_GITHUB_TOKEN` in the environment before running the installer (on Linux pass it through
  sudo with `sudo --preserve-env=UPDATER_GITHUB_TOKEN ...`; never put it on the command line). It is stored in
  `/etc/foundry-release-proxy/updater-token` (root, `600`) or `C:\ProgramData\FoundryReleaseProxy\updater-token`
  (Administrators and SYSTEM only). Turning updates off or uninstalling deletes it.

The one-line Linux installer exports the token it downloaded the release with as `INSTALL_GITHUB_TOKEN`; that token
can read this repository, so when you turn automatic updates on, `install.sh` stores it as the updater token (asking
first when interactive; with `--yes` it does so without asking). An updater token that is already configured is kept.

The token is only sent to `api.github.com` and is never logged. When it expires, update `env` (or `updater-token`); a
failing check shows up in the update log as `HTTP 401`/`HTTP 404`.

**Limits.** The checksum guards against corrupted or truncated downloads; it comes from the same release, so it does
not protect against someone who can publish releases in this repository. Updates restart the proxy (a few seconds of
downtime). The previous version stays in the `.prev` folder until the next update.

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

**Stable per-OS links** (you have to be signed in to GitHub with access to this private repository):

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

The **Security** workflow (`.github/workflows/security.yml`; GitHub's secret scanning and CodeQL are not available for
this private repository) runs on every pull request, on pushes to `main` and weekly: `Secrets (gitleaks)` scans the
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

## Troubleshooting

- Windows installer says the setup failed: read `C:\Program Files\FoundryReleaseProxy\install.log`; the proxy's own log is
  `C:\ProgramData\FoundryReleaseProxy\logs\proxy.log`.
- Service won't start: `journalctl -u foundry-release-proxy -n 50`; it prints `refusing to start: ...` for a missing
  token or malformed config.
- `404` for a module that exists: the repo has no published (non-draft, non-prerelease) release, the release lacks the
  assets, or the token has no access to that repo.
- `502`: GitHub rejected the request; the log line shows the module id and status (`401` expired/invalid token).
- Automatic update fails with `HTTP 404`: the updater's token cannot see this repository (add it to the token's
  repository access) or no release has been published yet.
