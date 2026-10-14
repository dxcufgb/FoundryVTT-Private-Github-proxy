'use strict';
// Proxy that lets Foundry VTT install/update modules released from private GitHub repos.
// No dependencies: built-in http, fs and fetch only.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { createAdmin, loadAdminSettings, rewriteFile, replaceEnvValue, tokenKind, SettingsError } = require('./admin.js');
const { createSelfSigned, defaultNames } = require('./selfsigned.js');
const { REPO: PROXY_REPO } = require('./updater.js');
const { notify } = require('./notify.js');

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 20000;
const MODULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ASSET_RE = /^[^/\\\s][^/\\]*$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// A token that expires within this many days is reported as a warning by "Test setup".
const EXPIRY_WARN_DAYS = 14;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

class ConfigError extends Error {}

// Raised for failures talking to GitHub; becomes a 502.
class GithubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Raised for "not found" results that become a 404.
class NotFound extends Error {}

// allowEmpty: an empty mapping is fine (the admin page can add modules to it).
function parseConfig(text, source = 'config', { allowEmpty = false } = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${source}: not valid JSON (${err.message})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${source}: top level must be an object mapping module ids to {"repo": "owner/name"}`);
  }
  const modules = Object.create(null);
  const ids = Object.keys(raw);
  if (ids.length === 0 && !allowEmpty) throw new ConfigError(`${source}: no modules configured`);
  for (const id of ids) {
    const entry = raw[id];
    if (!MODULE_ID_RE.test(id)) {
      throw new ConfigError(`${source}: invalid module id "${id}" (letters, digits, "-" and "_" only)`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConfigError(`${source}: module "${id}" must be an object like {"repo": "owner/name"}`);
    }
    if (typeof entry.repo !== 'string' || !REPO_RE.test(entry.repo)) {
      throw new ConfigError(`${source}: module "${id}" needs "repo" in the form "owner/name"`);
    }
    const known = new Set(['repo', 'manifestAsset', 'zipAsset']);
    for (const key of Object.keys(entry)) {
      if (!known.has(key)) throw new ConfigError(`${source}: module "${id}" has unknown key "${key}"`);
    }
    const cfg = { repo: entry.repo, manifestAsset: 'module.json', zipAsset: 'module.zip' };
    for (const key of ['manifestAsset', 'zipAsset']) {
      if (entry[key] === undefined) continue;
      if (typeof entry[key] !== 'string' || !ASSET_RE.test(entry[key])) {
        throw new ConfigError(`${source}: module "${id}" has an invalid "${key}"`);
      }
      cfg[key] = entry[key];
    }
    modules[id] = cfg;
  }
  return modules;
}

function loadConfig(file, options) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config file ${file}: ${err.message}`);
  }
  return parseConfig(text, file, options);
}

