// ZIP read/write for the Office engine: enough of the format to unpack and
// pack DOCX/XLSX/PPTX containers (they are ZIPs of XML parts) with no
// dependency. Compression goes through node's zlib when available and the
// browser's CompressionStream('deflate-raw') otherwise, so the same module
// runs in node:test and in the WebView.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FreeZip = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var zlib = null;
  try {
    if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
      zlib = process.getBuiltinModule('zlib');
    } else if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof require === 'function') {
      zlib = require('zlib');
    }
  } catch { zlib = null; }

  // ---- crc32 ------------------------------------------------------------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- inflate / deflate --------------------------------------------------
  function browserInflate(bytes) {
    var ds = new globalThis.DecompressionStream('deflate-raw');
    return new Blob([bytes]).stream().pipeThrough(ds);
  }

  function browserDeflate(bytes) {
    var cs = new globalThis.CompressionStream('deflate-raw');
    return new Blob([bytes]).stream().pipeThrough(cs);
  }

  async function streamToBytes(stream) {
    var buf = new Uint8Array(await new globalThis.Response(stream).arrayBuffer());
    return buf;
  }

  async function inflateRaw(bytes) {
    if (zlib) return new Uint8Array(zlib.inflateRawSync(bytes));
    return streamToBytes(browserInflate(bytes));
  }

  async function deflateRaw(bytes) {
    if (zlib) return new Uint8Array(zlib.deflateRawSync(bytes, { level: 6 }));
    return streamToBytes(browserDeflate(bytes));
  }

  async function inflate(bytes, method) {
    if (method === 0) return bytes; // stored
    if (method === 8) return inflateRaw(bytes);
    throw new Error('zip: unsupported compression method ' + method);
  }

  // ---- reading ------------------------------------------------------------
  // Minimal central-directory reader. Returns entries with name + raw bytes;
  // data is decompressed lazily by readEntry().
  function findEOCD(bytes) {
    // The EOCD is at least 22 bytes; scan back past any zip comment.
    var min = Math.max(0, bytes.length - 22 - 65535);
    for (var i = bytes.length - 22; i >= min; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
    }
    return -1;
  }

  function readCentralDirectory(bytes) {
    var eocd = findEOCD(bytes);
    if (eocd < 0) throw new Error('zip: not a zip file (no end-of-central-directory)');
    var count = bytes[eocd + 10] | (bytes[eocd + 11] << 8);
    var offset = bytes[eocd + 16] | (bytes[eocd + 17] << 8) | (bytes[eocd + 18] << 16) | (bytes[eocd + 19] << 24);
    var entries = [];
    var td = new TextDecoder();
    for (var n = 0; n < count; n++) {
      if (!(bytes[offset] === 0x50 && bytes[offset + 1] === 0x4B && bytes[offset + 2] === 0x01 && bytes[offset + 3] === 0x02)) {
        throw new Error('zip: corrupt central directory at entry ' + n);
      }
      var method = bytes[offset + 10] | (bytes[offset + 11] << 8);
      var compSize = (bytes[offset + 20] | (bytes[offset + 21] << 8) | (bytes[offset + 22] << 16) | (bytes[offset + 23] << 24)) >>> 0;
      var nameLen = bytes[offset + 28] | (bytes[offset + 29] << 8);
      var extraLen = bytes[offset + 30] | (bytes[offset + 31] << 8);
      var commentLen = bytes[offset + 32] | (bytes[offset + 33] << 8);
      var localOff = (bytes[offset + 42] | (bytes[offset + 43] << 8) | (bytes[offset + 44] << 16) | (bytes[offset + 45] << 24)) >>> 0;
      var name = td.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
      entries.push({ name: name, method: method, compSize: compSize, localOff: localOff });
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function entryBytes(bytes, entry) {
    var off = entry.localOff;
    if (!(bytes[off] === 0x50 && bytes[off + 1] === 0x4B && bytes[off + 2] === 0x03 && bytes[off + 3] === 0x04)) {
      throw new Error('zip: corrupt local header for ' + entry.name);
    }
    var nameLen = bytes[off + 26] | (bytes[off + 27] << 8);
    var extraLen = bytes[off + 28] | (bytes[off + 29] << 8);
    var start = off + 30 + nameLen + extraLen;
    var raw = bytes.subarray(start, start + entry.compSize);
    return inflate(raw, entry.method);
  }

  // readEntries(bytes) -> [{ name, dir, data: Uint8Array | null }]
  // data is null for directory entries.
  async function readEntries(bytes) {
    var dir = readCentralDirectory(bytes);
    var out = [];
    for (var i = 0; i < dir.length; i++) {
      var e = dir[i];
      var isDir = e.name.slice(-1) === '/';
      out.push({
        name: e.name,
        dir: isDir,
        data: isDir ? null : await entryBytes(bytes, e)
      });
    }
    return out;
  }

  // Async on purpose: parse errors become rejections the office readers can
  // await, never synchronous throws that escape the caller's try/catch.
  async function findEntry(bytes, name) {
    var dir = readCentralDirectory(bytes);
    for (var i = 0; i < dir.length; i++) {
      if (dir[i].name === name) return entryBytes(bytes, dir[i]);
    }
    return null;
  }

  // ---- writing ------------------------------------------------------------
  function u16(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF); }
  function u32(arr, v) { arr.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }

  function dosDateTime() {
    var d = new Date();
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
    var date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time, date: date };
  }

  // writeZip([{ name, data }]) -> Promise<Uint8Array>
  // Deflate stores, UTF-8 names, no encryption, no zip64 (fine for documents).
  async function writeZip(entries) {
    var te = new TextEncoder();
    var local = [];
    var central = [];
    var offset = 0;
    var stamp = dosDateTime();

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var nameBytes = te.encode(e.name);
      var raw = typeof e.data === 'string' ? te.encode(e.data) : e.data;
      var comp = await deflateRaw(raw);
      var crc = crc32(raw);

      var lh = [];
      u32(lh, 0x04034B50); u16(lh, 20); u16(lh, 0x0800); u16(lh, 8);
      u16(lh, stamp.time); u16(lh, stamp.date);
      u32(lh, crc); u32(lh, comp.length); u32(lh, raw.length);
      u16(lh, nameBytes.length); u16(lh, 0);
      var localStart = offset;
      var localBytes = new Uint8Array(lh);
      local.push(localBytes, nameBytes, comp);
      offset += localBytes.length + nameBytes.length + comp.length;

      var ch = [];
      u32(ch, 0x02014B50); u16(ch, 20); u16(ch, 20); u16(ch, 0x0800); u16(ch, 8);
      u16(ch, stamp.time); u16(ch, stamp.date);
      u32(ch, crc); u32(ch, comp.length); u32(ch, raw.length);
      u16(ch, nameBytes.length); u16(ch, 0); u16(ch, 0); u16(ch, 0); u16(ch, 0);
      u32(ch, 0); u32(ch, localStart);
      var centralBytes = new Uint8Array(ch);
      central.push(centralBytes, nameBytes);
    }

    var centralStart = offset;
    var centralSize = 0;
    for (var c = 0; c < central.length; c++) centralSize += central[c].length;

    var end = [];
    u32(end, 0x06054B50); u16(end, 0); u16(end, 0);
    u16(end, entries.length); u16(end, entries.length);
    u32(end, centralSize); u32(end, centralStart); u16(end, 0);

    var eocd = new Uint8Array(end);
    var total = offset + centralSize + eocd.length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var l = 0; l < local.length; l++) { out.set(local[l], pos); pos += local[l].length; }
    for (var k = 0; k < central.length; k++) { out.set(central[k], pos); pos += central[k].length; }
    out.set(eocd, pos);
    return out;
  }

  return { crc32: crc32, inflateRaw: inflateRaw, deflateRaw: deflateRaw, readEntries: readEntries, findEntry: findEntry, writeZip: writeZip };
});
