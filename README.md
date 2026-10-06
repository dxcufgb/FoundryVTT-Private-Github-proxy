# Foundry release proxy

A tiny HTTP proxy that lets a self-hosted **Foundry VTT** server install and update modules whose releases live in
**private GitHub repositories**. Foundry cannot authenticate to GitHub, so the proxy holds a read-only token, serves
the module manifest, and redirects the zip download to a short-lived GitHub URL (the zip never passes through the
proxy). Node.js only, no npm dependencies.

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

Run locally: `GITHUB_TOKEN=... CONFIG_FILE=config.example.json node src/server.js`. Tests: `npm test`.

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

## 2. Install on the Pi

Needs Node.js 18+ installed system-wide (`node -v`; not via nvm in a home directory, as the service runs as its own user).

```bash
git clone https://github.com/dxcufgb/foundryvtt-realese-proxy.git
cd foundryvtt-realese-proxy
sudo ./scripts/install-service.sh
```

The script creates a `foundry-proxy` system user and installs:

- `/opt/foundry-release-proxy/`: the code (replaced each run)
- `/etc/foundry-release-proxy/config.json`: your module mapping (never overwritten; survives code updates)
- `/etc/foundry-release-proxy/env`: token and settings (`chmod 600`, owned by the service user)
- a systemd unit `foundry-release-proxy` with `Restart=always`, enabled on boot

It asks for the token (input hidden); press Enter to skip and paste it into the `env` file later. The service is only
started once a token is present. Then edit `/etc/foundry-release-proxy/config.json` if needed and restart.

**Updating the proxy**: `git pull && sudo ./scripts/install-service.sh` (config and env are kept).
**Removing**: `sudo ./scripts/install-service.sh --uninstall`.

### Check that it runs

```bash
systemctl status foundry-release-proxy
journalctl -u foundry-release-proxy -f
curl -s  http://localhost:8787/transformations/module.json   # manifest; "download" points at the proxy
curl -sI http://localhost:8787/transformations/v1.2.0/module.zip   # expect HTTP 302 and a Location: header
```

Use the tag of a real release in the second command. Day to day: `sudo systemctl status|restart|stop foundry-release-proxy`.

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

## Troubleshooting

- Service won't start: `journalctl -u foundry-release-proxy -n 50`; it prints `refusing to start: ...` for a missing
  token or malformed config.
- `404` for a module that exists: the repo has no published (non-draft, non-prerelease) release, the release lacks the
  assets, or the token has no access to that repo.
- `502`: GitHub rejected the request; the log line shows the module id and status (`401` expired/invalid token).
