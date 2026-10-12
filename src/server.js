'use strict';
// Proxy that lets Foundry VTT install/update modules released from private GitHub repos.
// No dependencies: built-in http, fs and fetch only.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { createAdmin, loadAdminSettings, rewriteFile, SettingsError } = require('./admin.js');
const { createSelfSigned, defaultNames } = require('./selfsigned.js');

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 20000;
const MODULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ASSET_RE = /^[^/\\\s][^/\\]*$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

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
// are written to configFile.
function createApp({ modules, token, publicBaseUrl, configFile, admin, fetchImpl = fetch, log = console.log, mailer }) {
  const base = publicBaseUrl.replace(/\/+$/, '');

  const apiHeaders = (accept) => ({
    Authorization: `Bearer ${token}`,
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

  async function getRelease(repo, tag) {
    const path = tag === undefined ? 'latest' : `tags/${encodeURIComponent(tag)}`;
    const res = await api(`${GITHUB_API}/repos/${repo}/releases/${path}`, {
      headers: apiHeaders('application/vnd.github+json'),
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
    const server = createApp({ modules, token, publicBaseUrl, configFile, admin });
    server.listen(port, host, () => {
      const ids = Object.keys(modules).join(', ') || '(none yet)';
      console.log(`listening on http://${host}:${port}, modules: ${ids}`);
      console.log(adminOn ? `admin page: ${publicBaseUrl.replace(/\/+$/, '')}/_admin/` : `admin page off (no password in ${adminFile})`);
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
