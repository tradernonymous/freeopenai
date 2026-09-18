'use strict';

// Shareable links and saved memory: the state, the network and the decisions.
//
// This used to live inline in index.html, where the only way to test it was to
// extract page functions with a brace-walking harness — which is how a broken
// "Forget all" request (an empty body the server read as a no-op) shipped
// green. The logic is here now, constructed with everything injectable, the
// way image-store.js does it; the page keeps only the DOM half: the modal, the
// tab rows, the chips. index.html creates one instance at boot:
//
//   const shareMemory = ShareMemory.create({ ...seams... });
//
// Nothing in here touches document — the page passes an `onFacts` hook and
// renders from `facts()` itself.

(function attachShareMemory(root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ShareMemory = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function ShareMemoryFactory() {
  const MEMORY_ENABLED_KEY = 'freeopenaiMemoryChats';
  const MEMORY_USE_KEY = 'freeopenaiMemoryUse';
  const MAX_FACT_CHARS = 300;

  function create(deps) {
    const {
      // Pure rules and browser machinery, injected so a test can stand in.
      sharePayloadOf,          // chatlib: transcript -> whitelisted payload | null
      memoryFactsUsedIn,       // chatlib: reply + facts -> fact texts used
      shareImageDataUrlFactory, // chatlib factory; built with the next two
      makeCanvas,
      loadImage,
      // Environment.
      fetchJson,               // (url, init) -> Promise<{ ok, status, data }>
      storage,                 // localStorage-shaped; may refuse
      imageUrlById,            // Map of stored image id -> object URL
      onFacts,                 // optional: called after the fact list changes
    } = deps;

    const downscale = shareImageDataUrlFactory({ makeCanvas, loadImage });

    // ---- saved memory ----

    let facts = [];
    let memoryOffByChat = new Set();
    try {
      const raw = storage.getItem(MEMORY_ENABLED_KEY);
      if (raw) memoryOffByChat = new Set(JSON.parse(raw));
    } catch { /* a broken list reads as none */ }

    function persistChatMemory() {
      try { storage.setItem(MEMORY_ENABLED_KEY, JSON.stringify([...memoryOffByChat])); }
      catch { /* a refused preference costs nothing */ }
    }

    function factsList() {
      return facts;
    }

    function onForChat(convoId) {
      if (!convoId) return true;
      // Default on, remembered per chat: the same conversation keeps its
      // choice across reloads.
      return !memoryOffByChat.has('off:' + convoId);
    }

    function setForChat(convoId, on) {
      if (!convoId) return;
      if (on) memoryOffByChat.delete('off:' + convoId);
      else memoryOffByChat.add('off:' + convoId);
      persistChatMemory();
    }

    async function loadFacts() {
      try {
        const { ok, data } = await fetchJson('/api/memory');
        facts = ok && Array.isArray(data.facts) ? data.facts : [];
      } catch {
        facts = [];
      }
      return facts;
    }

    async function upsertFact(text, replace) {
      const trimmed = String(text || '').trim().slice(0, MAX_FACT_CHARS);
      if (!trimmed) return null;
      try {
        const { ok, data } = await fetchJson('/api/memory', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed, replace: !!replace }),
        });
        if (ok && Array.isArray(data.facts)) {
          facts = data.facts;
          if (onFacts) onFacts();
          return facts;
        }
      } catch { /* the fact stays unsaved; the transcript is untouched */ }
      return null;
    }

    async function deleteFact(text) {
      try {
        const { ok, data } = await fetchJson('/api/memory', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (ok && Array.isArray(data.facts)) {
          facts = data.facts;
          if (onFacts) onFacts();
          return facts;
        }
      } catch { /* the row stays until a refresh succeeds */ }
      return null;
    }

    async function clearAllFacts() {
      // The body is the contract: `{all: true}`. An empty body once shipped
      // here and the server read it as "delete nothing".
      try {
        const { ok, data } = await fetchJson('/api/memory', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true }),
        });
        facts = ok && Array.isArray(data.facts) ? data.facts : facts;
        if (onFacts) onFacts();
        return facts;
      } catch {
        return null; // nothing was destroyed
      }
    }

    // The tool the model calls to remember something. The acknowledgement
    // tells the model what it saved and where a person can undo it.
    function memoryTool(args) {
      const text = String((args && args.text) || '').trim().slice(0, MAX_FACT_CHARS);
      if (!text) return Promise.resolve('Error: text is required.');
      return upsertFact(text, true).then(() =>
        'Saved to memory: "' + text + '". It will be offered to future chats that have memory on. The user can remove it in Session → Memory.');
    }

    // ---- marking replies that drew on memory ----

    function useCounts() {
      try {
        const raw = JSON.parse(storage.getItem(MEMORY_USE_KEY) || '{}');
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      } catch { return {}; }
    }

    function bumpUse(text) {
      try {
        const counts = useCounts();
        counts[text] = (counts[text] || 0) + 1;
        storage.setItem(MEMORY_USE_KEY, JSON.stringify(counts));
      } catch { /* a refused counter costs nothing: the chip still shows */ }
    }

    // Which facts a reply seems to have used, and — unless the transcript is
    // being re-rendered from storage — the write of that observation.
    function recordUse(content, opts) {
      if (!onForChat(opts && opts.convoId) || !facts.length) return [];
      const used = memoryFactsUsedIn(content, facts);
      if (!used.length || (opts && opts.restoring)) return used;
      used.forEach(bumpUse);
      return used;
    }

    // ---- shareable links ----

    let shareActiveId = null;
    let shareActiveLink = '';
    let sharePublishing = false;

    // Every stored image id is read back and compacted to a data: URL first,
    // then the whitelisted transcript is assembled by the shared helper.
    async function buildSharePayload(convo) {
      const withImages = [];
      for (const m of (convo && convo.messages) || []) {
        if (!m || (m.type !== 'user' && m.type !== 'bot')) continue;
        const images = [];
        for (const im of Array.isArray(m.images) ? m.images : []) {
          const src = im && (typeof im.url === 'string' && im.url.startsWith('data:') ? im.url : im.id ? imageUrlById.get(String(im.id)) : '') || '';
          if (!src) continue;
          images.push(await downscale(src));
        }
        withImages.push(Object.assign({}, m, { images: images.filter(Boolean) }));
      }
      return sharePayloadOf(withImages, convo && convo.title);
    }

    // Publishes one conversation. Returns a reason the page can turn into a
    // sentence: the module decides *what happened*, the page decides *what to
    // say about it*. A second call while one is in flight is refused — a
    // double click waits for the first publish, never buys a second link.
    async function publish(convo) {
      if (sharePublishing) return { ok: false, reason: 'busy' };
      sharePublishing = true;
      try {
        const payload = await buildSharePayload(convo);
        if (!payload) {
          const shareable = ((convo && convo.messages) || []).some((m) => m && (m.type === 'user' || m.type === 'bot')
            && ((String(m.content || '').trim()) || (Array.isArray(m.images) && m.images.length)));
          return { ok: false, reason: shareable ? 'too-large' : 'empty' };
        }
        const { ok, data } = await fetchJson('/api/share', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!ok || !data.id) {
          return { ok: false, reason: 'server', detail: data && data.error };
        }
        shareActiveId = data.id;
        shareActiveLink = data.url || ('/s/' + data.id);
        return { ok: true, id: data.id, url: shareActiveLink };
      } catch {
        return { ok: false, reason: 'network' };
      } finally {
        sharePublishing = false;
      }
    }

    async function revoke(id) {
      const target = id || shareActiveId;
      if (!target) return false;
      try {
        const { ok } = await fetchJson('/api/share/' + encodeURIComponent(target), { method: 'DELETE' });
        if (!ok) return false;
      } catch { /* treated as revoked: the modal closes either way */ }
      if (target === shareActiveId) {
        shareActiveId = null;
        shareActiveLink = '';
      }
      return true;
    }

    function activeShare() {
      return { id: shareActiveId, url: shareActiveLink, publishing: sharePublishing };
    }

    return {
      // memory
      factsList,
      onForChat,
      setForChat,
      loadFacts,
      upsertFact,
      deleteFact,
      clearAllFacts,
      memoryTool,
      useCounts,
      recordUse,
      // share
      buildSharePayload,
      publish,
      revoke,
      activeShare,
      // exposed so a test can prove the key names too
      MEMORY_ENABLED_KEY,
      MEMORY_USE_KEY,
    };
  }

  return { create };
});
