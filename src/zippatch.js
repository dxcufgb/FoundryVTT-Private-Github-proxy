'use strict';
// Rewrites the module.json (or world.json) inside a module (or world) zip without unpacking or buffering the zip.
//
// A zip ends with its central directory (the table of contents: one record per file, with the offset of the file's
// data) and an end-of-central-directory record. Readers find files through the central directory, not by scanning.
// So the proxy can stream the original zip up to the start of its central directory unchanged, then append
//   - a new local entry with the patched module.json,
//   - a copy of the central directory whose module.json record points at that new entry, and
//   - a new end record.
// The old module.json stays in the file as unreferenced bytes. Only the zip's tail and its module.json are ever
// held in memory. Anything this file does not understand (ZIP64, encryption, multi-disk, odd methods) is refused
// with ZipPatchError, and the caller falls back to redirecting to the original zip.
//
// No dependencies: Buffer and node:zlib only.

const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const END_MIN = 22;
// The end record is at most 22 bytes plus a 65535-byte comment from the end of the file.
const TAIL_BYTES = END_MIN + 0xffff;
const MAX_CENTRAL_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

class ZipPatchError extends Error {}

let crcTable;
/** CRC-32 (zip's checksum); zlib.crc32 only exists from Node 20.15/22.2. */
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Finds the end record in the last bytes of a zip. tail = the file's last tail.length bytes; size = the file's size.
 * Returns { centralOffset, centralSize, count }.
 */
function readEnd(tail, size) {
  const tailStart = size - tail.length;
  for (let i = tail.length - END_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_END) continue;
    const commentLength = tail.readUInt16LE(i + 20);
    if (i + END_MIN + commentLength !== tail.length) continue; // a signature inside the comment
    const disk = tail.readUInt16LE(i + 4);
    const centralDisk = tail.readUInt16LE(i + 6);
    const countHere = tail.readUInt16LE(i + 8);
    const count = tail.readUInt16LE(i + 10);
    const centralSize = tail.readUInt32LE(i + 12);
    const centralOffset = tail.readUInt32LE(i + 16);
    if (disk !== 0 || centralDisk !== 0 || countHere !== count) throw new ZipPatchError('multi-disk zip');
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new ZipPatchError('ZIP64 zip');
    }
    if (i >= 20 && tail.readUInt32LE(i - 20) === SIG_ZIP64_LOCATOR) throw new ZipPatchError('ZIP64 zip');
    if (centralOffset + centralSize !== tailStart + i) throw new ZipPatchError('central directory is not where the end record says');
    if (centralSize > MAX_CENTRAL_BYTES) throw new ZipPatchError('central directory too large');
    return { centralOffset, centralSize, count };
  }
  throw new ZipPatchError('no end-of-central-directory record (not a zip?)');
}

/** The records of a central directory: { name, raw, flags, method, compressedSize, size, localOffset, time, date, versionNeeded, versionMadeBy }. */
function readCentral(central, count) {
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > central.length || central.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipPatchError('damaged central directory');
    const nameLength = central.readUInt16LE(p + 28);
    const extraLength = central.readUInt16LE(p + 30);
    const commentLength = central.readUInt16LE(p + 32);
    const end = p + 46 + nameLength + extraLength + commentLength;
    if (end > central.length) throw new ZipPatchError('damaged central directory');
    const flags = central.readUInt16LE(p + 8);
    entries.push({
      raw: central.subarray(p, end),
      versionMadeBy: central.readUInt16LE(p + 4),
      versionNeeded: central.readUInt16LE(p + 6),
      flags,
      method: central.readUInt16LE(p + 10),
      time: central.readUInt16LE(p + 12),
      date: central.readUInt16LE(p + 14),
      compressedSize: central.readUInt32LE(p + 20),
      size: central.readUInt32LE(p + 24),
      localOffset: central.readUInt32LE(p + 42),
      externalAttributes: central.readUInt32LE(p + 38),
      name: central.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength),
    });
    p = end;
  }
  if (p !== central.length) throw new ZipPatchError('central directory has trailing bytes');
  return entries;
}

/**
 * The manifest Foundry reads (module.json, or world.json for a world): the one at the top of the zip, or else the only
 * one directly inside a single top-level folder. null when there is none or it is ambiguous.
 */
