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
  PDF_MAX_PAGE_PT,
  pdfPageFor,
  IMAGE_SIZE_PRESETS,
  imageSizePreset,
  imageSizeFromPrompt,
  imageSizeBody,
  imageRatioBody,
  imageRatioLabel,
  describeDrawnSize,
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

test('the page is the picture: no sheet, no margin, nothing blank around it', async () => {
  // The complaint this replace: an A4 page with a 24pt margin printed the
  // drawing as a stamp in the middle of a white sheet. A PDF that follows the
  // image fills its own page, so the picture is the whole document.
  const tall = pdfPageFor(1024, 1536);
  assert.equal(tall.width, 1024, 'the page has to be the picture');
  assert.equal(tall.height, 1536);
  assert.equal(tall.imageWidth, 1024, 'and the picture has to fill it');
  assert.equal(tall.imageHeight, 1536);
  assert.equal(tall.x, 0, 'a centred picture is a picture with a margin');
  assert.equal(tall.y, 0);

  const wide = pdfPageFor(1536, 1024);
  assert.equal(wide.width, 1536);
  assert.equal(wide.height, 1024);

  const odd = pdfPageFor(1640, 856);
  assert.equal(odd.width, 1640, 'an unusual ratio is followed exactly, not rounded to a sheet');
  assert.equal(odd.height, 856);

  // A very large drawing keeps the promise at a smaller scale rather than
  // asking a reader for a four-foot page.
  const huge = pdfPageFor(4096, 2048);
  assert.equal(Math.max(huge.width, huge.height), PDF_MAX_PAGE_PT);
  assert.equal(huge.imageWidth, huge.width);
  assert.equal(huge.imageHeight, huge.height);
  assert.ok(Math.abs(huge.width / huge.height - 2) < 0.01, 'the shape survives the scale');

  const broken = pdfPageFor(0, 0);
  assert.equal(broken.width, 1, 'a page of nothing is a document no reader will open');
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
  assert.match(text, /\/MediaBox \[0 0 1536 1024\]/, 'the MediaBox has to be the picture, not a sheet it was pasted onto');
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
  assert.match(text, /\/MediaBox \[0 0 1 1\]/, 'an unmeasurable picture gets a page, not a zero box');
  assert.match(text, /%%EOF\n$/);
  assert.doesNotMatch(text, /\/Width 0 |\/Height 0 /);
});

test('the size a picture was asked for is read from the request itself', () => {
  // Nothing in the composer asks for dimensions, so the request is where the
  // answer has to come from: this is the whole of "I asked for a wide one and got
  // a square", because a request carrying no size is answered with a default.
  const exact = imageSizeFromPrompt('a 1536x1024 photo of a harbour');
  assert.equal(exact.id, 'exact');
  assert.equal(imageSizeBody(exact), '1536x1024');
  assert.deepEqual(imageRatioBody(exact), { w: 1536, h: 1024 });

  const wide = imageSizeFromPrompt('a 16:9 banner for the shop front');
  assert.equal(wide.label, '16:9');
  assert.equal(imageSizeBody(wide), '1536x864');
  assert.deepEqual(imageRatioBody(wide), { w: 16, h: 9 }, "Puter's txt2img takes the ratio, not the pixels");

  assert.equal(imageSizeFromPrompt('a tall phone wallpaper').id, 'tall');
  assert.equal(imageSizeFromPrompt('a square icon').id, 'square');
  assert.equal(imageSizeFromPrompt('a landscape oil painting').id, 'landscape');
  // Scaled to something a service will draw, rather than 21 by 9 pixels.
  const cinematic = imageSizeFromPrompt('a 21:9 cinematic shot');
  assert.equal(cinematic.label, '21:9');
  assert.ok(cinematic.width >= 1024 && cinematic.height >= 256);

  // Nothing asked for is nothing sent, which is the old behaviour and still the
  // right one: a service's own default beats a size this app invented.
  for (const plain of ['draw a cat', 'make me a hero image', '', undefined]) {
    assert.equal(imageSizeFromPrompt(plain), null, `"${plain}" invented a size`);
    assert.equal(imageSizeBody(null), '');
    assert.equal(imageRatioBody(null), null);
  }

  // The words that must not fire: a portrait is a subject, and "widespread" is
  // not a shape.
  assert.equal(imageSizeFromPrompt('a portrait of a woman in oils'), null);
  assert.equal(imageSizeFromPrompt('a widespread field of grass'), null);
  assert.equal(imageSizeFromPrompt('the history of the bicycle'), null, 'story inside history');

  // An edit takes the spelled-out size and nothing else: "make the poster blue"
  // is an instruction about the picture already on screen, and reshaping it would
  // crop something nobody asked about.
  assert.equal(imageSizeFromPrompt('make the poster blue', { words: false }), null);
  assert.equal(imageSizeFromPrompt('make it a tall phone wallpaper', { words: false }), null);
  assert.equal(imageSizeBody(imageSizeFromPrompt('crop this to 16:9', { words: false })), '1536x864');
  assert.equal(imageSizeBody(imageSizeFromPrompt('resize to 1024x1024', { words: false })), '1024x1024');

  // A grid is not a resolution, and a proportion with no px in it still is.
  assert.equal(imageSizeFromPrompt('a 3x2 grid of stickers'), null, 'a small pair is a layout, not dimensions');
  const classic = imageSizeFromPrompt('a 4:3 photo of a temple');
  assert.equal(classic.label, '4:3');
  assert.equal(imageSizeBody(classic), '1536x1152');

  assert.deepEqual(IMAGE_SIZE_PRESETS.map((p) => p.id), ['square', 'landscape', 'portrait', 'wide', 'tall']);
  assert.equal(imageRatioLabel(1536, 1024), '3:2');
});

test('a picture that came back the wrong shape is said out loud', () => {
  const wide = imageSizePreset('wide');
  const note = describeDrawnSize(wide, 1024, 1024);
  assert.match(note, /asked for 16:9 \(1536x864\), drawn 1:1 \(1024×1024\)/);
  // A provider rounding onto its own grid is the same picture to anyone looking
  // at it, and a warning nobody can act on is noise.
  assert.equal(describeDrawnSize(wide, 1536, 870), '');
  assert.equal(describeDrawnSize(wide, 1530, 860), '');
  assert.equal(describeDrawnSize(null, 1024, 1024), '', 'nothing was asked for');
  assert.equal(describeDrawnSize(wide, 0, 0), '', 'nothing was measured');
});
