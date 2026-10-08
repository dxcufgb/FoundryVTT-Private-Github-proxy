'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  createUpdater,
  compareVersions,
  parseSha256Sums,
  parseTokenFile,
  selectAssets,
  main,
  UpdateError,
  EXIT_CURRENT,
  EXIT_UPDATE,
  EXIT_ERROR,
} = require('../src/updater.js');

const API = 'https://api.github.com';
const REPO = 'dxcufgb/FoundryVTT-Realese-proxy';
const LATEST = `${API}/repos/${REPO}/releases/latest`;
const TOKEN = 'updater-token-secret';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
const redirect = (location) => new Response(null, { status: 302, headers: { location } });
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler(init);
  };
  fn.calls = calls;
  return fn;
}

function release(tag, extra = {}) {
  const v = tag.replace(/^v/, '');
  const names = [`foundry-release-proxy-${v}.tar.gz`, `foundry-release-proxy-${v}.zip`, 'SHA256SUMS'];
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: names.map((name, i) => ({ name, url: `${API}/repos/${REPO}/releases/assets/${100 + i}` })),
    ...extra,
  };
}

// A full release: lookup, SHA256SUMS and archive behind pre-signed redirects.
function releaseRoutes(tag, archive, { sumsFor = archive } = {}) {
  const rel = release(tag);
  const v = tag.replace(/^v/, '');
  const sums = `${sha(sumsFor)}  foundry-release-proxy-${v}.tar.gz\n${'0'.repeat(64)}  foundry-release-proxy-${v}.zip\n`;
  const routes = {
    [LATEST]: () => json(rel),
    [rel.assets[0].url]: () => redirect('https://objects.example/signed-archive'),
    [rel.assets[2].url]: () => redirect('https://objects.example/signed-sums'),
    'https://objects.example/signed-archive': () => new Response(archive),
    'https://objects.example/signed-sums': () => new Response(sums),
  };
  return { rel, routes };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'updater-test-'));
}

test('semantic version comparison', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.0', '1.0.0'), UpdateError);
  assert.throws(() => compareVersions('latest', '1.0.0'), UpdateError);
});

test('SHA256SUMS parsing', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const sums = parseSha256Sums(`${a}  one.tar.gz\r\n${b} *two.zip\n\n`);
  assert.equal(sums['one.tar.gz'], a);
  assert.equal(sums['two.zip'], 'b'.repeat(64));
  assert.equal(Object.getPrototypeOf(sums), null);
  assert.throws(() => parseSha256Sums('nothex  file'), UpdateError);
  assert.throws(() => parseSha256Sums(`${a}file`), UpdateError);
});

test('token file parsing', () => {
  assert.equal(parseTokenFile('GITHUB_TOKEN=github_pat_abc\nPORT=8787\n'), 'github_pat_abc');
  assert.equal(parseTokenFile('# comment\nPORT=1\nGITHUB_TOKEN="ghp_quoted"\n'), 'ghp_quoted');
  assert.equal(parseTokenFile('  github_pat_bare  \n'), 'github_pat_bare');
  assert.equal(parseTokenFile('GITHUB_TOKEN=REPLACE_ME\n'), '');
  assert.equal(parseTokenFile('PORT=8787\n'), '');
  assert.equal(parseTokenFile(''), '');
});

test('asset selection picks the archive of the requested format and SHA256SUMS', () => {
  const rel = release('v1.2.0');
  assert.equal(selectAssets(rel, 'tar.gz').archive.name, 'foundry-release-proxy-1.2.0.tar.gz');
  assert.equal(selectAssets(rel, 'zip').archive.name, 'foundry-release-proxy-1.2.0.zip');
  assert.equal(selectAssets(rel, 'zip').sums.name, 'SHA256SUMS');
  assert.throws(() => selectAssets({ ...rel, assets: rel.assets.slice(1) }, 'tar.gz'), /no asset/);
  assert.throws(() => selectAssets({ ...rel, assets: rel.assets.slice(0, 2) }, 'tar.gz'), /SHA256SUMS/);
  assert.throws(() => selectAssets(rel, 'exe'), /unknown archive format/);
});

