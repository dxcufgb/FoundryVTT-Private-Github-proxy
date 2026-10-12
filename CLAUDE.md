# Foundry release proxy

A dependency-free Node HTTP proxy (`src/server.js`) that lets Foundry VTT install and update modules
released from **private** GitHub repositories. It holds a GitHub token, serves a module's
`module.json` from the latest (or a tagged) release with `manifest`/`download` rewritten to point
at the proxy, and answers zip requests with a `302` to GitHub's pre-signed asset URL. It runs as a
systemd service on a Raspberry Pi next to Foundry, or as a Windows scheduled task. An opt-in auto-updater
installs new releases of the proxy itself.

## Layout
- `src/server.js` – the HTTP proxy (everything except self-update). Exports `createApp`, `loadConfig`, `parseConfig`, `ConfigError`;
  `main()` only runs when executed directly. Hands `/_admin` to `src/admin.js` when the admin page is on.
- `src/admin.js` – the password-protected admin page (`/_admin/`, UI files in `src/admin-ui/`): JSON API to list/add/edit/
  delete modules (validated with `parseConfig`, written back to `config.json` in place), notification settings, password
  change. Settings in `admin.json` (`ADMIN_FILE`, default next to `CONFIG_FILE`): scrypt `passwordHash` + `notify`
  (recipients, SMTP). Off (404) without a password hash. CLI: `setup FILE` (installers; secrets via `FOUNDRY_PROXY_*` env),
  `check FILE`.
- `src/mailer.js` – minimal SMTP client (STARTTLS / TLS / plain relay, AUTH PLAIN/LOGIN only over TLS). `src/notify.js` –
  `--proxy-env FILE --subject --message`: mails the `admin.json` recipients; called by the auto-update scripts (not
  `--env-file`: Node itself grabs that flag even after the script name).
- `src/updater.js` – self-update helper for the proxy itself (not for Foundry modules): `--check` /
  `--download` the latest release of this repo (`foundry-release-proxy-<version>-linux.tar.gz` / `-windows.zip`), verify it
  against `SHA256SUMS.txt`. Exit 0 = up to date, 10 = update available/downloaded, 1 = error. No fallback to the legacy
  names: a newer release without the new ones is an error. Installing is left to the scripts.
- `test/server.test.js`, `test/updater.test.js`, `test/admin.test.js` (admin API, mailer against a fake SMTP server,
  notifier) – `node:test` suites with an injected `fetchImpl` mock
  (no network).
- `install.sh` – the single Linux entry point, at the top of the Linux archive (the one-liner of `dxcufgb/install` runs it
  as root): finds a system-wide Node (>= 18) or downloads the official Node 22 (SHA-256 checked) to
  `/opt/foundry-release-proxy-node`, exports `NODE_BIN`, then runs `scripts/install-service.sh` (passes its options on).
  Common option set of the four repos: `--yes`/`-y`, `--auto-update`/`--no-auto-update`, `--enable-auto-update`/
  `--disable-auto-update`, `--check-update` (0 / 10 / other), `--update-now`, `--uninstall [--purge]`, `--help`.
- `scripts/install-service.sh` – systemd installer (`sudo`; the common options plus `--module ID=OWNER/REPO`, `--check`
  (alias), `--upgrade` (used by the updater)). Code in `/opt/foundry-release-proxy` (root-owned), settings in
  `/etc/foundry-release-proxy/`. Updater token: `UPDATER_GITHUB_TOKEN`, the configured one, `INSTALL_GITHUB_TOKEN` (from
  the one-liner; asked first when interactive), a prompt, or the proxy's `GITHUB_TOKEN`.
- `scripts/auto-update.sh` – run as root by the `foundry-release-proxy-update` timer: locks, extracts,
  backs up to `/opt/foundry-release-proxy.prev`, runs `install-service.sh --upgrade`, rolls back on failure.
- `scripts/install-service.ps1`, `scripts/auto-update.ps1` – the same for Windows: code in
  `C:\Program Files\FoundryReleaseProxy`, settings and logs in `C:\ProgramData\FoundryReleaseProxy`; the proxy
  runs as LOCAL SERVICE, the daily update task as SYSTEM.
- `packaging/windows/` – the Inno Setup installer: `foundry-release-proxy.iss` (wizard + bundled Node.js in
  `Program Files\FoundryReleaseProxy-Node`, then runs `install-service.ps1 -Upgrade`), `stop-proxy.ps1`,
  `build-installer.ps1` (downloads and verifies Node, stamps `-Version` into a staged copy, runs ISCC, writes
  `foundry-release-proxy-<version>-setup.exe`) and `smoke-test.ps1` (silent install/uninstall, run by CI).
