// The gallery bug, reproduced against the shipped code.
//
// A generated picture arrives as a data: URL -- the whole image inside the
// string -- and history kept only http(s) links, so every one of them was
// dropped the moment it was saved. The bubble showed the picture because it was
// still in memory, while the gallery, which reads saved history, had nothing but
// the prompt. These tests run the real storage path against a canvas stub, so
// what is asserted is the shipped decision rather than a description of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { storedImagePlan, STORED_IMAGE_MAX_EDGE, STORED_IMAGE_MAX_CHARS } = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = ['storeGeneratedImages', 'compactImageForStorage'];

// A canvas that reports whatever length the test asks for, so the quality walk
// can be driven without decoding a real image.
function harness({ sizes = {}, broken = new Set(), encodedLength = () => 4000 } = {}) {
  const persisted = [];
  const rendered = [];
  const canvases = [];
  const deps = {
    storedImagePlan,
    STORED_IMAGE_MAX_EDGE,
    STORED_IMAGE_MAX_CHARS,
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
  // memory does -- that is why the encode is fast enough to do inline.
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
  return { ...loaded, deps, persisted, rendered, canvases };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('a generated data URL is stored, downscaled, so the gallery has a picture', async () => {
  const h = harness();
  const entry = { type: 'bot', content: '[Generated image: a fox]' };
  await h.storeGeneratedImages(entry, ['data:image/png;base64,AAAA'], 'a fox');

  assert.equal(entry.images.length, 1, 'this is the bug: the picture used to be dropped here');
  assert.match(entry.images[0].url, /^data:image\/jpeg/, 'stored as a re-encoded image, not the original bytes');
  assert.equal(entry.images[0].prompt, 'a fox', 'the prompt travels with it, since that is the gallery caption');
  assert.equal(h.persisted.length, 1, 'and it is saved, which is what the gallery reads');
  assert.equal(h.rendered.length, 1, 'an open gallery is redrawn');

  // 2048x1024 downscales by half, and the long edge lands on the cap.
  assert.equal(h.canvases.length, 1);
  assert.equal(Math.max(h.canvases[0].width, h.canvases[0].height), STORED_IMAGE_MAX_EDGE);
  assert.equal(h.canvases[0].width, 1024);
  assert.equal(h.canvases[0].height, 512);
});

test('a blob URL is re-encoded too, and a remote link is left alone', async () => {
  const h = harness();
  const entry = { type: 'bot', content: '[Generated image: two]' };
  await h.storeGeneratedImages(entry, ['blob:http://localhost/9b1c', 'https://cdn.example/fox.png'], 'two');

  assert.equal(entry.images.length, 2);
  // The bytes of a blob are in our hands, so they are re-encoded...
  assert.match(entry.images[0].url, /^data:image\/jpeg/);
  // ...and a remote link's bytes never were, so re-encoding would save nothing.
  assert.equal(entry.images[1].url, 'https://cdn.example/fox.png');
  assert.equal(h.canvases.length, 1, 'exactly one encode, for the one image we hold');
});

test('an image that is not an image is refused, and nothing is saved', async () => {
  const h = harness();
  const entry = { type: 'bot', content: '[Generated image: nope]' };
  await h.storeGeneratedImages(entry, ['javascript:alert(1)', 'data:text/html,<script>', ''], 'nope');

  assert.equal(entry.images, undefined, 'nothing usable means the placeholder stays');
  assert.equal(h.persisted.length, 0, 'and there is nothing worth writing');
  assert.equal(h.canvases.length, 0);
});

test('quality is walked down until the string fits', async () => {
  // Every quality overflows except the last two, which is what a photographic
  // image near the cap looks like.
  const h = harness({ encodedLength: (_canvas, quality) => (quality > 0.5 ? STORED_IMAGE_MAX_CHARS + 1 : 90000) });
  const entry = { type: 'bot', content: '[Generated image: big]' };
  await h.storeGeneratedImages(entry, ['data:image/png;base64,BIG'], 'big');

  assert.equal(entry.images.length, 1);
  assert.ok(entry.images[0].url.length <= STORED_IMAGE_MAX_CHARS, 'what is stored has to fit the cap');
});

test('an image that cannot be squeezed at all stays a placeholder', async () => {
  const h = harness({ encodedLength: () => STORED_IMAGE_MAX_CHARS + 1 });
  const entry = { type: 'bot', content: '[Generated image: huge]' };
  await h.storeGeneratedImages(entry, ['data:image/png;base64,HUGE'], 'huge');

  assert.equal(entry.images, undefined, 'better the prompt than a write that blows the quota');
  assert.equal(h.persisted.length, 0);
});

test('an image the browser cannot decode does not throw or half-save', async () => {
  const h = harness({ broken: new Set(['data:image/png;base64,BAD']) });
  const entry = { type: 'bot', content: '[Generated image: broken]' };
  await h.storeGeneratedImages(entry, ['data:image/png;base64,BAD'], 'broken');

  assert.equal(entry.images, undefined);
  assert.equal(h.persisted.length, 0);
  assert.equal(h.canvases.length, 0, 'nothing is drawn before the bytes are known to be readable');
});
