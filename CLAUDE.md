# Foundry release proxy

A single-file Node HTTP proxy (`src/server.js`) that lets Foundry VTT install and update modules
released from **private** GitHub repositories. It holds a GitHub token, serves a module's
`module.json` from the latest (or a tagged) release with `manifest`/`download` rewritten to point
at the proxy, and answers zip requests with a `302` to GitHub's pre-signed asset URL. It runs as a
systemd service on a Raspberry Pi next to Foundry.

## Layout
- `src/server.js` – the whole app. Exports `createApp`, `loadConfig`, `parseConfig`, `ConfigError`;
  `main()` only runs when executed directly.
- `test/server.test.js` – `node:test` suite with an injected `fetchImpl` mock (no network).
- `scripts/install-service.sh` – systemd installer (`sudo`, `--uninstall`).
- `config.example.json`, `.env.example` – templates. Real `config.json`/`.env` are gitignored.

## Commands
- `npm test` – the unit tests. `npm start` – run the server.
- Local run: `GITHUB_TOKEN=... CONFIG_FILE=config.example.json node src/server.js`
- CI (`.github/workflows/ci.yml`): `node --check src/server.js` + `npm test` on Node 20/22/24,
  and `shellcheck scripts/*.sh`. Workflow changes are linted by actionlint and zizmor.

## Conventions
- CommonJS, `'use strict'`, **no npm dependencies** – Node built-ins and global `fetch` only.
  Adding a dependency needs a very good reason.
- 2-space indent, single quotes, semicolons. Small closures inside `createApp`; dependencies
  (`fetchImpl`, `log`) are injected so tests can replace them.
- Errors: `ConfigError` → exit 1 ("refusing to start"), `NotFound` → 404,
  `GithubError` → 502 with a generic body, anything else → 500 "internal error".
- Logging is one plain line through the injected `log`, prefixed with the module id.
- Behaviour changes need a test in `test/server.test.js` and matching README edits (the README
  documents routes, status codes and error messages).

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
- `engines` says Node >= 18 but CI tests 20/22/24; avoid APIs newer than Node 20.