- `scripts/build-release.sh OUT VERSION` – builds `foundry-release-proxy-<version>-linux.tar.gz` and `-windows.zip` with
  VERSION stamped into the packed `package.json`; `--finish OUT VERSION` adds the fixed-name copies
  (`foundry-release-proxy-linux.tar.gz`, `-windows.zip`, `-setup.exe`), the legacy copies (the `LEGACY_ASSETS` block:
  names of 1.1.1 and older plus `SHA256SUMS`, for the updaters of old installs) and `SHA256SUMS.txt` over all files.
  `scripts/release-notes.sh` prints the per-OS download table that heads the release notes.
  `.github/workflows/release.yml`: Actions → Release → Run workflow → type the version (or publish a release `vX.Y.Z` by
  hand; files are attached afterwards). It runs `ci.yml` (workflow_call), the build, the Windows installer, then
  publishes (draft first; a leftover draft is replaced, a moved tag stops it).
- `.github/ruleset-protect-main.json` – the "Protect main" ruleset (squash only, 1 approval, required CI checks), the same
  as in the other FoundryVTT repos; importable only on a plan that allows rulesets on private repos. Keep its check names in
  step with the job names in `ci.yml` (only jobs that run on every PR belong in it). `.github/` also holds the PR and issue
  templates and `SECURITY.md`.
- `config.example.json`, `.env.example` – templates. Real `config.json`/`.env` are gitignored.

## Commands
- `npm test` – the unit tests. `npm start` – run the server.
- Local run: `GITHUB_TOKEN=... CONFIG_FILE=config.example.json node src/server.js`
- CI (`.github/workflows/ci.yml`): `node --check` on `src/*.js` and `src/admin-ui/app.js` + `npm test` on
  Node 20/22/24, `shellcheck install.sh scripts/*.sh`, PSScriptAnalyzer on `scripts/*.ps1` and `packaging/windows/*.ps1`, an
  `install.sh` run under systemd on the runner, and a silent install/uninstall of the Inno Setup exe on a Windows runner. Workflow changes are
  linted by actionlint and zizmor.

## Install on Linux and releasing
- **Install on Linux**: `curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundry-release-proxy`
  (private repo: it asks for a fine-grained token with read-only *Contents* access to this repository), or download
  `foundry-release-proxy-linux.tar.gz`, `tar xzf`, `cd foundry-release-proxy-X.Y.Z`, `sudo ./install.sh`. Options: see the README.
- **Releasing**: Actions → Release → Run workflow → type the version. Fallback: publish a release `vX.Y.Z` on GitHub,
  files are attached afterwards. No version bump in the code.

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
- Only GET and HEAD are allowed on the proxy routes; `/_admin/api` alone takes POST/PUT/DELETE. The proxy routes have no
  inbound auth – access control is binding to 127.0.0.1 (or the Docker bridge); never default to `0.0.0.0`.
- **Admin page**: every API call but login needs the session cookie (HttpOnly, SameSite=Strict, Path=/_admin); every
  change also the `X-CSRF-Token` and `Content-Type: application/json`; unknown `Host`/`Origin` → 403 (DNS rebinding).
  Login lockout after 5 failures. Strict CSP (no inline script/style: the UI only uses `textContent`). Neither the GitHub
  token, the password hash nor the SMTP password may appear in a response or a log line (tested).
- The proxy's account may rewrite `config.json`/`admin.json` in place but never create files in the settings folder
  (Linux: files owned by the service user, `ReadWritePaths=` exactly these two; Windows: LOCAL SERVICE `(R,W)`, no
  delete). Root never parses `admin.json`: `auto-update.sh` runs `notify.js` as the service user via `setpriv`.
- GitHub's 404 for a repo the token cannot see must stay a 404, not a 502.
- Installer: re-running it must never overwrite `/etc/foundry-release-proxy/config.json`, `admin.json` or
  `env`; `env` stays mode 600 owned by the service user; keep the systemd hardening and keep the
  script clean under shellcheck.
- **Auto-update** stays opt-in and runs as root (Linux) / SYSTEM (Windows). Its token is the proxy's
  `GITHUB_TOKEN` from `env` or a separate `updater-token` (root 600 / Administrators+SYSTEM only); it goes
  only to `api.github.com` and is never on a command line or in a log. Downloads must match `SHA256SUMS.txt`;
  only strictly newer, non-draft, non-prerelease versions install. Root/SYSTEM must never run code a
  non-admin account can change: the Linux code folder stays `root:root`, the Windows one stays under
  Program Files (admin-only write). Upgrades keep `config.json` and `env`; a failed install puts the
  previous code back.
- `main` is protected by convention (and by the ruleset where the plan allows): changes go through pull requests, merged
  with squash.
- **Versions**: the version comes from the release tag; nobody bumps `package.json` (it keeps the last release's
  version). The build stamps the tag's version into the built copy, which is what the updater compares.
- The Windows installer must not duplicate `install-service.ps1`: the wizard only collects answers, writes `config.json`
  if absent and calls the script (token via `FOUNDRY_PROXY_GITHUB_TOKEN`, never on a command line). Node.js stays outside the
  code folder because the updater replaces that folder.
- PowerShell scripts must run on Windows PowerShell 5.1 and stay PSScriptAnalyzer-clean.
- `engines` says Node >= 18 but CI tests 20/22/24; avoid APIs newer than Node 20.