// admin: { file, settings, hosts, trustProxy } turns on the /_admin page (when settings has a password hash); its module changes
// are written to configFile, a new GitHub token to the GITHUB_TOKEN line of envFile. The daily check mails the
// recipients in adminFile (admin.json, whether or not the page is on) and points them to adminUrl.
function createApp({
  modules,
  token,
  publicBaseUrl,
  configFile,
  envFile,
  adminFile,
  adminUrl,
  admin,
  fetchImpl = fetch,
  log = console.log,
  mailer,
}) {
  const base = publicBaseUrl.replace(/\/+$/, '');
  // The admin page can replace it (githubToken.save below).
  let currentToken = token;

  const apiHeaders = (accept, tok = currentToken) => ({
    Authorization: `Bearer ${tok}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'foundry-release-proxy',
  });

  async function api(url, init) {
    try {
      return await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
    } catch (err) {
      throw new GithubError(`request failed: ${err.message}`, 'network');
    }
  }

  async function getRelease(repo, tag, tok) {
    const path = tag === undefined ? 'latest' : `tags/${encodeURIComponent(tag)}`;
    const res = await api(`${GITHUB_API}/repos/${repo}/releases/${path}`, {
      headers: apiHeaders('application/vnd.github+json', tok),
    });
    if (res.status === 404) {
      // GitHub also answers 404 when the token cannot see a private repo.
      throw new NotFound('release not found');
    }
    if (!res.ok) throw new GithubError('release lookup failed', res.status);
    try {
      return await res.json();
    } catch {
      throw new GithubError('release lookup returned invalid JSON', res.status);
    }
  }

  // Resolves the asset's pre-signed download URL without following the redirect.
  async function assetLocation(release, name) {
    const asset = (release.assets || []).find((a) => a.name === name);
    if (!asset) throw new NotFound(`asset ${name} not found in release ${release.tag_name}`);
    const res = await api(asset.url, {
      headers: apiHeaders('application/octet-stream'),
      redirect: 'manual',
    });
    await res.body?.cancel?.();
    const location = res.headers.get('location');
    if (!REDIRECTS.has(res.status) || !location) {
      throw new GithubError('asset download did not redirect', res.status);
    }
    return location;
  }

  async function manifestFor(moduleId, release, cfg) {
    const location = await assetLocation(release, cfg.manifestAsset);
    // The pre-signed URL rejects requests that also carry an Authorization header.
    const res = await api(location, { headers: { 'User-Agent': 'foundry-release-proxy' } });
    if (!res.ok) throw new GithubError('manifest download failed', res.status);
    let manifest;
    try {
      manifest = await res.json();
    } catch {
      throw new GithubError('manifest is not valid JSON', res.status);
    }
    manifest.manifest = `${base}/${moduleId}/module.json`;
    manifest.download = `${base}/${moduleId}/${encodeURIComponent(release.tag_name)}/module.zip`;
    return manifest;
  }

  // What the admin page shows for "Check release".
  async function checkRelease(cfg) {
    try {
      const release = await getRelease(cfg.repo);
      const names = (release.assets || []).map((a) => a.name);
      return {
        tag: release.tag_name,
        published: release.published_at || null,
        url: release.html_url || null,
        missing: [cfg.manifestAsset, cfg.zipAsset].filter((n) => !names.includes(n)),
      };
    } catch (err) {
      if (err instanceof NotFound) return { error: 'no release found, or the token cannot see this repository' };
      if (err instanceof GithubError) {
        log(`admin: release check for ${cfg.repo} failed status=${err.status} (${err.message})`);
        return { error: 'GitHub request failed' };
      }
      throw err;
    }
  }

  // Where a token set on the admin page goes: the GITHUB_TOKEN line of envFile, rewritten in place. '' = it can.
  function tokenStorageProblem() {
    if (!envFile) return 'no env file (set ENV_FILE)';
    let text;
    try {
      text = fs.readFileSync(envFile, 'utf8');
    } catch (err) {
      return `cannot read it (${err.code || err.message})`;
    }
    if (replaceEnvValue(text, 'GITHUB_TOKEN', 'x') === null) return 'it has no GITHUB_TOKEN line';
    try {
      // Opening for writing (nothing is written) is the real test: systemd's read-only mounts, Windows ACLs.
      fs.closeSync(fs.openSync(envFile, 'r+'));
    } catch (err) {
      return `the proxy's account may not write it (${err.code || err.message}); re-run the installer of this version`;
    }
    return '';
  }

  // GET /user: whether GitHub accepts the token, whose it is and when it expires. Never returns the token.
  async function checkToken(tok) {
    let res;
    try {
      res = await api(`${GITHUB_API}/user`, { headers: apiHeaders('application/vnd.github+json', tok) });
    } catch (err) {
      const message = `could not reach GitHub (${err.message.replace(/^request failed: /, '')})`;
      return { status: 'bad', unreachable: true, message };
    }
    const header = res.headers.get('github-authentication-token-expiration') || '';
    const expires = /^[0-9A-Za-z :+-]{1,40}$/.test(header) ? header : null;
    let login = null;
    if (res.ok) {
      try {
        const user = await res.json();
        if (typeof user.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(user.login)) login = user.login;
      } catch {
        // the status alone says the token works
      }
    } else {
      await res.body?.cancel?.();
    }
    if (res.status === 401) return { status: 'bad', message: 'GitHub rejects the token (expired, revoked or mistyped)' };
    if (!res.ok && res.status !== 403) return { status: 'bad', message: `GitHub answered HTTP ${res.status}` };
    const days = expires ? (Date.parse(expires) - Date.now()) / 86400000 : NaN;
    const owner = login ? ` (${login})` : '';
    if (days < 0) return { status: 'bad', login, expires, message: `the token expired on ${expires}` };
    if (days < EXPIRY_WARN_DAYS) {
      const left = days < 1 ? 'within a day' : `in ${Math.floor(days)} day(s)`;
      return { status: 'warn', login, expires, message: `accepted${owner}, but it expires ${left}: replace it soon` };
    }
    return { status: 'ok', login, expires, message: `accepted${owner}` + (expires ? `; expires ${expires}` : '; no expiry date') };
  }

  // GET /repos/<repo>: null when the token can see the repository, else a failed check saying why not.
  async function repoAccess(repo, tok) {
    let res;
    try {
      res = await api(`${GITHUB_API}/repos/${repo}`, { headers: apiHeaders('application/vnd.github+json', tok) });
    } catch (err) {
      return { status: 'bad', unreachable: true, message: `could not reach GitHub (${err.message.replace(/^request failed: /, '')})` };
    }
    await res.body?.cancel?.();
    if (res.ok) return null;
    if (res.status === 404) {
      return { status: 'bad', message: "the token cannot see this repository (add it to the token's Repository access)" };
    }
    if (res.status === 401) return { status: 'bad', message: 'GitHub rejects the token' };
    if (res.status === 403) {
      return { status: 'bad', message: 'GitHub refused access (HTTP 403): the token may lack Contents: read-only, or its owner blocks this token' };
    }
    return { status: 'bad', message: `GitHub answered HTTP ${res.status}` };
  }

  // One line of "Test setup": can the token see the repository, and does its latest release have the assets?
  async function checkRepo(repo, assets, tok) {
    const denied = await repoAccess(repo, tok);
    if (denied) return denied;
    let release;
    try {
      release = await getRelease(repo, undefined, tok);
    } catch (err) {
      if (err instanceof NotFound) return { status: 'bad', message: 'no published release (drafts and pre-releases do not count)' };
      if (err instanceof GithubError && err.status === 'network') {
        return { status: 'bad', unreachable: true, message: `could not reach GitHub (${err.message.replace(/^request failed: /, '')})` };
      }
      if (err instanceof GithubError) return { status: 'bad', message: `release lookup failed (HTTP ${err.status})` };
      throw err;
    }
    const names = (release.assets || []).map((a) => a.name);
    const missing = assets.filter((n) => !names.includes(n));
    if (missing.length) return { status: 'bad', message: `latest release ${release.tag_name} lacks ${missing.join(', ')}` };
    return { status: 'ok', message: `latest release ${release.tag_name}` };
  }

  // "Test setup": the token, then this proxy's own repository (automatic updates) and every module repository.
  async function testSetup(tok = currentToken) {
    const token = await checkToken(tok);
    if (token.status === 'bad') return { token, checks: [] };
    const proxy = checkRepo(PROXY_REPO, [], tok).then((r) => {
      // Only needed when automatic updates use the proxy's token rather than an updater token of their own.
      const why = 'automatic updates need it unless they have their own updater token';
      return { kind: 'proxy', name: 'Automatic updates', repo: PROXY_REPO,
        ...(r.status === 'ok' ? r : { status: 'warn', message: `${r.message}; ${why}` }) };
    });
    const mods = Object.keys(modules).sort().map((id) => {
      const cfg = modules[id];
      return checkRepo(cfg.repo, [cfg.manifestAsset, cfg.zipAsset], tok).then((r) => ({ kind: 'module', name: id, repo: cfg.repo, ...r }));
    });
    return { token, checks: await Promise.all([proxy, ...mods]) };
  }

  // The daily check: "Test setup" with the token in use. Problems are mailed to the notification recipients every day
  // they last, and one more mail says when they are gone. lastCheck is shown on the admin page.
  let lastCheck = null; // { at, problems }
  let failing = false;
  // The proxy's own repository counts only once the token has been seen to read it: many installs never give it
  // access (no automatic updates, or an updater token of their own), and they must not get a mail every day.
  let proxyRepoSeen = false;
  const adminLink = adminUrl || `${base}/_admin/`;

  async function mail(subject, message) {
    if (!adminFile) return log('daily check: no admin.json, so nobody to e-mail');
    try {
      await notify({ 'admin-file': adminFile, subject, message }, { mailer, log: (l) => log(`daily check: ${l}`) });
    } catch (err) {
      log(`daily check: e-mail not sent (${err.message})`);
    }
  }

  // Runs the check once. deferUnreachable: when GitHub could not be reached, mail nothing and report deferred
  // (the scheduler tries again an hour later; a second miss is mailed).
  async function runSetupCheck({ deferUnreachable = false } = {}) {
    const result = await testSetup();
    const problems = [];
    if (result.token.status !== 'ok') problems.push(`GitHub token: ${result.token.message}`);
    for (const c of result.checks) {
      if (c.kind === 'proxy' && c.status === 'ok') proxyRepoSeen = true;
      if (c.status === 'ok' || (c.kind === 'proxy' && !proxyRepoSeen && !c.unreachable)) continue;
      problems.push(`${c.name} (${c.repo}): ${c.message}`);
    }
    const unreachable = Boolean(result.token.unreachable || result.checks.some((c) => c.unreachable));
    lastCheck = { at: new Date().toISOString(), problems };
    log(problems.length ? `daily check: ${problems.length} problem(s)` : 'daily check: all OK');
    if (unreachable && deferUnreachable) return { problems, deferred: true };
    if (problems.length) {
      await mail('setup problems', 'The daily check of the Foundry release proxy found:\n\n' +
        problems.map((p) => `- ${p}`).join('\n') +
        `\n\nFoundry cannot install or update the affected modules until this is fixed. Replace the token or run ` +
        `"Test setup" on the administration page: ${adminLink}\n`);
    } else if (failing) {
      await mail('setup OK again', `The daily check of the Foundry release proxy found no problems any more.\n`);
    }
    failing = problems.length > 0;
    return { problems, deferred: false };
  }

  // Daily checks: the first firstDelayMs after start (an update restart is followed by one), then every intervalMs.
  function startDailyChecks({ firstDelayMs = HOUR_MS, intervalMs = DAY_MS, retryMs = HOUR_MS } = {}) {
    let timer = null;
    const schedule = (ms, retry) => {
      timer = setTimeout(async () => {
        let next = intervalMs;
        let isRetry = false;
        try {
          const r = await runSetupCheck({ deferUnreachable: !retry });
          if (r.deferred) [next, isRetry] = [retryMs, true];
        } catch (err) {
          log(`daily check: failed (${err.message})`);
        }
        if (timer) schedule(next, isRetry);
      }, ms);
      timer.unref();
    };
    schedule(firstDelayMs, false);
    return () => {
      clearTimeout(timer);
      timer = null;
    };
  }

  const githubToken = {
    info: () => ({ kind: tokenKind(currentToken), file: envFile || null, problem: tokenStorageProblem(), lastCheck }),
    check: checkToken,
    test: testSetup,
    save(tok) {
      const text = replaceEnvValue(fs.readFileSync(envFile, 'utf8'), 'GITHUB_TOKEN', tok);
      if (text === null) throw new Error('no GITHUB_TOKEN line');
      rewriteFile(envFile, text);
      currentToken = tok;
    },
  };

  const adminPage = admin && createAdmin({
    adminFile: admin.file,
    settings: admin.settings,
    extraHosts: admin.hosts,
    trustProxy: admin.trustProxy || [],
    publicBaseUrl,
    log,
    mailer,
    getModules: () => modules,
    validateModules: (raw) => parseConfig(JSON.stringify(raw), 'admin', { allowEmpty: true }),
    saveModules: (parsed, raw) => {
      rewriteFile(configFile, `${JSON.stringify(raw, null, 2)}\n`);
      modules = parsed;
    },
    checkRelease,
    githubToken,
  });

  async function route(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://proxy').pathname;
    } catch {
      return send(res, 404, 'not found');
    }
    if (adminPage && adminPage.handles(pathname)) return adminPage.handle(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    }
    let segments;
    try {
      segments = pathname.slice(1).split('/').map(decodeURIComponent);
    } catch {
      return send(res, 404, 'not found');
    }
    const [moduleId] = segments;
    const last = segments[segments.length - 1];
    const tag = segments.length === 3 ? segments[1] : undefined;
    const shapeOk =
      (segments.length === 2 && last === 'module.json') ||
      (segments.length === 3 && tag && (last === 'module.json' || last === 'module.zip'));
    if (!shapeOk || !Object.hasOwn(modules, moduleId)) return send(res, 404, 'not found');
    const cfg = modules[moduleId];

    try {
      const release = await getRelease(cfg.repo, tag);
      if (last === 'module.zip') {
        const location = await assetLocation(release, cfg.zipAsset);
        log(`${moduleId}: zip ${release.tag_name} redirected to GitHub`);
        return send(res, 302, `redirecting to ${release.tag_name} download`, { Location: location });
      }
      const manifest = await manifestFor(moduleId, release, cfg);
      log(`${moduleId}: served manifest ${release.tag_name}`);
      return send(res, 200, JSON.stringify(manifest, null, 2), { 'Content-Type': 'application/json' });
    } catch (err) {
      if (err instanceof NotFound) {
        log(`${moduleId}: 404 ${err.message}`);
        return send(res, 404, err.message);
      }
      if (err instanceof GithubError) {
        log(`${moduleId}: GitHub error status=${err.status} (${err.message})`);
        return send(res, 502, 'bad gateway: GitHub request failed');
      }
      throw err;
    }
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  // The browser-facing admin listener (ADMIN_PORT) serves the admin page only; "/" leads to it.
  async function adminRoute(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://proxy').pathname;
    } catch {
      return send(res, 404, 'not found');
    }
    if (pathname === '/') return send(res, 302, 'see /_admin/', { Location: '/_admin/' });
    if (adminPage && adminPage.handles(pathname)) return adminPage.handle(req, res, pathname);
    return send(res, 404, 'not found');
  }

  // Runs a route handler, turning a thrown/rejected error into the 500 response.
  const wrap = (fn) => (req, res) => {
    fn(req, res).catch((err) => {
      log(`internal error: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.end();
    });
  };

  const server = http.createServer(wrap(route));
  server.runSetupCheck = runSetupCheck;
  server.startDailyChecks = (opts) => {
    const stop = startDailyChecks(opts);
    server.on('close', stop);
    return stop;
  };

  // tls { cert, key }: HTTPS on the admin port, where a plain-HTTP request gets a redirect to https:// (like Webmin);
  // no tls: plain HTTP (behind a reverse proxy that does HTTPS).
  server.createAdminServer = (tls) => {
    if (!tls) return http.createServer(wrap(adminRoute));
    const secure = https.createServer({ ...tls, minVersion: 'TLSv1.2' }, wrap(adminRoute));
    const redirect = http.createServer((req, res) => {
      const host = /^[A-Za-z0-9.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : null;
      if (!host) return send(res, 400, 'use https://');
      return send(res, 301, 'use https://', { Location: `https://${host}/_admin/` });
    });
    // A TLS connection starts with a handshake record (0x16); anything else is plain HTTP.
    const front = net.createServer((socket) => {
      socket.once('data', (first) => {
        socket.pause();
        socket.unshift(first);
        (first[0] === 0x16 ? secure : redirect).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
      socket.on('error', () => socket.destroy());
      socket.setTimeout(30000, () => socket.destroy());
    });
    front.on('close', () => {
      secure.close();
      redirect.close();
    });
    return front;
  };
  return server;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Certificate for the admin port: ADMIN_TLS_CERT/ADMIN_TLS_KEY (default admin-tls.crt/.key next to config.json, made
// by the installers). Without those files a temporary self-signed one is made (it changes on every restart).
function adminTls(env, configFile, extraNames) {
  const dir = path.dirname(configFile);
  const certFile = env.ADMIN_TLS_CERT || path.join(dir, 'admin-tls.crt');
  const keyFile = env.ADMIN_TLS_KEY || path.join(dir, 'admin-tls.key');
  try {
    return { tls: { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, note: `certificate ${certFile}` };
  } catch (err) {
    if (env.ADMIN_TLS_CERT || env.ADMIN_TLS_KEY) {
      throw new ConfigError(`cannot read ADMIN_TLS_CERT / ADMIN_TLS_KEY (${err.message})`);
    }
    return {
      tls: createSelfSigned(defaultNames(extraNames)),
      note: `temporary self-signed certificate (no ${certFile}; it changes on every restart)`,
    };
  }
}

// Reads the environment, starts the proxy (and, if configured, the browser admin port) and returns the HTTP server.
function main(env = process.env) {
  try {
    const token = env.GITHUB_TOKEN;
    if (!token) throw new ConfigError('GITHUB_TOKEN is not set');
    const port = env.PORT === undefined || env.PORT === '' ? 8787 : Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`invalid PORT "${env.PORT}"`);
    const host = env.HOST || '127.0.0.1';
    const publicBaseUrl = env.PUBLIC_BASE_URL || `http://localhost:${port}`;
    try {
      new URL(publicBaseUrl);
    } catch {
      throw new ConfigError(`invalid PUBLIC_BASE_URL "${publicBaseUrl}"`);
    }
    const configFile = env.CONFIG_FILE || './config.json';
    // admin.json next to config.json unless ADMIN_FILE says otherwise; without a password hash the page is off.
    const adminFile = env.ADMIN_FILE || path.join(path.dirname(configFile), 'admin.json');
    // The env file the token comes from (the installers put it next to config.json); the admin page rewrites its
    // GITHUB_TOKEN line when the token is changed there.
    const envFile = env.ENV_FILE || path.join(path.dirname(configFile), 'env');
    let adminSettings;
    try {
      adminSettings = loadAdminSettings(adminFile);
    } catch (err) {
      if (err instanceof SettingsError) throw new ConfigError(err.message);
      throw err;
    }
    const adminOn = Boolean(adminSettings.passwordHash);
    const modules = loadConfig(configFile, { allowEmpty: adminOn });
    const hosts = (env.ADMIN_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
    if (host !== '0.0.0.0' && host !== '::') hosts.push(host);
    if (env.ADMIN_PUBLIC_URL) {
      try {
        hosts.push(new URL(env.ADMIN_PUBLIC_URL).hostname);
      } catch {
        throw new ConfigError(`invalid ADMIN_PUBLIC_URL "${env.ADMIN_PUBLIC_URL}"`);
      }
    }
    // ADMIN_TRUST_PROXY: 1 = a reverse proxy on this machine; or the proxies' addresses, comma separated.
    let trustProxy = [];
    const tp = (env.ADMIN_TRUST_PROXY || '').trim().toLowerCase();
    if (tp === '1' || tp === 'true' || tp === 'yes') trustProxy = ['loopback'];
    else if (tp && !/^(0|false|no)$/.test(tp)) {
      trustProxy = tp.split(',').map((a) => a.trim()).filter(Boolean);
      const bad = trustProxy.find((a) => a !== 'loopback' && !net.isIP(a));
      if (bad) throw new ConfigError(`ADMIN_TRUST_PROXY: "${bad}" is not an IP address (use 1, or the proxies' addresses)`);
    }

    // The admin page in the browser, Webmin style: its own port (ADMIN_PORT), HTTPS unless ADMIN_TLS=off.
    let adminPort;
    if (env.ADMIN_PORT !== undefined && env.ADMIN_PORT !== '') {
      adminPort = Number(env.ADMIN_PORT);
      if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) {
        throw new ConfigError(`invalid ADMIN_PORT "${env.ADMIN_PORT}"`);
      }
      if (adminPort === port) throw new ConfigError('ADMIN_PORT must differ from PORT');
    }
    const adminHost = env.ADMIN_HOST || '0.0.0.0';
    const tlsOff = /^(off|0|false|no)$/i.test(env.ADMIN_TLS || '');
    let tls;
    if (adminOn && adminPort && !tlsOff) tls = adminTls(env, configFile, hosts);

    const admin = adminOn ? { file: adminFile, settings: adminSettings, hosts, trustProxy } : undefined;
    const adminUrl = env.ADMIN_PUBLIC_URL ? `${env.ADMIN_PUBLIC_URL.replace(/\/+$/, '')}/_admin/` : undefined;
    const server = createApp({ modules, token, publicBaseUrl, configFile, envFile, adminFile, adminUrl, admin });
    // DAILY_CHECK=off: no daily "Test setup" and no problem e-mails.
    const dailyCheck = !/^(off|0|false|no)$/i.test(env.DAILY_CHECK || '');
    if (dailyCheck) server.startDailyChecks();
    server.listen(port, host, () => {
      const ids = Object.keys(modules).join(', ') || '(none yet)';
      console.log(`listening on http://${host}:${port}, modules: ${ids}`);
      console.log(adminOn ? `admin page: ${publicBaseUrl.replace(/\/+$/, '')}/_admin/` : `admin page off (no password in ${adminFile})`);
      console.log(dailyCheck ? 'daily check on (problems are e-mailed to the recipients in admin.json)' : 'daily check off (DAILY_CHECK)');
    });
    if (adminOn && adminPort) {
      const adminServer = server.createAdminServer(tls && tls.tls);
      adminServer.on('error', (err) => {
        console.error(`admin port ${adminHost}:${adminPort}: ${err.message}`);
        process.exit(1);
      });
      adminServer.listen(adminPort, adminHost, () => {
        const scheme = tls ? 'https' : 'http';
        console.log(`admin page for the browser: ${scheme}://${adminHost}:${adminPort}/ (${tls ? tls.note : 'plain HTTP'})`);
        if (!tls && !LOOPBACK.has(adminHost) && !trustProxy.length) {
          console.log('WARNING: ADMIN_TLS=off on a network address: the admin password crosses the network unencrypted');
        }
      });
    }
    return server;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`foundry-release-proxy: refusing to start: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { createApp, loadConfig, parseConfig, ConfigError };
