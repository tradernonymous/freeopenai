// Saving a generated picture.
//
// The complaint this exists for: a picture drawn at the size that was asked for
// could only be saved as a square. So the two things worth pinning are that the
// name carries the real dimensions, and that the PDF is a document a reader will
// actually open rather than bytes that merely look like one.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IMAGE_DOWNLOAD_FORMATS,
  imageDownloadFormat,
  imageDownloadStem,
  imageDownloadFilename,
  PDF_PAGE_PT,
  PDF_MARGIN_PT,
  pdfPageFor,
  buildImagePdf,
} = require('../chatlib.js');

// A JPEG's SOI marker and enough of an APP0 header to be recognisable bytes in
// the middle of a PDF stream. The builder never inspects it, which is the point:
// it goes in and comes out untouched.
const TINY_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

const asLatin1 = (bytes) => Buffer.from(bytes).toString('latin1');

test('every format the menu offers names its own extension and MIME type', () => {
  assert.deepEqual(IMAGE_DOWNLOAD_FORMATS.map((f) => f.id), ['png', 'jpg', 'pdf']);
  for (const format of IMAGE_DOWNLOAD_FORMATS) {
    assert.ok(format.label && format.hint, `${format.id} has no label or hint to show in the menu`);
    assert.match(format.mime, /^(image|application)\//);
  }
});

test('a format is looked up by more than one spelling, and never by none', () => {
  assert.equal(imageDownloadFormat('jpeg').id, 'jpg', 'jpeg is what people type');
  assert.equal(imageDownloadFormat('JPE').id, 'jpg');
  assert.equal(imageDownloadFormat('PNG').id, 'png', 'the lookup is case-insensitive');
  assert.equal(imageDownloadFormat('pdf').id, 'pdf');
  // An unknown format is PNG, not a failure to save: the button must always
  // produce a file.
  assert.equal(imageDownloadFormat('webp').id, 'png');
  assert.equal(imageDownloadFormat('').id, 'png');
  assert.equal(imageDownloadFormat(undefined).id, 'png');
});

test('a prompt becomes a filename a file system will accept', () => {
  assert.equal(imageDownloadStem('A neon Tokyo street at night'), 'a-neon-tokyo-street-at-night');
  assert.equal(imageDownloadStem('  Cafe\ndeja vu!!  '), 'cafe-deja-vu', 'accents and punctuation are stripped');
  assert.equal(imageDownloadStem('!!!'), 'image', 'a stem of nothing would leave a file called "-.png"');
  assert.equal(imageDownloadStem(''), 'image');
  assert.equal(imageDownloadStem(undefined), 'image');
  const long = imageDownloadStem('x'.repeat(200));
  assert.ok(long.length <= 48, `a 200-character prompt produced a ${long.length}-character stem`);
  assert.doesNotMatch(long, /^-|-$/, 'a trailing dash is not a word boundary');
});

test('the filename says the size, so a folder listing answers "was it the size I asked for?"', () => {
  assert.equal(
    imageDownloadFilename('A neon Tokyo street at night', 'jpeg', 1536, 1024),
    'freeai4u-a-neon-tokyo-street-at-night-1536x1024.jpg',
  );
  assert.equal(imageDownloadFilename('cat', 'pdf', 1024, 1024), 'freeai4u-cat-1024x1024.pdf');
  // No dimensions known is a missing clause, not "0x0".
  assert.equal(imageDownloadFilename('cat', 'png', 0, 0), 'freeai4u-cat.png');
  assert.equal(imageDownloadFilename('cat', 'png'), 'freeai4u-cat.png');
});

test('the page suits the picture, and a small picture is not blown up to fill it', () => {
  const tall = pdfPageFor(1024, 1536);
  assert.ok(tall.height > tall.width, 'a portrait picture gets a portrait page');
  assert.equal(tall.width, PDF_PAGE_PT.width);
  assert.equal(tall.height, PDF_PAGE_PT.height);

  const wide = pdfPageFor(1536, 1024);
  assert.ok(wide.width > wide.height, 'a landscape picture gets a landscape page, not a stamp on A4');
  assert.equal(wide.width, PDF_PAGE_PT.height);

  // Fit inside the margins, aspect preserved, centred.
  for (const page of [tall, wide]) {
    assert.ok(page.imageWidth <= page.width - PDF_MARGIN_PT * 2 + 0.01);
    assert.ok(page.imageHeight <= page.height - PDF_MARGIN_PT * 2 + 0.01);
    assert.ok(page.x >= PDF_MARGIN_PT - 0.01 && page.y >= PDF_MARGIN_PT - 0.01);
    assert.ok(Math.abs(page.imageWidth / page.imageHeight - page.pixels.width / page.pixels.height) < 0.01);
  }

  const small = pdfPageFor(256, 256);
  assert.equal(small.imageWidth, 256, 'upscaling a 256px picture would claim a resolution it has not got');
  assert.equal(small.imageHeight, 256);
});

test('the PDF is a document a reader will open', () => {
  const pdf = buildImagePdf(TINY_JPEG, 1536, 1024);
  const text = asLatin1(pdf);

  assert.ok(pdf instanceof Uint8Array);
  assert.match(text.slice(0, 8), /^%PDF-1\.4/, 'a reader sniffs the header');
  assert.match(text, /%%EOF\n$/, 'a truncated document is refused, and so is one with no end marker');
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Type \/Pages/);
  assert.match(text, /\/Type \/Page /);
  assert.match(text, /\/MediaBox \[0 0 841\.89 595\.28\]/, 'the MediaBox has to be the landscape page the picture chose');
  assert.match(text, /\/Filter \/DCTDecode/, 'the JPEG goes in as itself rather than a second lossy pass');
  assert.match(text, /\/Width 1536 \/Height 1024/, 'the image object declares the pixels, not a square');

  // The bytes that were drawn are the bytes that print.
  const streamAt = text.indexOf('/DCTDecode') + text.slice(text.indexOf('/DCTDecode')).indexOf('stream\n') + 'stream\n'.length;
  assert.deepEqual(pdf.slice(streamAt, streamAt + TINY_JPEG.length), TINY_JPEG);
});

