'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zip = require('../src/zippatch.js');
const { makeZip, readZip } = require('./zipfixture.js');

const MANIFEST = 'http://localhost:8787/transformations/module.json';
const DOWNLOAD = 'http://localhost:8787/transformations/v1.0.0/module.zip';
const moduleJson = (extra = {}) => JSON.stringify({ id: 'transformations', version: '1.0.0',
  manifest: 'https://github.com/o/t/releases/latest/download/module.json', ...extra });

// The whole patch in memory, as the proxy does it over partial downloads.
function patch(buf) {
  const { centralOffset, centralSize, count } = zip.readEnd(buf.subarray(Math.max(0, buf.length - zip.TAIL_BYTES)), buf.length);
  const entries = zip.readCentral(buf.subarray(centralOffset, centralOffset + centralSize), count);
  const target = zip.findManifest(entries);
  if (!target) throw new zip.ZipPatchError('no module.json');
  const span = zip.localSpan(target);
  const content = zip.patchManifestText(zip.readLocal(target, buf.subarray(span.start, Math.min(span.start + span.length, centralOffset))),
    MANIFEST, DOWNLOAD);
  if (!content) return null;
  return Buffer.concat([buf.subarray(0, centralOffset), zip.buildTail({ entries, target, content, centralOffset })]);
}

test('crc32 matches the standard check value', () => {
  assert.equal(zip.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(zip.crc32(Buffer.alloc(0)), 0);
});

test('module.json is replaced, every other file is kept byte for byte', () => {
  const files = [
    { name: 'scripts/main.js', data: 'console.log(1);\n'.repeat(100) },
    { name: 'module.json', data: moduleJson({ title: 'Tränsformations' }) },
    { name: 'packs/a.db', data: Buffer.from([0, 1, 2, 3, 255]), method: 0 },
    { name: 'lang/ü.json', data: '{"x":1}', descriptor: true },
  ];
  const out = readZip(patch(makeZip(files)));
  assert.deepEqual(Object.keys(out).sort(), files.map((f) => f.name).sort());
  for (const f of files) if (f.name !== 'module.json') assert.deepEqual(out[f.name], Buffer.from(f.data));
  const m = JSON.parse(out['module.json']);
  assert.equal(m.manifest, MANIFEST);
  assert.equal(m.download, DOWNLOAD);
  assert.equal(m.title, 'Tränsformations');
  assert.equal(m.id, 'transformations');
});

test('stored, streamed (data descriptor), BOM and folder variants of module.json are all patched', () => {
  for (const variant of [
    [{ name: 'module.json', data: moduleJson(), method: 0 }],
    [{ name: 'module.json', data: moduleJson(), descriptor: true }],
    [{ name: 'module.json', data: `﻿${moduleJson()}` }],
    [{ name: 't/scripts/x.js', data: 'x' }, { name: 't/module.json', data: moduleJson() }],
  ]) {
    const out = readZip(patch(makeZip(variant)));
    const name = variant.find((f) => f.name.endsWith('module.json')).name;
    assert.equal(JSON.parse(out[name]).manifest, MANIFEST);
  }
});

test('an archive comment, even one holding an end-record signature, is handled', () => {
  const buf = makeZip([{ name: 'module.json', data: moduleJson() }], { comment: 'build PK\x05\x06 42' });
  assert.equal(JSON.parse(readZip(patch(buf))['module.json']).manifest, MANIFEST);
});

test('zips the proxy cannot patch safely are refused', () => {
  const refuse = (buf, re) => assert.throws(() => patch(buf), (e) => e instanceof zip.ZipPatchError && re.test(e.message));
  refuse(Buffer.from('not a zip at all, just text'), /no end-of-central-directory/);
  refuse(makeZip([{ name: 'module.json', data: moduleJson() }], { zip64Locator: true }), /ZIP64/);
  refuse(makeZip([{ name: 'README.md', data: 'x' }]), /no module.json/);
  refuse(makeZip([{ name: 'a/module.json', data: moduleJson() }, { name: 'b/module.json', data: moduleJson() }]), /no module.json/);
  refuse(makeZip([{ name: 'a/b/module.json', data: moduleJson() }]), /no module.json/);
  refuse(makeZip([{ name: 'module.json', data: '{ not json' }]), /not valid JSON/);
  refuse(makeZip([{ name: 'module.json', data: '[1,2]' }]), /not an object/);
  // a damaged module.json (wrong checksum)
  const bad = makeZip([{ name: 'module.json', data: moduleJson(), method: 0 }]);
  bad[bad.indexOf('"id"')] = 0x27;
  refuse(bad, /checksum/);
});

test('a module.json already pointing at the proxy is left alone', () => {
  const buf = makeZip([{ name: 'module.json', data: moduleJson({ manifest: MANIFEST, download: DOWNLOAD }) }]);
  assert.equal(patch(buf), null);
});

test('the root module.json wins over one in a folder', () => {
  const entries = zip.readCentral(...(() => {
    const buf = makeZip([{ name: 'x/module.json', data: '{}' }, { name: 'module.json', data: '{}' }]);
    const end = zip.readEnd(buf, buf.length);
    return [buf.subarray(end.centralOffset, end.centralOffset + end.centralSize), end.count];
  })());
  assert.equal(zip.findManifest(entries).name, 'module.json');
});

test('findManifest finds world.json for a world zip, at the top or in a single folder', () => {
  const at = (names) => names.map((name) => ({ name }));
  assert.equal(zip.findManifest(at(['world.json', 'data/a.db']), 'world.json').name, 'world.json');
  assert.equal(zip.findManifest(at(['w/world.json', 'w/data/a.db']), 'world.json').name, 'w/world.json');
  assert.equal(zip.findManifest(at(['module.json']), 'world.json'), null);
  assert.equal(zip.findManifest(at(['a/world.json', 'b/world.json']), 'world.json'), null);
  assert.equal(zip.findManifest(at(['a/b/world.json']), 'world.json'), null);
  assert.equal(zip.findManifest(at(['module.json'])).name, 'module.json');
});
