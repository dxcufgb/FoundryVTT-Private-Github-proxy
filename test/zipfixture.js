'use strict';
// Builds and reads small zips for the tests, independently of src/zippatch.js (only node:zlib).

const zlib = require('node:zlib');

function crc(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * files: [{ name, data, method: 0|8 (default 8), descriptor: write sizes after the data (as streaming writers do) }].
 * comment: archive comment; zip64Locator: put a ZIP64 end locator before the end record.
 */
function makeZip(files, { comment = '', zip64Locator = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.data);
    const method = f.method === undefined ? 8 : f.method;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(f.name, 'utf8');
    const sum = crc(data);
    const flags = 0x0800 | (f.descriptor ? 0x0008 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x6000, 10);
    local.writeUInt16LE(0x5a21, 12);
    if (!f.descriptor) {
      local.writeUInt32LE(sum, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const extra = Buffer.from('UT\x05\x00\x01abcd', 'latin1'); // an extended-timestamp extra field
    local.writeUInt16LE(extra.length, 28);
    parts.push(local, name, extra, body);
    let size = local.length + name.length + extra.length + body.length;
    if (f.descriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(sum, 4);
      d.writeUInt32LE(body.length, 8);
      d.writeUInt32LE(data.length, 12);
      parts.push(d);
      size += d.length;
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x031e, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(0x6000, 12);
    c.writeUInt16LE(0x5a21, 14);
    c.writeUInt32LE(sum, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += size;
  }
  const cd = Buffer.concat(central);
  const tail = [];
  if (zip64Locator) {
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    tail.push(loc);
  }
  const commentBytes = Buffer.from(comment, 'latin1');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...parts, cd, ...tail, end, commentBytes]);
}

/** Every file in a zip, found through its central directory: { name: Buffer of content }. Verifies the CRCs. */
function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('no end record');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central record');
    const method = buf.readUInt16LE(p + 10);
    const sum = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (crc(data) !== sum) throw new Error(`CRC mismatch for ${name}`);
    out[name] = data;
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

module.exports = { makeZip, readZip, crc };
