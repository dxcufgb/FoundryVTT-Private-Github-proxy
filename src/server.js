'use strict';
// Proxy that lets Foundry VTT install/update modules released from private GitHub repos.
// No dependencies: built-in http, fs and fetch only.

const http = require('node:http');
const fs = require('node:fs');

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

function parseConfig(text, source = 'config') {
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
  if (ids.length === 0) throw new ConfigError(`${source}: no modules configured`);
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

function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config file ${file}: ${err.message}`);
  }
  return parseConfig(text, file);
}

function createApp({ modules, token, publicBaseUrl, fetchImpl = fetch, log = console.log }) {
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

  async function route(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    }
    let segments;
    try {
      segments = new URL(req.url, 'http://proxy').pathname.slice(1).split('/').map(decodeURIComponent);
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
      'Cache-Control': 'public, max-age=3600',
      ...headers,
    });
    res.end(body);
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log(`internal error: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.end();
    });
  });
}

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
    const modules = loadConfig(configFile);
    const server = createApp({ modules, token, publicBaseUrl });
    server.listen(port, host, () => {
      console.log(`listening on http://${host}:${port}, modules: ${Object.keys(modules).join(', ')}`);
    });
    return server;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`foundry-release-proxy: refusing to start: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { createApp, loadConfig, parseConfig, ConfigError };
