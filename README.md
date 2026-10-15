# Foundry release proxy

A tiny HTTP proxy that lets a self-hosted **Foundry VTT** server install and update modules whose releases live in
**private GitHub repositories**. Foundry cannot authenticate to GitHub, so the proxy holds a read-only token, serves
the module manifest, and passes the zip through from a short-lived GitHub URL with the module's own `module.json`
pointed at the proxy, so that Foundry's update checks come back to it. Node.js only, no npm dependencies. Runs as a systemd service on Linux (e.g. a Raspberry Pi) or as a
scheduled task on Windows, and can optionally keep itself up to date from this repository's releases (and e-mail you
when it did). A password-protected **administration page** (`/_admin/`) lists the modules, adds, edits and deletes them,
copies a module's link for Foundry, and manages the notification e-mail addresses.

```
Foundry ──manifest URL──▶ proxy ──token──▶ GitHub API (latest release, manifest asset)
Foundry ◀── manifest with download/manifest rewritten to the proxy
Foundry ──download URL──▶ proxy ◀── pre-signed GitHub URL (no token): the zip streamed through, module.json patched
```

| Request | Result |
| --- | --- |
| `GET /<module-id>/module.json` | manifest of the **latest** release (`manifest` and `download` rewritten to the proxy) |
| `GET /<module-id>/<tag>/module.json` | manifest of that tag, rewritten the same way |
| `GET /<module-id>/<tag>/module.zip` | that tag's zip with its `module.json` pointing at the proxy ([why](#module-zips-and-updates)); `302` to the pre-signed GitHub download when it cannot be patched or `PATCH_ZIPS=off` |
| `/_admin/` and `/_admin/api/...` | the [administration page](#administration-page) (`404` while it has no password) |
| anything on `ADMIN_PORT` (if set) | the admin page only, over HTTPS: `/` → `302 /_admin/`, plain `http://` → `301 https://` |
| `POST`/`PUT`/`DELETE` outside `/_admin/` | `405` (the proxy routes are `GET`/`HEAD` only) |
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
The file is validated at startup; a malformed one makes the proxy refuse to start with a clear message. Changes made
on the administration page take effect at once (and are written back to the file); after editing the file by hand,
restart the service. An empty `{}` is only accepted while the administration page is on.

Environment variables (see `.env.example`): `GITHUB_TOKEN` (required), `PORT` (default `8787`), `HOST` (default
`127.0.0.1`), `PUBLIC_BASE_URL` (default `http://localhost:<PORT>`), `PATCH_ZIPS` (`off`: zips are plain redirects,
see [Module zips and updates](#module-zips-and-updates)), `CONFIG_FILE`, `ADMIN_FILE` (default `admin.json`
next to `CONFIG_FILE`), `ENV_FILE` (the file holding `GITHUB_TOKEN`, where a token changed on the admin page is saved;
default `env` next to `CONFIG_FILE`), `DAILY_CHECK` (`off` turns off the [daily check](#daily-check)), `ADMIN_HOSTS`
(extra host names the admin page answers to, comma separated) and the
[admin page in the browser](#the-admin-page-in-your-browser-like-webmin) settings (`ADMIN_PORT`, `ADMIN_HOST`,
`ADMIN_TLS`, `ADMIN_TLS_CERT`, `ADMIN_TLS_KEY`, `ADMIN_PUBLIC_URL`, `ADMIN_TRUST_PROXY`).

Run locally: `GITHUB_TOKEN=... CONFIG_FILE=config.example.json node src/server.js`. Tests: `npm test` (proxy, admin
page, mailer and updater; no network needed).

## 1. Create the GitHub token

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner**: the account/org that owns the module repos.
3. **Expiration**: set one (e.g. 90 days to 1 year) and put the date in your calendar.
4. **Repository access → Only select repositories**: pick **only** the module repos listed in `config.json`
   (e.g. `FoundryVTT-ghpg-Transformations`).
5. **Permissions → Repository permissions → Contents: Read-only**. This also covers releases and their assets. Leave
   everything else at "No access" (Metadata: read-only is added automatically).
6. Generate and copy the `github_pat_...` token (shown once).

**Rotating**: before the expiry, generate a new token the same way (or use *Regenerate token* on the existing one).
Then paste it on the [administration page](#administration-page) under **GitHub token** and press **Save token**: the
proxy checks it with GitHub, saves it to `env` and uses it at once (**Test setup** first shows what the new token can
read). Without the admin page: `sudo nano /etc/foundry-release-proxy/env`, replace `GITHUB_TOKEN`, and
`sudo systemctl restart foundry-release-proxy`. Delete the old token on GitHub afterwards. The
[daily check](#daily-check) e-mails you two weeks before the token expires and again if it lapses.

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
`--install-node` / `--no-install-node` (download Node.js without asking / never), `--set-admin-password` and
`--set-notify` (see [administration page](#administration-page)), and the older name `--check` (= `--check-update`).
A first install also asks for the admin page password and the notification e-mails (Enter skips both). Tokens are never taken as arguments: the proxy's token comes from a hidden prompt or
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
curl -sI http://localhost:8787/transformations/v1.2.0/module.zip   # HTTP 200 (zip with module.json patched), or 302 + Location: when it cannot be patched
```

Use the tag of a real release in the second command. Day to day: `sudo systemctl status|restart|stop foundry-release-proxy`.

## 2b. Install on Windows

**With the installer (recommended).** Download `foundry-release-proxy-<version>-setup.exe` (or
`foundry-release-proxy-setup.exe`) from the [releases](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/releases) page and run it (it asks for administrator
rights). Nothing else has to be installed: it brings its own Node.js. The wizard asks for

1. the GitHub token (hidden), the id of your first module (e.g. `transformations`) and its repository (`owner/name`),
2. whether to turn on [automatic updates](#automatic-updates),
3. optionally a password for the [administration page](#administration-page) and the e-mail addresses (plus mail
   server) for [update notifications](#update-notifications-by-e-mail),

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
from section 3 if it applies), then **Install**. Foundry fetches the manifest from the proxy and downloads the zip
through it. Updates then appear like any other module's, so publishing a new GitHub release is all that's needed.

### Module zips and updates

Foundry checks for updates with the `manifest` URL of the **installed** `module.json`, the one it unpacked from the zip,
not the URL you installed from. A module's own `module.json` usually points at its GitHub release
(`https://github.com/<owner>/<repo>/releases/latest/download/module.json`), which Foundry cannot read for a private
repository. So the proxy hands Foundry the zip with that file's `manifest` and `download` replaced by its own links:

- It reads the zip's size from the release, then fetches only the end of the zip (its table of contents) and the
  `module.json` from GitHub's pre-signed URL (partial downloads, never with the token).
- It streams the original bytes to Foundry unchanged and appends the patched `module.json` and a new table of contents
  that points at it. The old copy stays in the file unreferenced. The zip is never unpacked or held in memory, so this
  works on a Raspberry Pi for zips of hundreds of MB.
- The `module.json` Foundry reads is the one at the top of the zip, or else the only one inside a single top-level
  folder. Every other file is untouched.
- When anything is unexpected (no `module.json` there, not valid JSON, an encrypted or ZIP64 zip, GitHub refusing
  partial downloads), the proxy falls back to the plain `302` to GitHub and logs why (`zip vX redirected to GitHub (not
  patched: ...)`); the module still installs, only updates do not come back through the proxy. If the module's
  `module.json` already points at the proxy, nothing is patched either.
- `PATCH_ZIPS=off` in `env` turns this off: zips are plain redirects again.

Modules installed **before** this version still have the GitHub URL in their installed `module.json`, so Foundry cannot
see their next update. Fix each once: reinstall it from the proxy URL (Setup → Add-on Modules → Install Module), or
edit `manifest` in `Data/modules/<module-id>/module.json` on the Foundry server to
`http://localhost:8787/<module-id>/module.json` (your proxy address). From then on updates come through the proxy.

## Adding another private module

The easy way is the [administration page](#administration-page): **Add module**, enter the module id and `owner/name`,
then **Copy link** (in the module's **⋯** menu) and paste it into Foundry (steps 2 and 3 below still apply). By hand:

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

## Administration page

`http://localhost:8787/_admin/` (your `PUBLIC_BASE_URL` + `/_admin/`). It is **off until it has a password**; the
installers ask for one on a first install (Enter = keep it off). Set or change it later with
`sudo ./install.sh --set-admin-password` (Windows: `.\scripts\install-service.ps1 -SetAdminPassword`) or on the page
itself. Non-interactive installs take it from `FOUNDRY_PROXY_ADMIN_PASSWORD` (never from the command line).

Layout: the main page lists the modules. The **cogwheel** next to **Log out** opens a menu with **Modules** and the
settings pages (**GitHub token**, **Notifications**, **Admin password**), the current page highlighted; each has its own
address (`/_admin/#/`, `#/token`, `#/notifications`, `#/password`), so the browser's back button and bookmarks work. Once
logged in, the login page's picture sits as an icon in the top left corner (a link to the modules). The footer at the
bottom of every page, the login page included, says "Built by Dxcufgb 2026"; once logged in it also shows the installed
version, whether a newer release exists, and **Check for update**, which offers to update the proxy when there is a
newer release.

The login form works with password managers (Chrome's built-in one included): it saves the password under the user
name `admin` (the page has no user names; any would do) and offers it at the next login. Changing the password on the
**Admin password** page offers to update the saved one.

What it does:

- **Modules** (main page): lists every module with its repository, release asset names and the link for Foundry.
  **Add module** above the list; each module's **⋯** menu holds **Edit** (the id can be renamed: its link changes),
  **Delete**, **Check release** (shows the latest release tag, or
  why there is none: no release, or the token cannot see the repository) and **Copy link** (the manifest URL to paste
  into Foundry's *Install Module*). Changes are checked with the same rules as `config.json`, written to it and used
  at once, without a restart. Remember to add a new repository to the token's repository access as well.
- **GitHub token** (settings menu): a checkmark and the kind of token in use (never the token itself), **Add new token**
  (a dialog with the field, **Add** and **Cancel**) and **Test setup**; without any token, the field is on the page
  itself. Adding first asks GitHub whether it accepts the token (a mistyped or revoked one is refused and
  nothing changes), then rewrites the `GITHUB_TOKEN` line of `env` in place and switches the proxy over without a
  restart; automatic updates that use the proxy's token pick it up from there too. **Test setup** checks the token
  (whose it is, when it expires) and then every repository: this proxy's own repository (needed for automatic updates
  unless they have their own updater token) and each module's (can the token see it, is there a published release,
  does it have the manifest and zip assets). The line below shows the result of the last [daily check](#daily-check).
- **Version and update** (footer): the installed version and the latest release (when the proxy's token can see this
  repository) and **Check for update**. When a newer release exists, it asks whether to update the proxy now (**Update
  now** / **Not now**); **Update now** installs it right away instead of waiting for the daily
  [automatic update](#automatic-updates) or logging in to the machine. See [Update proxy now](#update-proxy-now).
- **Notifications** (settings menu): the e-mail addresses that hear about automatic updates and daily-check problems (see below), the
  SMTP server that sends them, and **Send test e-mail**. The SMTP password is never shown again; leave the field empty
  to keep it.
- **Admin password** (settings menu): change it (needs the current one; every other session is logged out).

**Access.** On the machine itself the page is at `http://localhost:8787/_admin/` (the proxy's own port, which listens
on `127.0.0.1` only). To use it from any browser on your network, turn on its own HTTPS port; see the next section.

**Security.** The password is stored as a salted scrypt hash. A login gives an `HttpOnly`, `SameSite=Strict` session
cookie (12 hours, in memory: restarting the proxy logs everybody out), marked `Secure` over HTTPS; every change also
needs a per-session CSRF token and a JSON body. Requests from other web sites (`Origin`) or for host names that are not
this machine's own names or addresses, `localhost`, `PUBLIC_BASE_URL`'s, `ADMIN_PUBLIC_URL`'s or `ADMIN_HOSTS` are
refused (a guard against DNS rebinding). Five wrong passwords lock that address out for five minutes, and more than 50
failed logins within 15 minutes from anywhere pause every login for a while. The page has a strict
Content-Security-Policy and is never cached. The GitHub token is never shown on it.

**Settings file.** `admin.json` next to `config.json` (`/etc/foundry-release-proxy/admin.json`,
`C:\ProgramData\FoundryReleaseProxy\admin.json`) holds the password hash and the notification settings, including the
SMTP password. Like `env` it is readable only by the proxy's account (Linux: owned by `foundry-proxy`, mode `600`;
Windows: Administrators, SYSTEM and LOCAL SERVICE). The proxy's account may rewrite `config.json`, `admin.json` and
`env` (only its `GITHUB_TOKEN` line, with a value of letters, digits and `_`) in place, and on Linux the empty
`update-request` file (see [Update proxy now](#update-proxy-now)), but cannot create or delete files in the settings
folder; on Linux the systemd unit allows writes to exactly these four files. Installs from
before this version get that permission for `env` when the installer runs again (an automatic update does it); until
then the page says the token cannot be changed there. Re-running the installer never overwrites `admin.json`; `--set-notify` (`-SetNotify`) re-enters the
e-mail settings from the command line.

### The admin page in your browser (like Webmin)

Like Webmin on its port 10000, the admin page can have **its own port**, served over **HTTPS** to every browser on
your network: `https://<this machine>:8788/`. That port serves only the admin page; the module proxy stays on
`127.0.0.1`, so nothing without a password is ever exposed.

| | Linux | Windows (elevated PowerShell) |
| --- | --- | --- |
| turn on | `sudo ./install.sh --admin-web` (a first install asks) | `.\scripts\install-service.ps1 -AdminWeb` (the setup wizard asks) |
| turn off | `sudo ./install.sh --no-admin-web` | `.\scripts\install-service.ps1 -NoAdminWeb` |
| new certificate | `sudo ./install.sh --renew-admin-cert` | `.\scripts\install-service.ps1 -RenewAdminCert` |

The installer prints the addresses (`https://raspberrypi:8788/`, `https://192.168.1.20:8788/`, ...). A different port:
`FOUNDRY_PROXY_ADMIN_PORT=10443` (Linux: `sudo --preserve-env=FOUNDRY_PROXY_ADMIN_PORT ./install.sh --admin-web`). A
port below 1024, such as 443, is fine as well: the service then gets the one capability needed to bind it.

- **Certificate.** The installer makes a self-signed certificate for the machine's names and addresses
  (`admin-tls.crt` / `admin-tls.key` next to `config.json`, readable by the proxy but owned by root / Administrators).
  Your browser warns about it once ("not private" / "potential security risk"): compare the SHA-256 fingerprint the
  installer printed with the one the browser shows, then accept it. A real certificate (your own CA, Let's Encrypt)
  goes in `ADMIN_TLS_CERT` and `ADMIN_TLS_KEY` (paths to PEM files the proxy's account can read) in `env`.
- **Firewall.** Windows: the installer allows the port on private and domain networks. Linux: if `ufw` is on, the
  installer prints the `sudo ufw allow 8788/tcp` you need.
- **`http://`** on the admin port is redirected to `https://`.
- Settings in `env` (restart the service after editing): `ADMIN_PORT` (port; unset = off), `ADMIN_HOST` (address,
  default `0.0.0.0` = all), `ADMIN_TLS` (`off` = plain HTTP, only behind a reverse proxy), `ADMIN_TLS_CERT` /
  `ADMIN_TLS_KEY`, `ADMIN_PUBLIC_URL` (the address used from outside, e.g. `https://proxy.example.com`),
  `ADMIN_TRUST_PROXY` (`1` = trust `X-Forwarded-For` / `X-Forwarded-Proto` from a reverse proxy on this machine;
  for a reverse proxy on another machine, its address instead, e.g. `192.168.1.5`, comma separated for several).
  Forwarded headers from any other address are ignored, so nobody can fake them to dodge the login lockout.

### On a public address

You can give the admin page a public name and reach it from the internet. Two ways:

**A. Behind a web server you already run (recommended; e.g. an nginx or Apache server block managed in Webmin).**
The web server does HTTPS with a real certificate (Let's Encrypt) and forwards to the admin port, which then listens on
`127.0.0.1` only. In the proxy's `env` (`/etc/foundry-release-proxy/env`):

```sh
ADMIN_PORT=8788
ADMIN_HOST=127.0.0.1
ADMIN_TLS=off
ADMIN_TRUST_PROXY=1
ADMIN_PUBLIC_URL=https://proxy.example.com
```

then `sudo systemctl restart foundry-release-proxy`. Webmin cannot host the page inside its own interface, but its
nginx or Apache module can create this server block / virtual host (or add it to the files by hand):

```nginx
server {
    listen 443 ssl;
    server_name proxy.example.com;
    ssl_certificate     /etc/letsencrypt/live/proxy.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/proxy.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

```apache
<VirtualHost *:443>
    ServerName proxy.example.com
    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/proxy.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/proxy.example.com/privkey.pem
    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:8788/
    ProxyPassReverse / http://127.0.0.1:8788/
    RequestHeader set X-Forwarded-Proto "https"
</VirtualHost>
```

(Apache: `a2enmod ssl proxy proxy_http headers`; it adds `X-Forwarded-For` itself.) Point only at the admin port, never
at the proxy's port 8787: the module routes have no password and must stay private.

If nginx or Apache runs on a different machine, bind the admin port to an address that machine can reach and set
`ADMIN_TRUST_PROXY` to that machine's IP address instead of `1`.

**B. Directly.** Keep `ADMIN_HOST=0.0.0.0`, forward the admin port on your router, set `ADMIN_PUBLIC_URL` and give it a
certificate browsers trust: `ADMIN_TLS_CERT` / `ADMIN_TLS_KEY`. Let's Encrypt's files are readable by root only, so copy
them for the proxy in a renewal hook, for example `/etc/letsencrypt/renewal-hooks/deploy/foundry-proxy.sh`:

```sh
#!/bin/sh
install -m 644 -o root -g foundry-proxy "$RENEWED_LINEAGE/fullchain.pem" /etc/foundry-release-proxy/admin-tls.crt
install -m 640 -o root -g foundry-proxy "$RENEWED_LINEAGE/privkey.pem" /etc/foundry-release-proxy/admin-tls.key
systemctl restart foundry-release-proxy
```

On the internet, use a long password (a passphrase of 16+ characters), keep automatic updates on, and if you can,
limit who may connect (e.g. `allow`/`deny` in the nginx server block, or your router).

## Daily check

Once a day (the first time an hour after the proxy starts) the proxy runs the same checks as **Test setup** on the
admin page with the token in use. When something is wrong it e-mails the [notification](#update-notifications-by-e-mail)
recipients in `admin.json`, every day until it is fixed, and once more when everything is fine again:

- GitHub no longer accepts the token (expired, revoked), or it expires within 14 days;
- the token can no longer see this proxy's own repository, which automatic updates read with it (only once it has been
  seen to read it since the proxy started: an install whose token was never given that repository, because automatic
  updates are off or have their own updater token, gets no e-mail about it; **Test setup** still shows it);
- the token cannot see a module repository, or its latest release is missing or lacks the manifest or zip asset.

Subject `Foundry release proxy (<host name>): setup problems` (or `...: setup OK again`), with the problems and the
link to the admin page (`ADMIN_PUBLIC_URL` when set, else `PUBLIC_BASE_URL`) in the body. When GitHub cannot be
reached at all, the proxy tries again an hour later and only e-mails if that fails too. Each run writes one line to the
proxy's log (`daily check: all OK` or `daily check: N problem(s)`). The check runs whether or not the admin page is on;
without recipients it only logs. `DAILY_CHECK=off` in `env` turns it off.

## Update notifications by e-mail

When automatic updates are on, every run that **installs a new version** or **fails** (check failed, bad download,
rolled back) sends an e-mail to each address in `admin.json`: subject `Foundry release proxy (<host name>): updated to
X.Y.Z` or `...: automatic update failed`, with the details in the body. No addresses = no e-mails. A failure to send is
only logged and never changes the outcome of the update. (A failing check e-mails you every day until it is fixed.)
The same addresses get the [daily check](#daily-check)'s e-mails.

Set the addresses and the mail server while installing (the installer asks after the admin password; the Windows
installer has a page for it), on the administration page, or with `--set-notify` / `-SetNotify`. Unattended installs
read `FOUNDRY_PROXY_NOTIFY_EMAILS` (comma separated), `FOUNDRY_PROXY_SMTP_HOST`, `FOUNDRY_PROXY_SMTP_PORT`,
`FOUNDRY_PROXY_SMTP_SECURITY` (`starttls`, `tls` or `none`), `FOUNDRY_PROXY_SMTP_USER`, `FOUNDRY_PROXY_SMTP_PASSWORD`
and `FOUNDRY_PROXY_SMTP_FROM` (the Windows setup also takes `/NOTIFYEMAILS=`, `/SMTPHOST=`, `/SMTPPORT=`,
`/SMTPSECURITY=`, `/SMTPUSER=` and `/SMTPFROM=`; the password only from the environment).

The mail is sent by `src/notify.js` with a small built-in SMTP client: `starttls` (port 587) or `tls` (port 465) with a
verified certificate; the password goes out only over TLS (`AUTH PLAIN`/`LOGIN`), so `none` is only for a local relay
without login. For Gmail use `smtp.gmail.com`, port 587, `starttls` and an *app password*. On Linux the root updater
runs `notify.js` as the proxy's own user (`setpriv`), so root never parses the file that user can write; on Windows the
SYSTEM updater runs it. The first update **to** this version is still done by the previous version's updater, so
e-mails start with the update after that.

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
| update now | `sudo ./install.sh --update-now`, or **Check for update** → **Update now** on the [admin page](#update-proxy-now) | `.\scripts\install-service.ps1 -UpdateNow`, or the admin page |
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

The token is only sent to `api.github.com` and is never logged. When it expires, save a new one on the admin page (it
goes into `env`), or update `updater-token` if the updater has its own; a failing check shows up in the update log as
`HTTP 401`/`HTTP 404`, and the [daily check](#daily-check) warns about the proxy's token before it lapses.

**Limits.** The checksum guards against corrupted or truncated downloads; it comes from the same release, so it does
not protect against someone who can publish releases in this repository. Updates restart the proxy (a few seconds of
downtime). The previous version stays in the `.prev` folder until the next update.

### Update proxy now

**Check for update** in the admin page's footer asks GitHub for the latest release; when it is newer, a dialog asks
whether to update the proxy now. **Update now** runs the same update as the daily automatic update, at once, whether or not
automatic updates are turned on: same token (`TOKEN_FILE` in `auto-update.conf`, else the proxy's `env`), same checks
(only a strictly newer, checksum-verified release; rollback on failure), same log and the same notification e-mail.
The proxy restarts when a newer version was installed, which ends every admin login; the page waits for that and
asks you to log in again. An update can be requested again after two minutes.

The proxy itself never runs the update (it has no rights to): it only asks the root (Linux) or SYSTEM (Windows)
updater the installer set up to run now, and nothing it sends can change what that updater does.

- **Linux**: the installer creates `/etc/foundry-release-proxy/update-request` (empty, owned by `foundry-proxy`, mode
  `600`) and the systemd units `foundry-release-proxy-update-now.path` and `-update-now.service`. The proxy writes the
  time into that file; the path unit sees the change and starts the update service as root. Root never reads the file.
  Log: `journalctl -u foundry-release-proxy-update-now`.
- **Windows**: the installer registers the task `FoundryReleaseProxy-UpdateNow` (SYSTEM, no schedule) and lets LOCAL
  SERVICE run it, but not change it; the proxy starts it with `schtasks /Run`. Log: `auto-update.log`, as above.

Installs from before this version get the button when the installer runs again (an automatic update does it); until
then the page says it is not set up. `UPDATE_REQUEST_FILE` (Linux) and `UPDATE_TASK` (Windows) in `env` override the
file and task names for a hand-made setup.

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
- Service won't start with `Changing to the requested working directory failed: Permission denied` (`status=200/CHDIR`)
  or the updater says `Cannot find module '/opt/foundry-release-proxy/src/notify.js'`: an install from a version before
  1.4.1 ran with a strict root umask (e.g. `077`) and left the code folder unreadable for the service user. Installing
  1.4.1 or newer fixes the modes; until then: `sudo chmod -R u=rwX,go=rX /opt/foundry-release-proxy` and
  `sudo systemctl restart foundry-release-proxy`.
- Foundry's update check for a private module fails or contacts `github.com`: the installed `module.json` still points
  at GitHub (installed before this version, or the zip could not be patched; the log says why). See
  [Module zips and updates](#module-zips-and-updates).
- `404` for a module that exists: the repo has no published (non-draft, non-prerelease) release, the release lacks the
  assets, or the token has no access to that repo.
- `502`: GitHub rejected the request; the log line shows the module id and status (`401` expired/invalid token).
  **Test setup** on the admin page shows which part fails; replace an expired token there with **Save token**.
- `/_admin/` answers `404`: the page has no password yet (`--set-admin-password`). `403 unknown host name`: the name
  in the address bar is not one of this machine's names or addresses; set it as `ADMIN_PUBLIC_URL` or add it to
  `ADMIN_HOSTS` in `env`.
- The admin port does not answer from another computer: check `ADMIN_PORT`/`ADMIN_HOST` in `env`, the firewall
  (`sudo ufw allow 8788/tcp`; Windows allows private and domain networks only) and the log line `admin page for the
  browser: ...` at startup. Behind a reverse proxy: logins that always fail with `Secure` cookies over plain http mean
  `X-Forwarded-Proto` is missing or `ADMIN_TRUST_PROXY=1` is not set.
- No notification e-mails: use **Send test e-mail** on the admin page; its error names the SMTP step that failed.
  The update log (`journalctl -u foundry-release-proxy-update`, `auto-update.log`) shows `notify: ...` lines.
- Automatic update fails with `HTTP 404`: the updater's token cannot see this repository (add it to the token's
  repository access) or no release has been published yet.
