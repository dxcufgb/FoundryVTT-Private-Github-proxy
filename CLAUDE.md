# Foundry release proxy

A dependency-free Node HTTP proxy (`src/server.js`) that lets Foundry VTT install and update modules
released from **private** GitHub repositories. It holds a GitHub token, serves a module's
`module.json` from the latest (or a tagged) release with `manifest`/`download` rewritten to point
at the proxy, and serves zips from GitHub's pre-signed asset URL with the `module.json` inside rewritten the same way
(Foundry's update check uses that one), falling back to a `302` to that URL. It runs as a
systemd service on a Raspberry Pi next to Foundry, or as a Windows scheduled task. An opt-in auto-updater
installs new releases of the proxy itself.

## Layout
- `src/server.js` – the HTTP proxy (everything except self-update), the GitHub side of the token change and "Test setup",
  and the daily check (`startDailyChecks`, off with `DAILY_CHECK=off`): "Test setup" an hour after start and then
  daily; problems are mailed through `notify.js` to the `admin.json` recipients every day they last, plus one "OK again"
  mail; an unreachable GitHub is retried an hour later before it is mailed. Exports `createApp`, `loadConfig`, `parseConfig`, `ConfigError`;
  `main()` only runs when executed directly. Hands `/_admin` to `src/admin.js` when the admin page is on. With
  `ADMIN_PORT` it also opens the browser admin port (`server.createAdminServer(tls)`): only admin routes, HTTPS (a TLS
  first byte goes to https, anything else gets a 301 to https://), `/` → `/_admin/`.
- `src/zippatch.js` – rewrites the `module.json` inside a zip without unpacking or buffering it: reads the end record and
  central directory, finds the top-level (or single-folder) `module.json`, and builds what follows the unchanged prefix
  (a new local entry, the central directory pointing at it, a new end record). Refuses (`ZipPatchError`) ZIP64,
  multi-disk, encrypted or odd-method zips; the server then falls back to the redirect.
- `src/selfsigned.js` – ECDSA P-256 self-signed X.509 certificate built with `node:crypto` (DER by hand); CLI writes
  `admin-tls.crt`/`.key` for the installers.
- `src/admin.js` – the password-protected admin page (`/_admin/`, UI files in `src/admin-ui/`: one HTML page whose views
  are picked by the URL fragment, `#/` modules and `#/token`, `#/notifications`, `#/password`, all in the cogwheel menu
  with the current page highlighted; with a token in use the token page shows a checkmark and "Add new token" (a dialog);
  each module's actions (Copy link, Check release, Edit, Delete) are in its row's "⋯" menu; the footer (also on the login page, without
  the version and button) holds "Built by Dxcufgb 2026", the version and "Check for update", which opens the "Update now / Not now" dialog when a newer release exists): JSON API to list/add/edit/
  delete modules (validated with `parseConfig`, written back to `config.json` in place), the GitHub token (`PUT
  /api/token`: format check, GitHub must accept it, then the `GITHUB_TOKEN` line of `env` (`ENV_FILE`, default next to
  `CONFIG_FILE`) is rewritten in place and the proxy switches over; `POST /api/setup-test`: the token, the proxy's own
  repo and every module repo, with the typed token or the one in use), "Update proxy now" (`GET /api/update`: installed and
  latest version; `POST /api/update`, at most every 2 minutes: asks the root/SYSTEM updater to run through the injected
  `updateTrigger`: Linux `fileUpdateTrigger` rewrites `update-request`, which the installer's systemd path unit
  `foundry-release-proxy-update-now.path` watches; Windows `taskUpdateTrigger` runs the SYSTEM task
  `FoundryReleaseProxy-UpdateNow` with `schtasks /Run`), notification settings, password change. Settings in `admin.json` (`ADMIN_FILE`, default next to `CONFIG_FILE`): scrypt `passwordHash` + `notify`
  (recipients, SMTP). Off (404) without a password hash. CLI: `setup FILE` (installers; secrets via `FOUNDRY_PROXY_*` env),
  `check FILE`.
- `src/mailer.js` – minimal SMTP client (STARTTLS / TLS / plain relay, AUTH PLAIN/LOGIN only over TLS). `src/notify.js` –
  `--proxy-env FILE --subject --message`: mails the `admin.json` recipients; called by the auto-update scripts (not
  `--env-file`: Node itself grabs that flag even after the script name).
- `src/updater.js` – self-update helper for the proxy itself (not for Foundry modules): `--check` /
  `--download` the latest release of this repo (`foundry-release-proxy-<version>-linux.tar.gz` / `-windows.zip`), verify it
  against `SHA256SUMS.txt`. Exit 0 = up to date, 10 = update available/downloaded, 1 = error. No fallback to the legacy
  names: a newer release without the new ones is an error. Installing is left to the scripts.
- `test/zippatch.test.js` (zip patching against zips built by `test/zipfixture.js`, which also reads zips back
  independently), `test/server.test.js`, `test/updater.test.js`, `test/admin.test.js` (admin API, mailer against a fake SMTP server,
  notifier), `test/adminweb.test.js` (admin port over HTTPS, certificate, reverse-proxy headers) – `node:test` suites with an injected `fetchImpl` mock
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
  as in the other FoundryVTT repos and enforced by GitHub (the account has GitHub Pro). Keep its check names in
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
- Security (`.github/workflows/security.yml`, required checks `Secrets (gitleaks)`, `Code (Semgrep)`, `Dependencies`; push to main, PRs, weekly): locally `gitleaks git --redact --log-opts="--full-history --diff-filter=tuxdb --diff-merges=first-parent HEAD" .` (only the checked-out history, like CI), `semgrep scan --metrics=off --error --severity WARNING --severity ERROR --config p/python --config p/javascript --config p/security-audit --config p/secrets --config p/github-actions --config r/bash`, and no npm dependencies, so nothing to audit (the job fails if `package.json` gains one). Semgrep false positives: `// nosemgrep: <rule-id>` (JavaScript) or `# nosemgrep: <rule-id>` (shell, YAML, PowerShell) on the matched line or the line immediately before it, with a reason; gitleaks: `.gitleaks.toml` with `[extend]` `useDefault = true`.

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
- **Zips**: the proxy streams a module zip from its pre-signed URL (fetched **without** auth, partial `Range` reads only)
  and changes nothing but the `module.json` reference at the end (`src/zippatch.js`). It never unpacks the zip or holds
  it in memory (only the end of the zip and `module.json`, with size caps); anything unexpected before the first byte
  falls back to the `302`, and a failure after it tears the connection down (never a truncated zip that looks whole).
  `PATCH_ZIPS=off` restores plain redirects.
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
  token (old, new or only tested), the password hash nor the SMTP password may appear in a response, a log line or a
  daily-check e-mail (tested). A new token must match `TOKEN_RE` (letters, digits, `_`) before it is written, so it can
  never add a line to `env`; never loosen that. The token API never answers 401 (the UI reads 401 as "logged out").
- **Admin port**: never serves module routes (they have no auth). Host allowlist = localhost, this machine's names and
  interface addresses, `PUBLIC_BASE_URL`/`ADMIN_PUBLIC_URL` hosts, `ADMIN_HOSTS`. `X-Forwarded-*` only from a peer that
  `ADMIN_TRUST_PROXY` names (`1` = loopback, or a list of IPs); anyone else could fake them past the lockout. No HSTS (self-signed certificates would become un-bypassable). The certificate files are
  root-owned, readable by the service. Installers only change `ADMIN_*` lines in `env` on an explicit option
  (`--admin-web`, `-AdminWeb`, first-install prompt).
- The proxy's account may rewrite `config.json`/`admin.json`/`env` (only its `GITHUB_TOKEN` line) and, on Linux, the
  empty `update-request` in place but never create files in the settings folder (Linux: files owned by the service
  user, `ReadWritePaths=` exactly these four; Windows: LOCAL SERVICE `(R,W)`, no delete).
- **Update proxy now** may only *request* the existing root/SYSTEM update run (`auto-update.sh --apply` /
  `auto-update.ps1 -Apply`, the same checks as the daily one); nothing the proxy writes or sends may reach that run:
  root never reads `update-request` (the path unit only reacts to the change), the Windows task takes no arguments and
  LOCAL SERVICE has only read+run (`GRGX`) on it. The installer pauses the path unit while it (re)makes the file, so an
  install never counts as a request. Uninstall removes the units/task and the file. Root/SYSTEM read `env` as text only (`env_value`, `Get-EnvValue`,
  `parseTokenFile`), never source it, and validate every value they use from it. Root never parses `admin.json`: `auto-update.sh` runs `notify.js` as the service user via `setpriv`.
- GitHub's 404 for a repo the token cannot see must stay a 404, not a 502.
- Installer: re-running it must never overwrite `/etc/foundry-release-proxy/config.json`, `admin.json` or
  `env`; `env` stays mode 600 owned by the service user; keep the systemd hardening and keep the
  script clean under shellcheck.
- **Auto-update** stays opt-in and runs as root (Linux) / SYSTEM (Windows). Its token is the proxy's
  `GITHUB_TOKEN` from `env` or a separate `updater-token` (root 600 / Administrators+SYSTEM only); it goes
  only to `api.github.com` and is never on a command line or in a log. Downloads must match `SHA256SUMS.txt`;
  only strictly newer, non-draft, non-prerelease versions install. Root/SYSTEM must never run code a
  non-admin account can change: the Linux code folder stays `root:root` with explicit
  modes (`chmod -R u=rwX,go=rX`, never left to root's umask, which can make it unreadable for the service), the Windows one stays under
  Program Files (admin-only write). Upgrades keep `config.json` and `env`; a failed install puts the
  previous code back.
- `main` is protected by the "Protect main" ruleset: changes go through pull requests, merged with squash; release tags
  `v*` are protected by the "Protect release tags" ruleset.
- **Versions**: the version comes from the release tag; nobody bumps `package.json` (it keeps the last release's
  version). The build stamps the tag's version into the built copy, which is what the updater compares.
- The Windows installer must not duplicate `install-service.ps1`: the wizard only collects answers, writes `config.json`
  if absent and calls the script (token via `FOUNDRY_PROXY_GITHUB_TOKEN`, never on a command line). Node.js stays outside the
  code folder because the updater replaces that folder.
- PowerShell scripts must run on Windows PowerShell 5.1 and stay PSScriptAnalyzer-clean.
- `engines` says Node >= 18 but CI tests 20/22/24; avoid APIs newer than Node 20.
