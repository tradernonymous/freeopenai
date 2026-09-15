// Where a generated picture is kept, against the shipped code.
//
// Two bugs live here, one after the other. First the gallery: a generated
// picture arrives as a data: URL, history kept only http(s) links, so every one
// of them was dropped the moment it was saved. Then the size: to fit those
// megabytes into localStorage, the picture was re-encoded down to a 1024px JPEG
// at a quality as low as 0.3 -- so the picture in a reopened chat was not the
// picture that was drawn, and the Download menu was converting that copy. "Save
// at 1024 x 576" was the honest report of a 1536x864 request.
//
// The fix is where the bytes go. These tests run the real storage path against a
// stand-in index, so what is asserted is the shipped decision -- the picture's
// own bytes, at the size it was drawn -- rather than a description of it. The
// compact path is still here and still tested, because it is the fallback for a
// browser with no index to put anything in.
const test = require('node:test');
const assert = require('node:assert/strict');
// The attachment module owns where a picture may go and at what size, and the
// page loads it as its own script, so this is the shipped copy.
const { storedImagePlan, STORED_IMAGE_MAX_EDGE, STORED_IMAGE_MAX_CHARS } = require('../attachment-helpers.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = ['storeGeneratedImages', 'keepFullSizeImage', 'compactImageForStorage'];

// A canvas that reports whatever length the test asks for, so the quality walk
// can be driven without decoding a real image.
function harness({ sizes = {}, broken = new Set(), encodedLength = () => 4000, index = true, refusesWrite = false, readFails = false } = {}) {
  const persisted = [];
  const rendered = [];
  const canvases = [];
  const written = [];
  const imageUrlById = new Map();
  const deps = {
    storedImagePlan,
    STORED_IMAGE_MAX_EDGE,
    STORED_IMAGE_MAX_CHARS,
    imageUrlById,
    // The index, as image-store.js presents it: a question and a write.
    imageStoreAvailable: () => index,
    putImageBytes: async (id, blob) => {
      written.push({ id, size: blob && blob.size });
      return !refusesWrite;
    },
    fetch: async () => {
      if (readFails) throw new Error('the bytes could not be read back');
      return {
        ok: true,
        blob: async () => new Blob(['x'.repeat(2048)], { type: 'image/png' }),
      };
    },
    persistMessages: () => persisted.push(true),
    renderGallery: () => rendered.push(true),
    document: {
      createElement() {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() {} }),
          toDataURL: (_type, quality) => 'data:image/jpeg;base64,' + 'A'.repeat(encodedLength(canvas, quality)),
        };
        canvases.push(canvas);
        return canvas;
      },
    },
  };
  // An Image whose src resolves in the same tick, as a data URL already in
  // memory does -- that is why the compact encode was fast enough to do inline.
  deps.Image = class {
    set src(value) {
      const size = sizes[value] || { width: 2048, height: 1024 };
      this.naturalWidth = size.width;
      this.naturalHeight = size.height;
      if (broken.has(value)) {
        if (this.onerror) this.onerror();
        return;
      }
      if (this.onload) this.onload();
    }
  };
  const loaded = loadFromIndex(NAMES, deps);
  return { ...loaded, deps, persisted, rendered, canvases, written, imageUrlById };
}

const DATA_URL = 'data:image/png;base64,AAAA';

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('a drawn picture is kept at the size it was drawn, and not re-encoded', async () => {
  const h = harness();
  const entry = { type: 'bot', content: '[Generated image: a fox]' };
  await h.storeGeneratedImages(entry, [DATA_URL], 'a fox');

  assert.equal(entry.images.length, 1, 'the picture used to be dropped here entirely');
  assert.ok(entry.images[0].id, 'the conversation names the bytes rather than carrying them');
  assert.equal(entry.images[0].prompt, 'a fox', 'the prompt travels with it, since that is the gallery caption');
  assert.equal(entry.images[0].bytes, 2048, 'and how big the kept picture is, so it can be reported');
  assert.equal(h.canvases.length, 0, 'nothing is re-encoded: the bytes that were drawn are the bytes that are kept');
  assert.equal(h.written.length, 1, 'they went to the index');
  // The URL stays in memory only. An entry carrying one would put the megabytes
  // straight back into localStorage, which is the whole thing being fixed.
  assert.equal(entry.images[0].url, undefined);
  assert.equal(h.imageUrlById.get(entry.images[0].id), DATA_URL, 'a chat switched back to draws it without a re-read');
  assert.equal(h.persisted.length, 1, 'and it is saved, which is what the gallery reads');
  assert.equal(h.rendered.length, 1, 'an open gallery is redrawn');
});