test('check: only a strictly newer, non-prerelease release is an update', async () => {
  const cases = [
    [release('v1.1.0'), '1.0.0', true],
    [release('v1.0.0'), '1.0.0', false],
    [release('v0.9.0'), '1.0.0', false],
    [release('v1.1.0', { prerelease: true }), '1.0.0', false],
    [release('v1.1.0', { draft: true }), '1.0.0', false],
    [release('v1.1.0-rc.1'), '1.0.0', false],
  ];
  for (const [rel, installed, newer] of cases) {
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch({ [LATEST]: () => json(rel) }), log: () => {} });
    const r = await u.check(installed);
    assert.equal(r.newer, newer, `${rel.tag_name} vs ${installed}`);
  }
});

test('check: the release lookup carries the token, and errors are reported without it', async () => {
  const f = mockFetch({ [LATEST]: () => json(release('v1.0.0')) });
  await createUpdater({ token: TOKEN, fetchImpl: f, log: () => {} }).check('1.0.0');
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(f.calls[0].init.signal, 'request has a timeout signal');

  for (const [status, re] of [
    [404, /HTTP 404/],
    [401, /HTTP 401/],
  ]) {
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch({ [LATEST]: () => json({}, status) }) });
    await assert.rejects(u.check('1.0.0'), (err) => re.test(err.message) && !err.message.includes(TOKEN));
  }
  const bad = createUpdater({ token: TOKEN, fetchImpl: mockFetch({ [LATEST]: () => new Response('not json') }) });
  await assert.rejects(bad.check('1.0.0'), /invalid JSON/);
  assert.throws(() => createUpdater({ token: '' }), /no GitHub token/);
});

test('download: redirect is followed without the token and the checksum is verified', async () => {
  const archive = Buffer.from('fake archive contents');
  const { rel, routes } = releaseRoutes('v1.1.0', archive);
  const f = mockFetch(routes);
  const dir = tmpdir();
  const file = await createUpdater({ token: TOKEN, fetchImpl: f, log: () => {} }).download(rel, 'tar.gz', dir);
  assert.equal(path.basename(file), 'foundry-release-proxy-1.1.0.tar.gz');
  assert.deepEqual(fs.readFileSync(file), archive);

  for (const call of f.calls) {
    const auth = call.init.headers?.Authorization;
    if (call.url.startsWith(`${API}/`)) assert.equal(auth, `Bearer ${TOKEN}`);
    else assert.equal(auth, undefined, `no token sent to ${call.url}`);
    assert.ok(call.init.signal, `timeout on ${call.url}`);
  }
  const assetCall = f.calls.find((c) => c.url === rel.assets[0].url);
  assert.equal(assetCall.init.headers.Accept, 'application/octet-stream');
  assert.equal(assetCall.init.redirect, 'manual');
  fs.rmSync(dir, { recursive: true });
});

test('download: a checksum mismatch is refused and nothing is written', async () => {
  const { rel, routes } = releaseRoutes('v1.1.0', Buffer.from('tampered'), { sumsFor: Buffer.from('original') });
  const dir = tmpdir();
  const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch(routes), log: () => {} });
  await assert.rejects(u.download(rel, 'tar.gz', dir), /checksum mismatch/);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true });
});

test('download: missing SHA256SUMS entry, non-HTTPS redirect, oversized body and foreign asset URLs are refused', async () => {
  const dir = tmpdir();
  const archive = Buffer.from('x');

  // zip has a zero hash in SHA256SUMS -> mismatch; drop its line entirely -> no entry.
  {
    const { rel, routes } = releaseRoutes('v1.1.0', archive);
    routes['https://objects.example/signed-sums'] = () => new Response(`${sha(archive)}  other.tar.gz\n`);
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch(routes), log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /no entry/);
  }
  {
    const { rel, routes } = releaseRoutes('v1.1.0', archive);
    routes[rel.assets[0].url] = () => redirect('http://objects.example/plain-http');
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch(routes), log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /non-HTTPS/);
  }
  {
    const { rel, routes } = releaseRoutes('v1.1.0', archive);
    routes['https://objects.example/signed-archive'] = () =>
      new Response('x', { headers: { 'content-length': String(100 * 1024 * 1024) } });
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch(routes), log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /too large/);
  }
  {
    const { rel, routes } = releaseRoutes('v1.1.0', archive);
    const big = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    routes['https://objects.example/signed-archive'] = () => new Response(big);
    const u = createUpdater({ token: TOKEN, fetchImpl: mockFetch(routes), log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /too large/);
  }
  {
    const rel = release('v1.1.0');
    rel.assets[2].url = 'https://evil.example/steal';
    const f = mockFetch({});
    const u = createUpdater({ token: TOKEN, fetchImpl: f, log: () => {} });
    await assert.rejects(u.download(rel, 'tar.gz', dir), /unexpected asset URL/);
    assert.equal(f.calls.length, 0);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true });
});