test('every xref entry lands on the object it names', () => {
  // The offsets are the part that must be exactly right: a reader repairs a bad
  // table or gives up, so this walks the table the way a reader would.
  const pdf = buildImagePdf(TINY_JPEG, 1024, 1024);
  const text = asLatin1(pdf);

  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref has to point at the table');

  const table = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(text);
  assert.ok(table, 'no xref table');
  const count = Number(table[1]);
  const entries = table[2].split('\n').filter((line) => line !== '');
  assert.equal(entries.length, count, 'the table has to hold one entry per object, plus the free head');
  assert.equal(entries[0], '0000000000 65535 f ', 'entry zero is the free head');

  for (let i = 1; i < entries.length; i++) {
    // 10 digits + space + 5 digits + space + flag + space, then the newline the
    // split above consumed: the table is fixed-width at 20 bytes an entry.
    assert.equal(entries[i].length, 19, `entry ${i} is not 20 bytes, which is what the fixed-width table takes`);
    const offset = Number(entries[i].slice(0, 10));
    assert.match(text.slice(offset, offset + 24), new RegExp(`^${i} 0 obj`), `entry ${i} points at the wrong byte`);
  }

  // /Length has to describe the stream it precedes, or the reader reads into the
  // next object.
  const contentLength = Number(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)endstream/.exec(text)[1]);
  const content = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)endstream/.exec(text)[2];
  assert.equal(content.length, contentLength, 'the content stream length is wrong');
  assert.match(content, /cm\n\/Im0 Do\nQ\n$/, 'the one instruction that places the picture');
});

test('a PDF for a picture the browser could not measure is still a PDF', () => {
  // Defensive: a canvas that reported no dimensions must not produce a document
  // with a zero MediaBox, which no reader will open.
  const pdf = buildImagePdf(new Uint8Array(0), 0, 0);
  const text = asLatin1(pdf);
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /\/MediaBox \[0 0 595\.28 841\.89\]/, 'an unmeasurable picture gets plain A4');
  assert.match(text, /%%EOF\n$/);
  assert.doesNotMatch(text, /\/Width 0 |\/Height 0 /);
});