function findManifest(entries, name = 'module.json') {
  const root = entries.filter((e) => e.name === name);
  if (root.length === 1) return root[0];
  if (root.length > 1) return null;
  const nested = entries.filter((e) => {
    const slash = e.name.indexOf('/');
    return slash > 0 && e.name.slice(slash + 1) === name;
  });
  return nested.length === 1 ? nested[0] : null;
}

/** Bytes to fetch for an entry's data: its local header can carry a longer extra field than the central record. */
function localSpan(entry) {
  if (entry.flags & FLAG_ENCRYPTED) throw new ZipPatchError('encrypted manifest');
  if (entry.method !== 0 && entry.method !== 8) throw new ZipPatchError(`manifest uses compression method ${entry.method}`);
  if (entry.compressedSize > MAX_MANIFEST_BYTES || entry.size > MAX_MANIFEST_BYTES) throw new ZipPatchError('manifest too large');
  return { start: entry.localOffset, length: 30 + 2 * 0xffff + entry.compressedSize };
}

/** The uncompressed content of an entry from bytes that start at its local header. */
function readLocal(entry, bytes) {
  if (bytes.length < 30 || bytes.readUInt32LE(0) !== SIG_LOCAL) throw new ZipPatchError('damaged local header');
  const dataStart = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ZipPatchError('manifest data cut short');
  let content;
  try {
    content = entry.method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data, { maxOutputLength: MAX_MANIFEST_BYTES });
  } catch (err) {
    throw new ZipPatchError(`manifest does not decompress (${err.message})`);
  }
  if (content.length !== entry.size || crc32(content) !== entry.raw.readUInt32LE(16)) {
    throw new ZipPatchError('manifest checksum mismatch');
  }
  return content;
}

/**
 * module.json text with "manifest" and "download" replaced; null when it already points at manifestUrl (nothing to
 * patch). Throws ZipPatchError when it is not a JSON object.
 */
function patchManifestText(content, manifestUrl, downloadUrl) {
  let data;
  try {
    data = JSON.parse(content.toString('utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new ZipPatchError(`manifest is not valid JSON (${err.message})`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ZipPatchError('manifest is not an object');
  if (data.manifest === manifestUrl && data.download === downloadUrl) return null;
  data.manifest = manifestUrl;
  data.download = downloadUrl;
  return Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Everything after the unchanged prefix (the original bytes up to centralOffset): the new module.json entry, the
 * central directory pointing at it, and the end record.
 */
function buildTail({ entries, target, content, centralOffset }) {
  const nameBytes = Buffer.from(target.name, target.flags & FLAG_UTF8 ? 'utf8' : 'latin1');
  const compressed = zlib.deflateRawSync(content);
  const crc = crc32(content);
  const flags = target.flags & FLAG_UTF8; // keeps only the UTF-8 name flag: no data descriptor, not encrypted
  const versionNeeded = Math.max(20, target.versionNeeded);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(SIG_LOCAL, 0);
  local.writeUInt16LE(versionNeeded, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(target.time, 10);
  local.writeUInt16LE(target.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  const newEntry = Buffer.concat([local, nameBytes, compressed]);

  const records = entries.map((e) => {
    if (e !== target) return e.raw;
    const r = Buffer.alloc(46);
    r.writeUInt32LE(SIG_CENTRAL, 0);
    r.writeUInt16LE(e.versionMadeBy, 4);
    r.writeUInt16LE(versionNeeded, 6);
    r.writeUInt16LE(flags, 8);
    r.writeUInt16LE(8, 10);
    r.writeUInt16LE(e.time, 12);
    r.writeUInt16LE(e.date, 14);
    r.writeUInt32LE(crc, 16);
    r.writeUInt32LE(compressed.length, 20);
    r.writeUInt32LE(content.length, 24);
    r.writeUInt16LE(nameBytes.length, 28);
    // extra field, comment, disk, internal attributes: 0
    r.writeUInt32LE(e.externalAttributes, 38);
    r.writeUInt32LE(centralOffset, 42);
    return Buffer.concat([r, nameBytes]);
  });
  const central = Buffer.concat(records);
  const newCentralOffset = centralOffset + newEntry.length;
  if (newCentralOffset + central.length > 0xffffffff) throw new ZipPatchError('zip too large');

  const end = Buffer.alloc(END_MIN);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(newCentralOffset, 16);
  return Buffer.concat([newEntry, central, end]);
}

module.exports = {
  ZipPatchError,
  TAIL_BYTES,
  crc32,
  readEnd,
  readCentral,
  findManifest,
  localSpan,
  readLocal,
  patchManifestText,
  buildTail,
};