test('a browser with no index falls back to the compact inline copy', async () => {
  const h = harness({ index: false });
  const entry = { type: 'bot', content: '[Generated image: a fox]' };
  await h.storeGeneratedImages(entry, [DATA_URL], 'a fox');

  assert.equal(entry.images.length, 1, 'the picture is still better than no picture');
  assert.match(entry.images[0].url, /^data:image\/jpeg/, 'stored as a re-encoded image, since there is nowhere else');
  assert.equal(entry.images[0].compact, true, 'and marked as the reduced copy it is');
  assert.equal(entry.images[0].id, undefined);
  assert.equal(h.canvases.length, 1);
  // 2048x1024 downscales by half, and the long edge lands on the cap.
  assert.equal(Math.max(h.canvases[0].width, h.canvases[0].height), STORED_IMAGE_MAX_EDGE);
  assert.equal(h.canvases[0].width, 1024);
  assert.equal(h.canvases[0].height, 512);
});

test('an index that refuses the write falls back to the compact copy too', async () => {
  const h = harness({ refusesWrite: true });
  const entry = { type: 'bot', content: '[Generated image: a fox]' };
  await h.storeGeneratedImages(entry, [DATA_URL], 'a fox');

  assert.equal(h.written.length, 1, 'it was offered to the index');
  assert.match(entry.images[0].url, /^data:image\/jpeg/, 'and the fallback caught it');
  assert.equal(entry.images[0].compact, true);
});

test('bytes that cannot be read back fall back rather than losing the picture', async () => {
  const h = harness({ readFails: true });
  const entry = { type: 'bot', content: '[Generated image: a fox]' };
  await h.storeGeneratedImages(entry, [DATA_URL], 'a fox');

  assert.equal(entry.images.length, 1);
  assert.equal(entry.images[0].compact, true, 'a picture that can be shown beats a promise that cannot');
});

test('a blob URL is kept like any other we hold, and a remote link is left alone', async () => {
  const h = harness();
  const entry = { type: 'bot', content: '[Generated image: two]' };
  await h.storeGeneratedImages(entry, ['blob:http://localhost/9b1c', 'https://cdn.example/fox.png'], 'two');

  assert.equal(entry.images.length, 2);
  assert.ok(entry.images[0].id, 'the bytes of a blob are in our hands, so they are kept');
  // A remote link's bytes never were ours, so a second copy would save nothing
  // and outlive the link it came from.
  assert.equal(entry.images[1].url, 'https://cdn.example/fox.png');
  assert.equal(h.written.length, 1, 'exactly one write, for the one picture we hold');
});

test('an image that is not an image is refused, and nothing is saved', async () => {
  const h = harness();
  const entry = { type: 'bot', content: '[Generated image: nope]' };
  await h.storeGeneratedImages(entry, ['javascript:alert(1)', 'data:text/html,<script>', ''], 'nope');

  assert.equal(entry.images, undefined, 'nothing usable means the placeholder stays');
  assert.equal(h.persisted.length, 0, 'and there is nothing worth writing');
  assert.equal(h.canvases.length, 0);
  assert.equal(h.written.length, 0);
});

test('the compact fallback still walks the quality down until the string fits', async () => {
  // Every quality overflows except the last two, which is what a photographic
  // image near the cap looks like.
  const h = harness({ index: false, encodedLength: (_canvas, quality) => (quality > 0.5 ? STORED_IMAGE_MAX_CHARS + 1 : 90000) });
  const entry = { type: 'bot', content: '[Generated image: big]' };
  await h.storeGeneratedImages(entry, ['data:image/png;base64,BIG'], 'big');

  assert.equal(entry.images.length, 1);
  assert.ok(entry.images[0].url.length <= STORED_IMAGE_MAX_CHARS, 'what is stored has to fit the cap');
});

test('a picture that cannot be squeezed at all stays a placeholder', async () => {
  const h = harness({ index: false, encodedLength: () => STORED_IMAGE_MAX_CHARS + 1 });
  const entry = { type: 'bot', content: '[Generated image: huge]' };
  await h.storeGeneratedImages(entry, ['data:image/png;base64,HUGE'], 'huge');

  assert.equal(entry.images, undefined, 'better the prompt than a write that blows the quota');
  assert.equal(h.persisted.length, 0);
});

test('an image the browser cannot decode does not throw or half-save', async () => {
  const h = harness({ index: false, broken: new Set(['data:image/png;base64,BAD']) });
  const entry = { type: 'bot', content: '[Generated image: broken]' };
  await h.storeGeneratedImages(entry, ['data:image/png;base64,BAD'], 'broken');

  assert.equal(entry.images, undefined);
  assert.equal(h.persisted.length, 0);
  assert.equal(h.canvases.length, 0, 'nothing is drawn before the bytes are known to be readable');
});
