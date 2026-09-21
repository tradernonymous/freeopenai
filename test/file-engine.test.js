// The file engine: ZIP containers, Office text in and out, PDF text out.
// Fixtures are built with the writers themselves (a writer and reader that
// disagree with each other fails here, not on a user's document) plus a
// handcrafted uncompressed PDF with known operator output.
const test = require('node:test');
const assert = require('node:assert/strict');

const zip = require('../desktop/src/files/zip.js');
const office = require('../desktop/src/files/office.js');
const pdf = require('../desktop/src/files/pdf.js');

const te = new TextEncoder();

test('zip: crc32 matches the standard check vector', () => {
  assert.equal(zip.crc32(te.encode('123456789')), 0xCBF43926);
});

test('zip: a written archive reads back byte-for-byte', async () => {
  const bytes = await zip.writeZip([
    { name: 'hello.txt', data: te.encode('Hello, world!') },
    { name: 'uni/naïve—✓.txt', data: te.encode('unicode names survive') },
    { name: 'empty.txt', data: new Uint8Array(0) },
    { name: 'big.bin', data: new Uint8Array(70000).fill(7) },
  ]);
  const entries = await zip.readEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  assert.equal(entries.length, 4);
  assert.equal(new TextDecoder().decode(byName.get('hello.txt').data), 'Hello, world!');
  assert.equal(new TextDecoder().decode(byName.get('uni/naïve—✓.txt').data), 'unicode names survive');
  assert.equal(byName.get('empty.txt').data.length, 0);
  assert.equal(byName.get('big.bin').data.length, 70000);
  assert.ok(byName.get('big.bin').data.every((b) => b === 7));
});

test('docx: paragraphs round-trip, escaping survives', async () => {
  const paras = ['First paragraph', 'Tabbed:\tvalue', '<b>& "quotes" \u00e9\u2713</b>', ''];
  const docx = await office.writeDocx('Test', paras);
  const text = await office.extractDocxText(docx);
  assert.equal(text, paras.join('\n').trim());
});

test('xlsx: cells round-trip with numbers and strings', async () => {
  const rows = [
    ['Item', 'Qty', 'Price'],
    ['Widget', 12, '9.99'],
    ['Gadget \u00e9', '3', 'non-numeric string'],
  ];
  const xlsx = await office.writeXlsx('Test', [{ name: 'Sheet1', rows }]);
  const back = await office.extractXlsxSheets(xlsx);
  assert.deepEqual(back, rows);
  assert.match(office.sheetToText(back), /^Item\tQty\tPrice\nWidget\t12\t9\.99/m);
});

test('pptx: slides round-trip in order', async () => {
  const slides = ['Title slide\nSubtitle', 'Second slide with \u00e9\u2713 chars'];
  const pptx = await office.writePptx('Test', slides);
  const text = await office.extractPptxText(pptx);
  assert.equal(text, slides.join('\n\n'));
});

test('office: readers refuse non-office bytes with honest errors', async () => {
  await assert.rejects(() => office.extractDocxText(te.encode('not a zip')), /zip|docx/i);
  const notWord = await zip.writeZip([{ name: 'readme.txt', data: te.encode('hi') }]);
  await assert.rejects(() => office.extractDocxText(notWord), /document\.xml/);
  const noSheets = await zip.writeZip([{ name: 'a.xml', data: te.encode('<x/>') }]);
  await assert.rejects(() => office.extractXlsxSheets(noSheets), /worksheet/);
  const noSlides = await zip.writeZip([{ name: 'a.xml', data: te.encode('<x/>') }]);
  await assert.rejects(() => office.extractPptxText(noSlides), /slides/);
});

// A minimal uncompressed PDF with known content: two lines, a hex string,
// and a line break via Td.
function simplePdf() {
  const content = [
    'BT /F1 12 Tf 72 720 Td (Quarterly Report) Tj ET',
    'BT /F1 10 Tf 72 700 Td (Revenue: \u0024 1,234) Tj 0 -14 Td (Costs: 567) Tj ET',
  ].join('\n');
  return te.encode('%PDF-1.4\n1 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
}

test('pdf: literal and hex strings extract with Td line breaks', async () => {
  const text = await pdf.extractPdfText(simplePdf());
  const lines = text.split('\n');
  assert.equal(lines[0], 'Quarterly Report');
  assert.equal(lines[1], 'Revenue: $ 1,234');
  assert.equal(lines[2], 'Costs: 567', 'Td starts a new line');
  const hexDoc = te.encode('%PDF-1.4\n1 0 obj\n<< /Length 40 >>\nstream\nBT <004869> Tj ET\nendstream\nendobj\ntrailer\n%%EOF\n');
  assert.match(await pdf.extractPdfText(hexDoc), /Hi/, 'hex strings decode');
});

test('pdf: FlateDecode streams inflate before extraction', async () => {  const raw = te.encode('BT (Compressed hello) Tj ET');
  const z = await zip.deflateRaw(raw);
  const zlib = new Uint8Array(z.length + 6);
  zlib[0] = 0x78; zlib[1] = 0x9C;
  zlib.set(z, 2);
  const c = zip.crc32(raw);
  zlib[z.length + 2] = (c >>> 24) & 0xFF; zlib[z.length + 3] = (c >>> 16) & 0xFF;
  zlib[z.length + 4] = (c >>> 8) & 0xFF; zlib[z.length + 5] = c & 0xFF;
  const doc = te.encode('%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length ' + zlib.length + ' >>\nstream\n');
  const tail = te.encode('\nendstream\nendobj\n%%EOF\n');
  const all = new Uint8Array(doc.length + zlib.length + tail.length);
  all.set(doc); all.set(zlib, doc.length); all.set(tail, doc.length + zlib.length);
  assert.equal(await pdf.extractPdfText(all), 'Compressed hello');
});

test('pdf: a scanned document is refused honestly', async () => {
  const imageOnly = te.encode('%PDF-1.4\n1 0 obj\n<< /Subtype /Image /Length 5 >>\nstream\nxxxxx\nendstream\nendobj\n%%EOF\n');
  await assert.rejects(() => pdf.extractPdfText(imageOnly), /no text layer/);
});
