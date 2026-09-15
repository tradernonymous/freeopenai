// Where a generated picture's actual bytes live.
//
// History used to hold them itself: `messages[].images[].url` was a data: URL
// string inside the conversations array, in localStorage. That budget is about
// 5MB shared with every chat's text, and a picture drawn at 1536x864 is one to
// four megabytes of base64 -- so before a picture was saved it was re-encoded
// down to a 1024px JPEG at a quality that went as low as 0.3. It worked, and it
// cost exactly what the rest of the app had just been fixed to get right: the
// picture in a reopened chat was not the picture that was drawn, and "Save at
// 1024 x 576" was the honest answer to a request for 1536x864. The README
// promised "never a 'reasonable' 1024px" beside a `STORED_IMAGE_MAX_EDGE` of
// 1024.
//
// So the bytes moved out. A conversation entry keeps `{ id, prompt }` -- a few
// dozen bytes in localStorage -- and the picture is a blob in IndexedDB, which
// has no budget of that shape. Everything downstream still sees one plain URL:
// the id is turned back into one when history is read, so the DOM,
// the lightbox, the gallery and every download path never had to learn that
// there are two storage systems.
//
// IndexedDB is not always there: a locked-down private window, an old engine, a
// browser that refuses the open. That is a fallback rather than an error -- every
// function here resolves to a "no" instead of throwing -- and the caller keeps
// the older compact-inline behaviour, which is why that path still exists.
//
// Nothing in here is on the critical path of drawing a picture: the write
// happens after the bubble is on screen.

const IMAGE_DB_NAME = 'freeopenai-images';
const IMAGE_DB_STORE = 'images';
const IMAGE_DB_VERSION = 1;

// `deps.indexedDB` exists so a test can pass a stand-in, or pass `undefined` to
// exercise the no-index path deterministically. Real callers pass nothing.
function imageStoreFactory(deps) {
  if (deps && 'indexedDB' in deps) return deps.indexedDB || null;
  return typeof indexedDB === 'undefined' ? null : indexedDB;
}

function imageStoreAvailable(deps) {
  return !!imageStoreFactory(deps);
}

// The open promise, not the database: opening is asynchronous and there is one
// connection per page. Only cached for real calls, so a test's stand-in never
// leaks into the next test.
let imageDbPromise = null;

function openImageDb(deps) {
  const factory = imageStoreFactory(deps);
  if (!factory) return Promise.resolve(null);
  if (!deps && imageDbPromise) return imageDbPromise;
  const promise = new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db && !db.objectStoreNames.contains(IMAGE_DB_STORE)) db.createObjectStore(IMAGE_DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('the picture index would not open'));
    request.onblocked = () => reject(new Error('the picture index is blocked by another tab'));
  }).catch((e) => {
    // A refusal is answered the same way everywhere: no index, so the caller
    // falls back. Logged once, because a closed door is worth seeing in a
    // console and worth nothing on screen.
    console.warn('Picture index unavailable:', e && e.message ? e.message : e);
    return null;
  });
  if (!deps) imageDbPromise = promise;
  return promise;
}

function imageRequestResult(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

// Whether the bytes landed. false is not an error: it means this page stores
// pictures the old way.
async function putImageBytes(id, blob, deps) {
  if (!id || !blob) return false;
  const db = await openImageDb(deps);
  if (!db) return false;
  try {
    const tx = db.transaction(IMAGE_DB_STORE, 'readwrite');
    tx.objectStore(IMAGE_DB_STORE).put(blob, String(id));
    return await new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch {
    return false;
  }
}

// The stored Blob, or null.
async function readImageBytes(id, deps) {
  if (!id) return null;
  const db = await openImageDb(deps);
  if (!db) return null;
  try {
    const tx = db.transaction(IMAGE_DB_STORE, 'readonly');
    const got = await imageRequestResult(tx.objectStore(IMAGE_DB_STORE).get(String(id)));
    return got || null;
  } catch {
    return null;
  }
}

async function imageStoreIds(deps) {
  const db = await openImageDb(deps);
  if (!db) return [];
  try {
    const tx = db.transaction(IMAGE_DB_STORE, 'readonly');
    const keys = await imageRequestResult(tx.objectStore(IMAGE_DB_STORE).getAllKeys());
    return Array.isArray(keys) ? keys.map(String) : [];
  } catch {
    return [];
  }
}

async function deleteImageBytes(ids, deps) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => id);
  if (!list.length) return 0;
  const db = await openImageDb(deps);
  if (!db) return 0;
  try {
    const tx = db.transaction(IMAGE_DB_STORE, 'readwrite');
    const store = tx.objectStore(IMAGE_DB_STORE);
    list.forEach((id) => store.delete(String(id)));
    return await new Promise((resolve) => {
      tx.oncomplete = () => resolve(list.length);
      tx.onerror = () => resolve(0);
      tx.onabort = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

// Bytes that no conversation names any more, because the entry that held the id
// was trimmed out of history by the picture cap or by a full-quota strip.
// Nothing can ever show them again, so they go.
//
// `keep` is every id still named by a conversation. Deleting against an empty
// keep set is refused on purpose: a history that failed to read looks exactly
// like a history that is empty, and one of those two means "throw away every
// picture the user has".
async function pruneImageBytes(keep, deps) {
  const wanted = keep instanceof Set ? keep : new Set(Array.isArray(keep) ? keep.map(String) : []);
  if (!wanted.size) return 0;
  const ids = await imageStoreIds(deps);
  const orphans = ids.filter((id) => !wanted.has(String(id)));
  if (!orphans.length) return 0;
  return deleteImageBytes(orphans, deps);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IMAGE_DB_NAME,
    IMAGE_DB_STORE,
    IMAGE_DB_VERSION,
    imageStoreAvailable,
    openImageDb,
    putImageBytes,
    readImageBytes,
    imageStoreIds,
    deleteImageBytes,
    pruneImageBytes,
  };
}