function fakeInstall(version) {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(dir, 'token'), `GITHUB_TOKEN=${TOKEN}\nPORT=8787\n`);
  return dir;
}

test('cli: --check reports and exits 0 when current, 10 when newer; never prints the token', async () => {
  const dir = fakeInstall('1.0.0');
  const out = [];
  const log = (l) => out.push(l);
  const args = ['--check', '--app-dir', dir, '--token-file', path.join(dir, 'token')];

  let f = mockFetch({ [LATEST]: () => json(release('v1.0.0')) });
  assert.equal(await main(args, { env: {}, fetchImpl: f, log }), EXIT_CURRENT);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);

  f = mockFetch({ [LATEST]: () => json(release('v1.0.1')) });
  assert.equal(await main(args, { env: {}, fetchImpl: f, log }), EXIT_UPDATE);
  assert.equal(f.calls.length, 1, '--check does not download');
  assert.match(out.join('\n'), /update available: 1\.0\.0 -> 1\.0\.1/);
  assert.ok(!out.join('\n').includes(TOKEN));
  fs.rmSync(dir, { recursive: true });
});

test('cli: --download writes the verified archive and prints its path', async () => {
  const dir = fakeInstall('1.0.0');
  const outDir = tmpdir();
  const archive = Buffer.from('release archive');
  const { routes } = releaseRoutes('v1.1.0', archive);
  const out = [];
  const code = await main(['--download', outDir, '--app-dir', dir, '--format', 'tar.gz'], {
    env: { UPDATER_GITHUB_TOKEN: TOKEN },
    fetchImpl: mockFetch(routes),
    log: (l) => out.push(l),
  });
  assert.equal(code, EXIT_UPDATE);
  const file = path.join(outDir, 'foundry-release-proxy-1.1.0.tar.gz');
  assert.ok(out.includes(`ARCHIVE=${file}`));
  assert.ok(out.includes('VERSION=1.1.0'));
  assert.deepEqual(fs.readFileSync(file), archive);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(outDir, { recursive: true });
});

test('cli: errors exit 1 with a message that never contains the token', async () => {
  const dir = fakeInstall('1.0.0');
  const errors = [];
  const orig = console.error;
  console.error = (l) => errors.push(l);
  try {
    const f = mockFetch({ [LATEST]: () => json({ message: 'Bad credentials' }, 401) });
    const args = ['--check', '--app-dir', dir, '--token-file', path.join(dir, 'token')];
    assert.equal(await main(args, { env: {}, fetchImpl: f, log: () => {} }), EXIT_ERROR);
    assert.equal(await main(['--bogus'], { env: {}, fetchImpl: f, log: () => {} }), EXIT_ERROR);
    const missing = ['--check', '--app-dir', dir, '--token-file', path.join(dir, 'nope')];
    assert.equal(await main(missing, { env: {}, fetchImpl: f, log: () => {} }), EXIT_ERROR);
    const noToken = ['--check', '--app-dir', dir];
    assert.equal(await main(noToken, { env: {}, fetchImpl: f, log: () => {} }), EXIT_ERROR);
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 4);
  assert.match(errors[0], /HTTP 401/);
  assert.match(errors[3], /no GitHub token/);
  assert.ok(errors.every((e) => !e.includes(TOKEN)));
  fs.rmSync(dir, { recursive: true });
});
