// Where a picture's bytes live now, and how they get back out.
//
// The index is IndexedDB, which is asynchronous, event-based and not always
// there. The failure that matters is the quiet one: an index that is missing has
// to read as "fall back to the inline copy", not as an exception the caller
// catches into an empty picture, and a history that failed to read must not be
// mistaken for a history with no pictures in it -- that mistake deletes every
// picture the user has.
//
// The last test is the wiring: an entry names an id, the bytes come back out of
// the index, and the page ends up with a URL it can draw. That is the join the
// whole change turns on.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  imageStoreAvailable,
  openImageDb,
  putImageBytes,
  readImageBytes,
  imageStoreIds,
  deleteImageBytes,
  pruneImageBytes,
} = require('../image-store.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

// --- IndexedDB, in the smallest size that answers these calls -----------------
//
// Open, one store, and a transaction that reports completion. Event-based on
// purpose: a promise-shaped stand-in would not exercise the parts of the module
// that exist because of how the real thing behaves.
function fakeRequest() {
  return {
    result: undefined,
    onsuccess: null,
    onerror: null,
    succeed(value) {
      this.result = value;
      setTimeout(() => { if (this.onsuccess) this.onsuccess(); }, 0);
    },
  };
}

function fakeIndexedDb(initial = []) {
  const rows = new Map(initial.map(([k, v]) => [String(k), v]));
  const stores = new Set(['images']);
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => { stores.add(name); return {}; },
    transaction() {
      const tx = { oncomplete: null, onerror: null, onabort: null };
      const store = {
        put(value, key) { const r = fakeRequest(); rows.set(String(key), value); r.succeed(undefined); return r; },
        get(key) { const r = fakeRequest(); setTimeout(() => r.succeed(rows.get(String(key))), 0); return r; },
        getAllKeys() { const r = fakeRequest(); setTimeout(() => r.succeed([...rows.keys()]), 0); return r; },
        delete(key) { const r = fakeRequest(); rows.delete(String(key)); r.succeed(undefined); return r; },
      };
      tx.objectStore = () => store;
      setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 4);
      return tx;
    },
  };
  return {
    rows,
    open() {
      const request = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      setTimeout(() => {
        if (request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    },
  };
}

// A browser that will not open one: private-mode Safari, a locked-down engine.
const refusingIndex = {
  open() {
    const request = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
    setTimeout(() => { if (request.onerror) request.onerror(); }, 0);
    return request;
  },
};

// --- The module on its own ---------------------------------------------------

test('no index at all is a fallback, not an error', async () => {
  const none = { indexedDB: undefined };
  assert.equal(imageStoreAvailable(none), false);
  assert.equal(await openImageDb(none), null);
  assert.equal(await putImageBytes('a', new Blob(['x']), none), false);
  assert.equal(await readImageBytes('a', none), null);
  assert.deepEqual(await imageStoreIds(none), []);
  assert.equal(await deleteImageBytes(['a'], none), 0);
});

test('an index that refuses to open is the same fallback', async () => {
  // console.warn is expected here; the module says so once and carries on.
  const warn = console.warn;
  console.warn = () => {};
  try {
    const refusing = { indexedDB: refusingIndex };
    assert.equal(imageStoreAvailable(refusing), true, 'it is there, it just will not open');
    assert.equal(await putImageBytes('a', new Blob(['x']), refusing), false);
    assert.equal(await readImageBytes('a', refusing), null);
    assert.deepEqual(await imageStoreIds(refusing), []);
  } finally {
    console.warn = warn;
  }
});

test('bytes go in, come back, and can be listed and removed', async () => {
  const idb = fakeIndexedDb();
  const deps = { indexedDB: idb };
  const blob = new Blob(['a picture'], { type: 'image/png' });

  assert.equal(await putImageBytes('i1', blob, deps), true);
  assert.equal(idb.rows.get('i1'), blob, 'the blob itself, not a re-encoded stand-in');
  assert.deepEqual(await imageStoreIds(deps), ['i1']);

  const back = await readImageBytes('i1', deps);
  assert.equal(back, blob);
  assert.equal(await readImageBytes('nope', deps), null, 'an id with nothing behind it is null, not a throw');

  assert.equal(await deleteImageBytes(['i1'], deps), 1);
  assert.deepEqual(await imageStoreIds(deps), []);
});

test('nothing is ever stored under an empty id', async () => {
  const idb = fakeIndexedDb();
  const deps = { indexedDB: idb };
  assert.equal(await putImageBytes('', new Blob(['x']), deps), false);
  assert.equal(await putImageBytes('i1', null, deps), false);
  assert.deepEqual(await imageStoreIds(deps), [], 'and the store never opens for it');
});

test('pruning keeps what a conversation names and drops what it does not', async () => {
  const idb = fakeIndexedDb([['i1', new Blob(['1'])], ['i2', new Blob(['2'])], ['i3', new Blob(['3'])]]);
  const deps = { indexedDB: idb };

  assert.equal(await pruneImageBytes(['i1', 'i3'], deps), 1, 'i2 was trimmed out of history by the picture cap');
  assert.deepEqual((await imageStoreIds(deps)).sort(), ['i1', 'i3']);
});

test('an empty keep set never empties the index', async () => {
  // A history that failed to read looks exactly like a history with no pictures
  // in it, and one of those two means "throw away everything the user has".
  const idb = fakeIndexedDb([['i1', new Blob(['1'])], ['i2', new Blob(['2'])]]);
  const deps = { indexedDB: idb };

  assert.equal(await pruneImageBytes([], deps), 0);
  assert.equal(await pruneImageBytes(new Set(), deps), 0);
  assert.deepEqual((await imageStoreIds(deps)).sort(), ['i1', 'i2'], 'nothing was deleted');
});

// --- The wiring the rest of the page depends on ------------------------------

const NAMES = ['storedImageUrl', 'hydrateStoredImages'];
const BLOB = new Blob(['a drawn picture'], { type: 'image/png' });

function harness({ stored = true, ids = ['i1'], conversations = [] } = {}) {
  const objects = [];
  const deps = {
    imageUrlById: new Map(),
    conversations,
    readImageBytes: async (id) => (stored ? (ids.includes(id) ? BLOB : null) : null),
    pruneImageBytes: async () => 0,
    URL: {
      createObjectURL: (blob) => {
        objects.push(blob);
        return 'blob:stub/' + objects.length;
      },
    },
  };
  return { ...loadFromIndex(NAMES, deps), deps, objects };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('a stored id becomes a URL the page can draw', async () => {
  const entry = { images: [{ id: 'i1', prompt: 'a fox', bytes: 15 }] };
  const h = harness({ conversations: [{ id: 'c1', messages: [{ images: [entry.images[0]] }] }] });

  assert.equal(h.storedImageUrl(entry.images[0]), '', 'before the index is read there is nothing to show');
  await h.hydrateStoredImages();
  assert.equal(h.storedImageUrl(entry.images[0]), 'blob:stub/1', 'and after it, there is');
  assert.equal(h.deps.imageUrlById.get('i1'), 'blob:stub/1');
  assert.equal(h.objects[0], BLOB, 'made from the stored blob, so no copy of the picture is held twice');
});

test('an entry that carries its own URL never consults the index', async () => {
  const inline = { url: 'data:image/jpeg;base64,SMALL', compact: true };
  const remote = { url: 'https://cdn.example/fox.png' };
  const h = harness({ conversations: [{ id: 'c1', messages: [{ images: [inline, remote] }] }] });

  await h.hydrateStoredImages();
  assert.equal(h.storedImageUrl(inline), 'data:image/jpeg;base64,SMALL');
  assert.equal(h.storedImageUrl(remote), 'https://cdn.example/fox.png');
  assert.deepEqual(h.objects, [], 'neither of these needs anything read');
});

test('a picture whose bytes are gone stays empty rather than throwing', async () => {
  const entry = { images: [{ id: 'gone', prompt: 'a fox' }] };
  const h = harness({ conversations: [{ id: 'c1', messages: [{ images: [entry.images[0]] }] }] });

  await h.hydrateStoredImages();
  assert.equal(h.storedImageUrl(entry.images[0]), '', 'the transcript has a card for exactly this state');
});

test('hydration reads an id once, even across two chats showing the same picture', async () => {
  const im = { id: 'i1', prompt: 'a fox' };
  const h = harness({ conversations: [{ id: 'c1', messages: [{ images: [im] }] }, { id: 'c2', messages: [{ images: [im] }] }] });

  await h.hydrateStoredImages();
  assert.equal(h.objects.length, 1, 'one object URL, not one per sighting');
  assert.equal(h.deps.imageUrlById.size, 1);
});

test('an entry with no prompt and no id is skipped, not crashed on', async () => {
  const h = harness({ conversations: [{ id: 'c1', messages: [{ images: [null, {}, { url: '' }] }] }] });
  await h.hydrateStoredImages();
  assert.equal(h.deps.imageUrlById.size, 0);
});
