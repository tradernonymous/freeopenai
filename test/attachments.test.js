// Attaching a file used to be gated by its name, against a list of nine
// extensions -- and that same list filtered the file dialog, so `.py`, `.html`,
// `.css`, `.env`, `.toml`, `Makefile` and `Dockerfile` could not even be
// selected, while a `.txt` holding a zipped archive was accepted and pasted into
// the prompt as mojibake.
//
// Both halves are pinned here: what the bytes decide, and that the shipped
// handler acts on that decision rather than on the menu item that opened the
// picker -- a PDF from Files and a picture from Files used to be refused for
// arriving through the wrong door.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachmentKindFor,
  decodeAttachmentText,
  looksBinaryText,
  isDocumentFile,
} = require('../attachment-helpers.js');
const { HTML, loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const utf8 = (text) => new TextEncoder().encode(text);

test('a file is attached as what it is, not as what it is named', () => {
  // Every one of these is text the app can read, and every one used to be refused.
  for (const name of ['report.py', 'index.html', 'styles.css', '.env', 'Cargo.toml', 'Makefile', 'Dockerfile', 'notes']) {
    assert.equal(attachmentKindFor(name, ''), 'text', `${name} is text`);
  }
  // A picture is decided by its MIME type -- which is also what the send path
  // needs to build a data URL.
  assert.equal(attachmentKindFor('photo.png', 'image/png'), 'image');
  assert.equal(attachmentKindFor('no-extension', 'image/webp'), 'image');
  // A document by its extension, because the parser is what has to match.
  assert.equal(attachmentKindFor('report.pdf', 'application/pdf'), 'document');
  assert.equal(attachmentKindFor('RESUME.DOCX', ''), 'document');
  assert.equal(isDocumentFile('report.PDF'), true);
  // The archive that used to slip through as a .txt is still called text; the
  // bytes are what refuse it, below.
  assert.equal(attachmentKindFor('archive.txt', ''), 'text');
});

test('text is decided by the bytes, in both directions', () => {
  assert.equal(decodeAttachmentText(utf8('print("hi")\n')), 'print("hi")\n');
  // A BOM is the encoding's, not the file's.
  assert.equal(decodeAttachmentText(utf8('\uFEFFhello')), 'hello');
  // Notepad's "Unicode" save: a NUL in every other byte, and still a text file.
  assert.equal(decodeAttachmentText(Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), 'hi');
  // A zip and a PNG are not text, whatever they are called.
  assert.equal(decodeAttachmentText(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), null);
  assert.equal(decodeAttachmentText(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null);
  // An empty file is text with nothing in it, which is a different answer from
  // "not text".
  assert.equal(decodeAttachmentText(new Uint8Array()), '');
  // An ArrayBuffer works as well as a Uint8Array, since that is what the page
  // gets back from file.arrayBuffer().
  assert.equal(decodeAttachmentText(utf8('ok').buffer), 'ok');
});

test('a coloured log is a log, and a NUL is not', () => {
  assert.equal(looksBinaryText('\u001b[32m2026-09-15 INFO ok\u001b[0m\n'), false);
  assert.equal(looksBinaryText('\u001b[38;5;196mERROR\u001b[0m'), false);
  assert.equal(looksBinaryText('a\u0000b'), true);
  assert.equal(looksBinaryText('\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008'), true);
});

const NAMES = ['handleFileSelect', 'selectAttachKind'];

function fakeFile(name, type, bytes) {
  return {
    name,
    type,
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function harness() {
  const calls = { statuses: [], attached: [], parsed: [], picked: [], closed: 0 };
  const deps = {
    // The shipped decisions, not descriptions of them.
    attachmentKindFor,
    decodeAttachmentText,
    truncateExtractedText: (text) => text,
    extractPdfText: async () => { calls.parsed.push('pdf'); return 'pdf text'; },
    extractDocxText: async () => { calls.parsed.push('docx'); return 'docx text'; },
    showStatus: (kind, message) => calls.statuses.push([kind, message]),
    setPendingAttachment: (attachment) => calls.attached.push(attachment),
    closeAttachMenu: () => { calls.closed += 1; },
    fileInput: { accept: 'unset', click() { calls.picked.push(this.accept); } },
    URL: { createObjectURL: () => 'blob:stub' },
    console: { error() {} },
  };
  return { calls, deps, ...loadFromIndex(NAMES, deps) };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('a .py file attaches as text, which it could not do before', async () => {
  const h = harness();
  await h.handleFileSelect({ files: [fakeFile('report.py', '', utf8('print("hi")'))], value: '' });
  assert.deepEqual(h.calls.statuses, [['success', 'Attached report.py']]);
  assert.deepEqual(h.calls.attached, [{ kind: 'text', name: 'report.py', content: 'print("hi")' }]);
});

test('a PDF from Files becomes a document, not a refusal', async () => {
  const h = harness();
  await h.handleFileSelect({ files: [fakeFile('plan.pdf', 'application/pdf', utf8('%PDF-1.4'))], value: '' });
  assert.deepEqual(h.calls.parsed, ['pdf']);
  assert.deepEqual(h.calls.attached, [{ kind: 'text', name: 'plan.pdf', content: 'pdf text' }]);
});

test('a .docx from Files goes through the docx parser', async () => {
  const h = harness();
  await h.handleFileSelect({ files: [fakeFile('resume.docx', '', utf8('PK'))], value: '' });
  assert.deepEqual(h.calls.parsed, ['docx']);
  assert.deepEqual(h.calls.statuses.map((s) => s[0]), ['info', 'success']);
});

test('a picture from Files attaches as a picture', async () => {
  const h = harness();
  const file = fakeFile('diagram.png', 'image/png', utf8('png'));
  await h.handleFileSelect({ files: [file], value: '' });
  assert.equal(h.calls.attached.length, 1);
  assert.equal(h.calls.attached[0].kind, 'image');
  assert.equal(h.calls.attached[0].previewUrl, 'blob:stub');
});

test('a file that is not text is refused, and the refusal names the fix', async () => {
  const h = harness();
  const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01, 0x02]);
  await h.handleFileSelect({ files: [fakeFile('bundle.txt', '', zip)], value: '' });
  assert.deepEqual(h.calls.attached, []);
  assert.deepEqual(h.calls.statuses, [['error', 'That is not a text file — attach it as an Image or a Document']]);
});

test('the text cap says what to do instead of just refusing', async () => {
  const h = harness();
  const big = new Uint8Array(200 * 1024 + 1);
  await h.handleFileSelect({ files: [fakeFile('huge.log', '', big)], value: '' });
  assert.deepEqual(h.calls.attached, []);
  assert.deepEqual(h.calls.statuses, [['error', 'File too large (200KB max) — attach a document to send more']]);
});

test('an empty file is attached rather than refused', async () => {
  const h = harness();
  await h.handleFileSelect({ files: [fakeFile('empty.txt', '', new Uint8Array())], value: '' });
  assert.deepEqual(h.calls.attached, [{ kind: 'text', name: 'empty.txt', content: '' }]);
});

test('a cancelled picker attaches nothing', async () => {
  const h = harness();
  await h.handleFileSelect({ files: [], value: '' });
  assert.deepEqual(h.calls.statuses, []);
});

test('Files opens the dialog unfiltered, and the two that name a format do not', () => {
  const h = harness();
  h.selectAttachKind('file');
  h.selectAttachKind('document');
  h.selectAttachKind('image');
  // An empty accept means every file is selectable -- the nine-extension filter
  // was the other half of the bug.
  assert.deepEqual(h.calls.picked, ['', '.pdf,.docx', 'image/*']);
  assert.equal(h.calls.closed, 3);
});

test('the page no longer carries an extension list of its own', () => {
  assert.equal(/\.txt\s*,\s*\.md\s*,\s*\.csv/.test(HTML), false);
  assert.equal(HTML.includes('isAttachableFile'), false);
  assert.equal(HTML.includes('Only text-based files can be attached'), false);
});
