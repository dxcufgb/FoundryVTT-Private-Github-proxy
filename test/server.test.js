'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createApp, parseConfig, ConfigError } = require('../src/server.js');
const { makeZip, readZip } = require('./zipfixture.js');

const BASE = 'http://localhost:8787';
const API = 'https://api.github.com';
const TOKEN = 'test-token-secret';

function release(repo, tag, assetNames = ['module.json', 'module.zip']) {
  return {
    tag_name: tag,
    assets: assetNames.map((name, i) => ({ name, url: `${API}/repos/${repo}/releases/assets/${i + 1}-${tag}-${name}` })),
  };
}

// routes: { url: (init) => Response }. Records every call.
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

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
const redirect = (location) => new Response(null, { status: 302, headers: { location } });

async function start(modules, fetchImpl, { patchZips, log = () => {} } = {}) {
  const server = createApp({
    modules: parseConfig(JSON.stringify(modules)),
    token: TOKEN,
    publicBaseUrl: BASE,
    fetchImpl,
    log,
    patchZips,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

const one = { transformations: { repo: 'o/transformations' } };

test('latest manifest is fetched without auth from the pre-signed URL and rewritten', async () => {
  const rel = release('o/transformations', 'v1.2.0');
  const f = mockFetch({
    [`${API}/repos/o/transformations/releases/latest`]: () => json(rel),
    [rel.assets[0].url]: () => redirect('https://objects.example/signed-manifest'),
    'https://objects.example/signed-manifest': () =>
      json({ id: 'transformations', version: '1.2.0', manifest: 'old', download: 'old' }),
  });
  const s = await start(one, f);
  try {
    const res = await fetch(`${s.url}/transformations/module.json`, { headers: { Host: 'evil.example' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, '1.2.0');
    assert.equal(body.manifest, `${BASE}/transformations/module.json`);
    assert.equal(body.download, `${BASE}/transformations/v1.2.0/module.zip`);
    const [latest, asset, signed] = f.calls;
    assert.equal(latest.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(asset.init.headers.Accept, 'application/octet-stream');
    assert.equal(asset.init.redirect, 'manual');
    assert.equal(signed.init.headers?.Authorization, undefined);
  } finally {
    await s.close();
  }
});

test('tagged manifest uses the tag lookup and is rewritten the same way', async () => {
  const rel = release('o/transformations', 'v1.0.0');
  const f = mockFetch({
    [`${API}/repos/o/transformations/releases/tags/v1.0.0`]: () => json(rel),
    [rel.assets[0].url]: () => redirect('https://objects.example/m'),
    'https://objects.example/m': () => json({ version: '1.0.0' }),
  });
  const s = await start(one, f);
  try {
    const body = await (await fetch(`${s.url}/transformations/v1.0.0/module.json`)).json();
    assert.equal(body.manifest, `${BASE}/transformations/module.json`);
    assert.equal(body.download, `${BASE}/transformations/v1.0.0/module.zip`);
  } finally {
    await s.close();
  }
});

test('with PATCH_ZIPS off the zip is a 302 to the pre-signed URL and never downloaded', async () => {
  const rel = release('o/transformations', 'v1.2.0');
  const f = mockFetch({
    [`${API}/repos/o/transformations/releases/tags/v1.2.0`]: () => json(rel),
    [rel.assets[1].url]: () => redirect('https://objects.example/signed-zip'),
  });
  const s = await start(one, f, { patchZips: false });
  try {
    for (const method of ['GET', 'HEAD']) {
      const res = await fetch(`${s.url}/transformations/v1.2.0/module.zip`, { method, redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'https://objects.example/signed-zip');
    }
    assert.ok(f.calls.every((c) => !c.url.startsWith('https://objects.example')));
  } finally {
    await s.close();
  }
});

test('two modules are routed to their own repos', async () => {
  const a = release('o/alpha', 'v1.0.0');
  const b = release('o/beta', 'v2.0.0');
  const f = mockFetch({
    [`${API}/repos/o/alpha/releases/latest`]: () => json(a),
    [`${API}/repos/o/beta/releases/latest`]: () => json(b),
    [a.assets[0].url]: () => redirect('https://objects.example/a'),
    [b.assets[0].url]: () => redirect('https://objects.example/b'),
    'https://objects.example/a': () => json({ id: 'alpha' }),
    'https://objects.example/b': () => json({ id: 'beta' }),
  });
  const s = await start({ alpha: { repo: 'o/alpha' }, beta: { repo: 'o/beta' } }, f);
  try {
    const ra = await (await fetch(`${s.url}/alpha/module.json`)).json();
    const rb = await (await fetch(`${s.url}/beta/module.json`)).json();
    assert.equal(ra.id, 'alpha');
    assert.equal(ra.download, `${BASE}/alpha/v1.0.0/module.zip`);
    assert.equal(rb.id, 'beta');
    assert.equal(rb.download, `${BASE}/beta/v2.0.0/module.zip`);
  } finally {
    await s.close();
  }
});

test('asset name overrides are honoured', async () => {
  const rel = release('o/x', 'v1.0.0', ['manifest.json', 'x.zip']);
  const f = mockFetch({
    [`${API}/repos/o/x/releases/tags/v1.0.0`]: () => json(rel),
    [rel.assets[1].url]: () => redirect('https://objects.example/x'),
  });
  const s = await start({ x: { repo: 'o/x', manifestAsset: 'manifest.json', zipAsset: 'x.zip' } }, f);
  try {
    const res = await fetch(`${s.url}/x/v1.0.0/module.zip`, { redirect: 'manual' });
    assert.equal(res.status, 302);
  } finally {
    await s.close();
  }
});

test('unknown module id is 404 without calling GitHub', async () => {
  const f = mockFetch({});
  const s = await start(one, f);
  try {
    assert.equal((await fetch(`${s.url}/nope/module.json`)).status, 404);
    assert.equal((await fetch(`${s.url}/__proto__/module.json`)).status, 404);
    assert.equal(f.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('unknown paths are 404', async () => {
  const f = mockFetch({});
  const s = await start(one, f);
  try {
    for (const p of ['/', '/transformations', '/transformations/', '/transformations/other.json',
      '/transformations/module.zip', '/transformations/v1/module.txt', '/transformations/v1/x/module.zip']) {
      assert.equal((await fetch(`${s.url}${p}`)).status, 404, p);
    }
    assert.equal(f.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('missing asset is 404', async () => {
  const rel = release('o/transformations', 'v1.2.0', ['module.json']);
  const f = mockFetch({ [`${API}/repos/o/transformations/releases/tags/v1.2.0`]: () => json(rel) });
  const s = await start(one, f);
  try {
    assert.equal((await fetch(`${s.url}/transformations/v1.2.0/module.zip`, { redirect: 'manual' })).status, 404);
  } finally {
    await s.close();
  }
});

test('missing release is 404', async () => {
  const f = mockFetch({ [`${API}/repos/o/transformations/releases/tags/v9`]: () => json({}, 404) });
  const s = await start(one, f);
  try {
    assert.equal((await fetch(`${s.url}/transformations/v9/module.json`)).status, 404);
  } finally {
    await s.close();
  }
});

test('GitHub errors are 502 and the token is never exposed', async () => {
  const lines = [];
  const f = mockFetch({
    [`${API}/repos/o/transformations/releases/latest`]: () => json({ message: 'Bad credentials' }, 401),
  });
  const server = createApp({
    modules: parseConfig(JSON.stringify(one)), token: TOKEN, publicBaseUrl: BASE, fetchImpl: f, log: (l) => lines.push(l),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/transformations/module.json`);
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes(TOKEN));
    assert.ok(lines.some((l) => l.includes('transformations') && l.includes('401')));
    assert.ok(lines.every((l) => !l.includes(TOKEN)));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a failing asset redirect and a failing signed download are 502', async () => {
  const rel = release('o/transformations', 'v1.2.0');
  const f = mockFetch({
    [`${API}/repos/o/transformations/releases/latest`]: () => json(rel),
    [rel.assets[0].url]: () => redirect('https://objects.example/m'),
    'https://objects.example/m': () => new Response('denied', { status: 403 }),
    [`${API}/repos/o/transformations/releases/tags/v1.2.0`]: () => json(rel),
    [rel.assets[1].url]: () => new Response('boom', { status: 500 }),
  });
  const s = await start(one, f);
  try {
    assert.equal((await fetch(`${s.url}/transformations/module.json`)).status, 502);
    assert.equal((await fetch(`${s.url}/transformations/v1.2.0/module.zip`, { redirect: 'manual' })).status, 502);
  } finally {
    await s.close();
  }
});

test('malformed configs are rejected', () => {
  const bad = [
    'not json',
    '[]',
    '{}',
    '{"m": "o/r"}',
    '{"m": {}}',
    '{"m": {"repo": "no-slash"}}',
    '{"bad id": {"repo": "o/r"}}',
    '{"m": {"repo": "o/r", "zipAsset": 5}}',
    '{"m": {"repo": "o/r", "typo": "x"}}',
  ];
  for (const text of bad) assert.throws(() => parseConfig(text), ConfigError, text);
  const ok = parseConfig('{"m": {"repo": "o/r"}}');
  assert.deepEqual(ok.m, { repo: 'o/r', manifestAsset: 'module.json', zipAsset: 'module.zip' });
});

test('the process refuses to start with a malformed config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"m": {"repo": "nope"}}');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { PATH: process.env.PATH, GITHUB_TOKEN: 't', CONFIG_FILE: file },
    encoding: 'utf8',
    timeout: 10000,
  });
  fs.rmSync(dir, { recursive: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to start.*owner\/name/);
});

// A pre-signed zip download that answers Range requests (206), like GitHub's storage. range: false ignores them;
// cutAfter: stops the body after that many bytes.
function signedZip(buf, { range = true, cutAfter } = {}) {
  return (init) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec((init.headers && init.headers.Range) || '');
    if (!range || !m) return new Response(buf);
    const a = Number(m[1]);
    const b = Math.min(Number(m[2]), buf.length - 1);
    let body = buf.subarray(a, b + 1);
    if (cutAfter !== undefined) {
      const part = body.subarray(0, cutAfter);
      body = new ReadableStream({ start(c) { c.enqueue(part); c.error(new Error('connection reset')); } });
    }
    return new Response(body, { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${buf.length}` } });
  };
}

function zipRelease(buf) {
  const rel = release('o/transformations', 'v1.2.0');
  rel.assets[1].size = buf.length;
  return rel;
}

const releaseZip = () => makeZip([
  { name: 'scripts/main.js', data: 'console.log("x");\n'.repeat(500) },
  { name: 'module.json', data: JSON.stringify({ id: 'transformations', version: '1.2.0',
    manifest: 'https://github.com/o/transformations/releases/latest/download/module.json',
    download: 'https://github.com/o/transformations/releases/latest/download/module.zip' }) },
  { name: 'packs/items.db', data: Buffer.alloc(4000, 7), method: 0 },
]);

test('the zip is streamed with its module.json pointing at the proxy (Foundry updates through it)', async () => {
  const buf = releaseZip();
  const rel = zipRelease(buf);
  const lines = [];
  const f = mockFetch({
    [`${API}/repos/o/transformations/releases/tags/v1.2.0`]: () => json(rel),
    [rel.assets[1].url]: () => redirect('https://objects.example/signed-zip'),
    'https://objects.example/signed-zip': signedZip(buf),
  });
  const s = await start(one, f, { log: (l) => lines.push(l) });
  try {
    const res = await fetch(`${s.url}/transformations/v1.2.0/module.zip`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const out = Buffer.from(await res.arrayBuffer());
    assert.equal(Number(res.headers.get('content-length')), out.length);
    const files = readZip(out);
    const before = readZip(buf);
    assert.deepEqual(Object.keys(files).sort(), Object.keys(before).sort());
    assert.deepEqual(files['scripts/main.js'], before['scripts/main.js']);
    assert.deepEqual(files['packs/items.db'], before['packs/items.db']);
    const m = JSON.parse(files['module.json']);
    assert.equal(m.manifest, `${BASE}/transformations/module.json`);
    assert.equal(m.download, `${BASE}/transformations/v1.2.0/module.zip`);
    assert.equal(m.version, '1.2.0');
    // the pre-signed URL never sees the token; every request to it is a partial one
    const signed = f.calls.filter((c) => c.url.startsWith('https://objects.example'));
    assert.ok(signed.length >= 2);
    assert.ok(signed.every((c) => !c.init.headers.Authorization && /^bytes=\d+-\d+$/.test(c.init.headers.Range)));
    assert.ok(lines.some((l) => /served with its module.json pointing at the proxy/.test(l)));
    assert.ok(lines.every((l) => !l.includes(TOKEN)));

    // HEAD: the same headers, and one request fewer to the download (its body is not streamed)
    f.calls.length = 0;
    const head = await fetch(`${s.url}/transformations/v1.2.0/module.zip`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), out.length);
    assert.equal(f.calls.filter((c) => c.url.startsWith('https://objects.example')).length, signed.length - 1);
  } finally {
    await s.close();
  }
});

test('the zip falls back to the redirect when it cannot be patched', async () => {
  const buf = releaseZip();
  for (const [name, setup] of [
    ['no partial downloads', (rel) => ({ 'https://objects.example/signed-zip': signedZip(buf, { range: false }) })],
    ['no size in the release', (rel) => { delete rel.assets[1].size; return {}; }],
    ['not a zip', (rel) => ({ 'https://objects.example/signed-zip': signedZip(Buffer.alloc(buf.length, 1)) })],
  ]) {
    const rel = zipRelease(buf);
    const lines = [];
    const f = mockFetch({
      [`${API}/repos/o/transformations/releases/tags/v1.2.0`]: () => json(rel),
      [rel.assets[1].url]: () => redirect('https://objects.example/signed-zip'),
      ...setup(rel),
    });
    const s = await start(one, f, { log: (l) => lines.push(l) });
    try {
      const res = await fetch(`${s.url}/transformations/v1.2.0/module.zip`, { redirect: 'manual' });
      assert.equal(res.status, 302, name);
      assert.equal(res.headers.get('location'), 'https://objects.example/signed-zip', name);
      assert.ok(lines.some((l) => /redirected to GitHub \(not patched: /.test(l)), name);
    } finally {
      await s.close();
    }
  }
});

test('a zip download cut off midway fails visibly instead of delivering a damaged zip', async () => {
  const buf = releaseZip();
  const rel = zipRelease(buf);
  const lines = [];
  const plain = signedZip(buf);
  const cut = signedZip(buf, { cutAfter: 100 });
  const f = mockFetch({
    [`${API}/repos/o/transformations/releases/tags/v1.2.0`]: () => json(rel),
    [rel.assets[1].url]: () => redirect('https://objects.example/signed-zip'),
    // the planning reads work (the first one covers this small zip whole); the streamed prefix, which stops before
    // the end of the file, breaks after 100 bytes
    'https://objects.example/signed-zip': (init) => {
      const m = /^bytes=0-(\d+)$/.exec(init.headers.Range);
      return m && Number(m[1]) < buf.length - 1 ? cut(init) : plain(init);
    },
  });
  const s = await start(one, f, { log: (l) => lines.push(l) });
  try {
    // the connection is torn down: the client sees an error (before or after the headers), never a complete zip
    await assert.rejects(async () => {
      const res = await fetch(`${s.url}/transformations/v1.2.0/module.zip`, { redirect: 'manual' });
      await res.arrayBuffer();
    });
    assert.ok(lines.some((l) => /zip v1\.2\.0 failed after \d+ bytes \(connection reset\)/.test(l)), lines.join(' | '));
  } finally {
    await s.close();
  }
});

test('a broken partial read while planning falls back to the redirect', async () => {
  const buf = releaseZip();
  const rel = zipRelease(buf);
  const f = mockFetch({
    [`${API}/repos/o/transformations/releases/tags/v1.2.0`]: () => json(rel),
    [rel.assets[1].url]: () => redirect('https://objects.example/signed-zip'),
    'https://objects.example/signed-zip': signedZip(buf, { cutAfter: 10 }),
  });
  const s = await start(one, f);
  try {
    const res = await fetch(`${s.url}/transformations/v1.2.0/module.zip`, { redirect: 'manual' });
    assert.equal(res.status, 302);
  } finally {
    await s.close();
  }
});
