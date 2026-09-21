// PDF text extraction without a dependency. The text of a simple PDF lives
// in content streams: BT ... ET blocks of Tj/TJ show-text operators, either
// plain or Flate-compressed. This reads enough of the format for reports,
// papers and letters -- scanned image PDFs have no text layer and are
// refused honestly rather than returning nothing.
//
// PDF FlateDecode is zlib-wrapped (2-byte header, 4-byte adler tail) around
// a raw deflate stream, so the browser/node raw inflate inside zip.js
// handles it once the wrapper bytes are stripped.
(function (root, factory) {
  // Real CommonJS only -- see office.js: in a bundle `module` exists but
  // `require` does not, so zip comes from the global zip.js publishes.
  var isCjs = typeof module === 'object' && module.exports && typeof require === 'function';
  var api = factory(isCjs ? require('./zip.js') : root && root.FreeZip);
  if (isCjs) module.exports = api;
  if (root) root.FreePdf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (zip) {
  'use strict';

  var MAX_STREAM = 8 * 1024 * 1024;   // one content stream
  var MAX_TEXT = 600 * 1024;          // extracted text cap

  function latin1(bytes) {
    var s = '';
    var CHUNK = 32768;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return s;
  }

  async function inflateZlib(bytes) {
    if (bytes.length < 6) throw new Error('pdf: compressed stream too short');
    if ((bytes[0] * 256 + bytes[1]) % 31 !== 0) throw new Error('pdf: bad zlib header');
    return zip.inflateRaw(bytes.subarray(2, bytes.length - 4));
  }

  // ---- PDF strings ---------------------------------------------------------
  // A literal string is ( ... ) with balanced parens and \\ escapes; a hex
  // string is < ... >. Returns the decoded text of one literal string body.
  function decodeLiteral(body) {
    return body.replace(/\\(\r\n|\r|\n)/g, '')
      .replace(/\\([nrtbf()\\])/g, function (_, c) {
        return c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === 'b' ? '\b' : c === 'f' ? '\f' : c;
      })
      .replace(/\\([0-7]{1,3})/g, function (_, oct) { return String.fromCharCode(parseInt(oct, 8)); });
  }

  function decodeHex(body) {
    var hex = body.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length % 2) hex += '0';
    var out = '';
    for (var i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  // Tokenize one BT..ET block into line pieces. Operators that move the pen
  // (Td/TD/T*) flush a line; show operators append text.
  function blockToLines(block) {
    var lines = [], cur = '';
    var i = 0, n = block.length;
    function flush() { if (cur.trim()) lines.push(cur.replace(/\s+/g, ' ').trim()); cur = ''; }
    while (i < n) {
      var ch = block[i];
      if (ch === '(') {
        var depth = 1, j = i + 1, esc = false, body = '';
        while (j < n && depth > 0) {
          var c = block[j];
          if (esc) { body += '\\' + c; esc = false; }
          else if (c === '\\') { esc = true; }
          else if (c === '(') { depth++; body += c; }
          else if (c === ')') { depth--; if (depth > 0) body += c; }
          else body += c;
          j++;
        }
        if (depth !== 0) break; // unbalanced; stop rather than invent text
        cur += decodeLiteral(body);
        i = j;
      } else if (ch === '<' && block[i + 1] !== '<') {
        var end = block.indexOf('>', i);
        if (end < 0) break;
        cur += decodeHex(block.slice(i + 1, end));
        i = end + 1;
      } else if (ch === '[' || (ch === '<' && block[i + 1] === '<')) {
        i++; // arrays/dicts: their strings are scanned as we advance
      } else if (ch === '>' && block[i + 1] === '>') {
        i += 2;
      } else if (ch === ']') {
        i++;
      } else if (/[A-Za-z'"*]/.test(ch)) {
        var op = /^([A-Za-z'"*]+)/.exec(block.slice(i, i + 4));
        var name = op ? op[1] : '';
        if (name === 'Td' || name === 'TD' || name === 'T*') flush();
        i += name ? name.length : 1;
        // consume inline operands after known operators handled on next loop
      } else if (/\s/.test(ch)) {
        i++;
      } else {
        i++; // numbers, delimiters
      }
    }
    flush();
    return lines;
  }

  function textFromContent(content) {
    if (content.length > MAX_STREAM) content = content.slice(0, MAX_STREAM);
    var out = [];
    var blocks = content.match(/BT[\s\S]*?ET/g) || [];
    for (var b = 0; b < blocks.length; b++) {
      var lines = blockToLines(blocks[b]);
      if (lines.length) out.push(lines.join('\n'));
      if (out.join('\n').length > MAX_TEXT) break;
    }
    return out.join('\n');
  }

  // Async because streams inflate through the same raw-inflate as the ZIP
  // engine (CompressionStream in the browser). A stream that fails to parse
  // is skipped, not fatal; only a document with no text at all is refused.
  async function extractPdfText(bytes) {
    var raw = latin1(bytes.subarray(0, Math.min(bytes.length, 1024)));
    if (raw.indexOf('%PDF-') < 0) throw new Error('pdf: not a PDF (missing %PDF- header)');

    var all = latin1(bytes);
    var text = [];
    var re = /stream\r?\n/g;
    var m;
    while ((m = re.exec(all)) !== null) {
      var start = m.index + m[0].length;
      var end = all.indexOf('endstream', start);
      if (end < 0) break;
      // The dictionary sits just before the stream keyword.
      var dictStart = Math.max(0, m.index - 400);
      var dict = all.slice(dictStart, m.index);
      var contentBytes = bytes.subarray(start, end);
      try {
        var content = /FlateDecode/.test(dict) ? latin1(await inflateZlib(contentBytes)) : latin1(contentBytes);
        var piece = textFromContent(content);
        if (piece) text.push(piece);
      } catch { /* a broken or non-text stream is skipped, not fatal */ }
      re.lastIndex = end;
      if (text.join('\n').length > MAX_TEXT) break;
    }
    var result = text.join('\n').trim();
    if (!result) {
      throw new Error('pdf: no text layer found — this looks like a scanned/image PDF');
    }
    return result;
  }

  return { extractPdfText: extractPdfText };
});
