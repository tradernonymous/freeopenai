// Phase 12a: PPTX export carries pictures. office.js writes PNG/JPEG parts
// under ppt/media/, a rels part per slide and a <p:pic> per picture;
// design/exports.js finds each slide's <img> (data: URLs, or sources the host
// resolves -- never remote) and places them proportionally. Checked by
// unzipping with the in-repo zip reader.
const test = require('node:test');
const assert = require('node:assert/strict');

const zip = require('../desktop/src/files/zip.js');
const office = require('../desktop/src/files/office.js');
const exportsLib = require('../desktop/src/design/exports.js');

// A real 1x1 PNG, and a minimal JPEG whose SOF0 says 32x16.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_BYTES = Buffer.from([
  0xFF, 0xD8,
  0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, // an APP0 segment to skip
  0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x10, 0x00, 0x20, 0x01, 0x01, 0x11, 0x00,
  0xFF, 0xD9,
]);
const JPEG = 'data:image/jpeg;base64,' + JPEG_BYTES.toString('base64');

async function unzip(bytes) {
  const entries = await zip.readEntries(bytes);
  const map = new Map(entries.map((e) => [e.name, e.data]));
  const text = (name) => new TextDecoder().decode(map.get(name));
  return { map, text };
}

/** Well-formed-ish: every opened element is closed in order (no DTD, no CDATA here). */
function balanced(xml) {
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g;
  let m;
  const body = xml.replace(/^<\?xml[^>]*\?>/, '');
  while ((m = re.exec(body))) {
    if (m[3]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return stack.length === 0;
}

test('writePptx still takes plain text slides, with no media parts', async () => {
  const bytes = await office.writePptx('T', ['One', 'Two']);
  const { map } = await unzip(bytes);
  assert.ok(![...map.keys()].some((n) => n.startsWith('ppt/media/')));
  assert.equal(await office.extractPptxText(bytes), 'One\n\nTwo');
});

test('writePptx embeds PNG and JPEG pictures with rels, p:pic and content types', async () => {
  const bytes = await office.writePptx('Deck', [
    { text: 'Cover', images: [{ src: PNG, x: 100, y: 200, cx: 3000, cy: 4000, name: 'Logo & mark' }] },
    'Just text',
    { text: 'Two pictures', images: [{ src: JPEG, x: 0, y: 0, cx: 10, cy: 10 }, { src: 'https://example.com/x.png', x: 0, y: 0, cx: 1, cy: 1 }, { src: PNG, x: 5, y: 5, cx: 9, cy: 9 }] },
  ], { size: { cx: 12192000, cy: 6858000 } });
  const { map, text } = await unzip(bytes);

  // Parts: media (numbered across the deck), per-slide rels only where needed.
  assert.ok(map.has('ppt/media/image1.png'));
  assert.ok(map.has('ppt/media/image2.jpeg'));
  assert.ok(map.has('ppt/media/image3.png'));
  assert.ok(!map.has('ppt/media/image4.png'), 'the remote URL was skipped');
  assert.deepEqual([...map.get('ppt/media/image1.png').slice(0, 4)], [0x89, 0x50, 0x4E, 0x47]);
  assert.deepEqual([...map.get('ppt/media/image2.jpeg')], [...JPEG_BYTES]);
  assert.ok(map.has('ppt/slides/_rels/slide1.xml.rels'));
  assert.ok(!map.has('ppt/slides/_rels/slide2.xml.rels'));
  assert.ok(map.has('ppt/slides/_rels/slide3.xml.rels'));

  const types = text('[Content_Types].xml');
  assert.match(types, /<Default Extension="png" ContentType="image\/png"\/>/);
  assert.match(types, /<Default Extension="jpeg" ContentType="image\/jpeg"\/>/);
  assert.match(text('ppt/presentation.xml'), /<p:sldSz cx="12192000" cy="6858000"\/>/);

  for (const n of [1, 3]) {
    const slide = text(`ppt/slides/slide${n}.xml`);
    const rels = text(`ppt/slides/_rels/slide${n}.xml.rels`);
    assert.ok(balanced(slide), `slide${n} is balanced`);
    assert.ok(balanced(rels), `slide${n} rels are balanced`);
    assert.match(slide, /xmlns:r="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/);
    assert.match(slide, /<p:pic>/);
    // Every r:embed names a relationship of this slide, which names a real part.
    const embeds = [...slide.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(embeds.length > 0);
    for (const id of embeds) {
      const rel = new RegExp(`<Relationship Id="${id}" Type="[^"]*/image" Target="\\.\\./media/([^"]+)"/>`).exec(rels);
      assert.ok(rel, `${id} is a relationship of slide${n}`);
      assert.ok(map.has(`ppt/media/${rel[1]}`), `${rel[1]} exists`);
    }
  }
  const s1 = text('ppt/slides/slide1.xml');
  assert.match(s1, /<a:off x="100" y="200"\/><a:ext cx="3000" cy="4000"\/>/);
  assert.match(s1, /name="Logo &amp; mark"/);
  assert.equal((text('ppt/slides/slide3.xml').match(/<p:pic>/g) || []).length, 2);
  // Text still reads back.
  assert.equal(await office.extractPptxText(bytes), 'Cover\n\nJust text\n\nTwo pictures');
});

test('writePptx skips pictures that are not really PNG/JPEG', async () => {
  const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const lying = 'data:image/png;base64,' + Buffer.from('not a png at all').toString('base64');
  const bytes = await office.writePptx('T', [{ text: 'x', images: [{ src: gif, x: 0, y: 0, cx: 1, cy: 1 }, { src: lying, x: 0, y: 0, cx: 1, cy: 1 }] }]);
  const { map, text } = await unzip(bytes);
  assert.ok(![...map.keys()].some((n) => n.startsWith('ppt/media/')));
  assert.doesNotMatch(text('ppt/slides/slide1.xml'), /<p:pic>/);
});

const DECK = `<!doctype html><html><body>
<section class="slide"><h1>Cover</h1><img src="${PNG}" alt="logo" style="position:absolute;left:960px;top:540px;width:480px;height:270px"></section>
<section class="slide"><h2>Mixed</h2>
  <img src="https://cdn.example.com/remote.png">
  <img src="//cdn.example.com/proto.png">
  <img src="${JPEG}" width="640">
  <img src="assets/local.png" alt="resolved">
  <img src="${PNG}" style="left:10%;top:20%;width:25%;height:25%">
</section>
<section class="slide"><p>No pictures</p></section>
</body></html>`;

test('pptxDeck: each slide keeps its text and readable <img>s, placed proportionally', () => {
  const deck = exportsLib.pptxDeck(DECK, {
    stage: { width: 1920, height: 1080 },
    resolve: (src) => (src === 'assets/local.png' ? PNG : ''),
  });
  assert.deepEqual(deck.size, { cx: 12192000, cy: 6858000 });
  assert.equal(deck.slides.length, 3);
  assert.equal(deck.slides[0].text, 'Cover');

  // Inline px position: half-way across and down, a quarter of the slide wide.
  assert.deepEqual(deck.slides[0].images, [{ src: PNG, x: 6096000, y: 3429000, cx: 3048000, cy: 1714500, name: 'logo' }]);

  const mixed = deck.slides[1].images;
  assert.equal(mixed.length, 3, 'remote and protocol-relative URLs are skipped');
  assert.ok(mixed.every((i) => /^data:image\/(png|jpeg);base64,/.test(i.src)));
  // The % position maps straight onto the slide.
  const pct = mixed.find((i) => i.x === Math.round(0.1 * 12192000));
  assert.ok(pct);
  assert.equal(pct.y, Math.round(0.2 * 6858000));
  assert.equal(pct.cx, Math.round(0.25 * 12192000));
  // Unpositioned pictures flow down the right half, inside the slide, keeping aspect.
  const flowing = mixed.filter((i) => i !== pct);
  assert.equal(flowing.length, 2);
  for (const img of flowing) {
    assert.ok(img.x >= 0.5 * 12192000, 'right half');
    assert.ok(img.x + img.cx <= 12192000 && img.y + img.cy <= 6858000, 'inside the slide');
  }
  // The JPEG is 32x16 (2:1, read from its SOF), asked 640px wide.
  const jpeg = flowing.find((i) => i.src === JPEG);
  assert.ok(Math.abs(jpeg.cx / jpeg.cy - 2) < 0.01, 'aspect ratio kept');
  assert.equal(flowing[1].name, 'resolved');

  assert.deepEqual(deck.slides[2].images, []);
  // slideTexts is unchanged.
  assert.deepEqual(deck.slides.map((s) => s.text), exportsLib.slideTexts(DECK));
});

test('pptxDeck output goes straight into writePptx and unzips with its pictures', async () => {
  const deck = exportsLib.pptxDeck(DECK, { resolve: () => PNG });
  const bytes = await office.writePptx('Deck', deck.slides, { size: deck.size });
  const { map, text } = await unzip(bytes);
  const media = [...map.keys()].filter((n) => n.startsWith('ppt/media/'));
  assert.equal(media.length, 4);
  assert.match(text('ppt/slides/slide1.xml'), /<p:pic>[\s\S]*r:embed="rId1"/);
  assert.match(text('ppt/slides/_rels/slide2.xml.rels'), /Id="rId3"/);
  assert.ok(balanced(text('ppt/slides/slide2.xml')));
});
