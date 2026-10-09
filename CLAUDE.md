# Foundry release proxy

A dependency-free Node HTTP proxy (`src/server.js`) that lets Foundry VTT install and update modules
released from **private** GitHub repositories. It holds a GitHub token, serves a module's
`module.json` from the latest (or a tagged) release with `manifest`/`download` rewritten to point
at the proxy, and answers zip requests with a `302` to GitHub's pre-signed asset URL. It runs as a
systemd service on a Raspberry Pi next to Foundry, or as a Windows scheduled task. An opt-in auto-updater
installs new releases of the proxy itself.

## Layout
- `src/server.js` – the HTTP proxy (everything except self-update). Exports `createApp`, `loadConfig`, `parseConfig`, `ConfigError`;
  `main()` only runs when executed directly.
- `src/updater.js` – self-update helper for the proxy itself (not for Foundry modules): `--check` /
  `--download` the latest release of this repo, verify it against `SHA256SUMS`. Exit 0 = up to date,
  10 = update available/downloaded, 1 = error. Installing is left to the scripts.
- `test/server.test.js`, `test/updater.test.js` – `node:test` suites with an injected `fetchImpl` mock
  (no network).
- `scripts/install-service.sh` – systemd installer (`sudo`; `--auto-update`, `--enable-auto-update`,
  `--disable-auto-update`, `--check`, `--update-now`, `--uninstall`). Code in `/opt/foundry-release-proxy`
  (root-owned), settings in `/etc/foundry-release-proxy/`.
- `scripts/auto-update.sh` – run as root by the `foundry-release-proxy-update` timer: locks, extracts,
  backs up to `/opt/foundry-release-proxy.prev`, runs `install-service.sh --upgrade`, rolls back on failure.
- `scripts/install-service.ps1`, `scripts/auto-update.ps1` – the same for Windows: code in
  `C:\Program Files\FoundryReleaseProxy`, settings and logs in `C:\ProgramData\FoundryReleaseProxy`; the proxy
  runs as LOCAL SERVICE, the daily update task as SYSTEM.
- `scripts/build-release.sh` – builds the `.tar.gz` (Linux), `.zip` (Windows) and `SHA256SUMS`;
  `.github/workflows/release.yml` runs it on a `v*` tag and publishes the release.
- `config.example.json`, `.env.example` – templates. Real `config.json`/`.env` are gitignored.

## Commands
- `npm test` – the unit tests. `npm start` – run the server.
- Local run: `GITHUB_TOKEN=... CONFIG_FILE=config.example.json node src/server.js`
- CI (`.github/workflows/ci.yml`): `node --check` on `src/server.js` and `src/updater.js` + `npm test` on
  Node 20/22/24, `shellcheck scripts/*.sh`, and PSScriptAnalyzer on `scripts/*.ps1`. Workflow changes are
  linted by actionlint and zizmor.

## Conventions
- CommonJS, `'use strict'`, **no npm dependencies** – Node built-ins and global `fetch` only.
  Adding a dependency needs a very good reason.
- 2-space indent, single quotes, semicolons. Small closures inside `createApp`; dependencies
  (`fetchImpl`, `log`) are injected so tests can replace them.
- Errors: `ConfigError` → exit 1 ("refusing to start"), `NotFound` → 404,
  `GithubError` → 502 with a generic body, anything else → 500 "internal error".
- Logging is one plain line through the injected `log`, prefixed with the module id.
- Behaviour changes need a test in `test/server.test.js` (or `test/updater.test.js`) and matching
  README edits (the README documents routes, status codes and error messages).

## Review focus
- **The token** may only go to `api.github.com` and to asset URLs taken from GitHub's JSON. The
  pre-signed redirect `location` must be fetched **without** auth, and the token must never
  appear in a response body or a log line (both are tested).
- **Zips stay redirects**: the proxy must never download or stream a module zip.
- **Path handling**: requests are 2–3 path segments, each `decodeURIComponent`'d (bad escapes →
  404); module ids are looked up with `Object.hasOwn` on a null-prototype map. Any tag from a
  request is `encodeURIComponent`'d before it reaches a GitHub URL.
- **Validation regexes** (`MODULE_ID_RE`, `REPO_RE`, `ASSET_RE`): flag any loosening. `REPO_RE`
  already allows `.`/`..` in a repo name, so do not rely on it for path safety.
- Rewritten links always use `PUBLIC_BASE_URL`, never the request's `Host` header.
- Every response is `Cache-Control: no-store`; any caching added must not outlive pre-signed URLs.
- Only GET and HEAD are allowed. There is no inbound auth – access control is binding to
  127.0.0.1 (or the Docker bridge); never default to `0.0.0.0`.
- GitHub's 404 for a repo the token cannot see must stay a 404, not a 502.
- Installer: re-running it must never overwrite `/etc/foundry-release-proxy/config.json` or
  `env`; `env` stays mode 600 owned by the service user; keep the systemd hardening and keep the
  script clean under shellcheck.
- **Auto-update** stays opt-in and runs as root (Linux) / SYSTEM (Windows). Its token is the proxy's
  `GITHUB_TOKEN` from `env` or a separate `updater-token` (root 600 / Administrators+SYSTEM only); it goes
  only to `api.github.com` and is never on a command line or in a log. Downloads must match `SHA256SUMS`;
  only strictly newer, non-draft, non-prerelease versions install. Root/SYSTEM must never run code a
  non-admin account can change: the Linux code folder stays `root:root`, the Windows one stays under
  Program Files (admin-only write). Upgrades keep `config.json` and `env`; a failed install puts the
  previous code back.
- **Versions**: the release tag must be `v<package.json version>` (checked by `release.yml`).
- PowerShell scripts must run on Windows PowerShell 5.1 and stay PSScriptAnalyzer-clean.
- `engines` says Node >= 18 but CI tests 20/22/24; avoid APIs newer than Node 20.
