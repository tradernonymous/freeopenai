// A version per AI turn and per manual edit, kept on this machine.
//
// Claude Design's imported systems have no history yet; this is the cheap,
// local-first answer. Snapshots are whole pages, so the cap is by count AND by
// size: localStorage is a few MB for the whole app, and a timeline that fills
// it would cost the person their chats.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UDesignVersions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var PREFIX = 'freeai4u.design_versions.';
  var MAX_ENTRIES = 20;
  var MAX_CHARS = 1500000;

  function storage(store) {
    if (store) return store;
    try { return (typeof globalThis !== 'undefined' && globalThis.localStorage) || null; } catch { return null; }
  }

  function list(projectId, store) {
    var s = storage(store);
    if (!s || !projectId) return [];
    try {
      var rows = JSON.parse(s.getItem(PREFIX + projectId) || '[]');
      return Array.isArray(rows) ? rows.filter(function (r) { return r && typeof r.html === 'string'; }) : [];
    } catch {
      return [];
    }
  }

  /** Newest first; identical to the newest is not a new version. */
  function push(projectId, entry, store) {
    var s = storage(store);
    var rows = list(projectId, s);
    if (!entry || typeof entry.html !== 'string' || !entry.html) return rows;
    if (rows[0] && rows[0].html === entry.html) return rows;
    var row = {
      id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      label: String(entry.label || 'Edit').slice(0, 80),
      ts: Number(entry.ts) || Date.now(),
      html: entry.html,
    };
    var next = [row].concat(rows).slice(0, MAX_ENTRIES);
    var total = 0;
    next = next.filter(function (r, i) {
      total += r.html.length;
      return i === 0 || total <= MAX_CHARS;
    });
    if (s) {
      // A full store drops the oldest until it fits; the newest always stays.
      while (next.length) {
        try {
          s.setItem(PREFIX + projectId, JSON.stringify(next));
          break;
        } catch {
          if (next.length === 1) break;
          next = next.slice(0, -1);
        }
      }
    }
    return next;
  }

  function get(projectId, id, store) {
    var rows = list(projectId, store);
    for (var i = 0; i < rows.length; i += 1) if (rows[i].id === id) return rows[i];
    return null;
  }

  function clear(projectId, store) {
    var s = storage(store);
    if (s) {
      try { s.removeItem(PREFIX + projectId); } catch { /* nothing to do */ }
    }
  }

  return { PREFIX: PREFIX, MAX_ENTRIES: MAX_ENTRIES, MAX_CHARS: MAX_CHARS, list: list, push: push, get: get, clear: clear };
});
