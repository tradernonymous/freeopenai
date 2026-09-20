// Chat history import/export.
//
// The old import merged as [...existing, ...incoming] and then sliced the last
// 60 off the END of that array. Because the incoming set sat at the end, an
// import of a few old chats could push the newest existing ones out of the
// window -- an import silently destroying history. It also took any object
// with an `id`, so a hand-edited file could displace a real session.
//
// The rule now: entries are validated, the newer copy of a session id wins,
// and the 60 that survive are the 60 most recently updated -- whichever file
// they came from.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FreeAI4UChats = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MAX_SESSIONS = 60;
  // Fired after an import so a mounted Chat screen reloads what it is showing.
  var CHATS_CHANGED_EVENT = 'freeai4u:chats-changed';
  var STORE_KEY = 'freeai4u.chats';

  // localStorage can throw (private mode, a locked-down profile). Reading an
  // empty history is a better answer than a screen that cannot render.
  function browserStorage() {
    var scope = typeof globalThis !== 'undefined' ? globalThis : {};
    try {
      if (scope.localStorage) return scope.localStorage;
    } catch { /* fall through */ }
    return null;
  }

  function store(storage) {
    return storage || browserStorage();
  }

  // A session as THIS APP wrote it. Reading our own store is deliberately more
  // forgiving than importing a file: nothing in it is untrusted, and rejecting
  // a chat the user has been using would be data loss. So this checks only what
  // rendering needs, while imports go through isChatSession below.
  function isStoredSession(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value) &&
      typeof value.id === 'string' && value.id.trim() &&
      Array.isArray(value.messages));
  }

  function readStore(storage) {
    var target = store(storage);
    if (!target) return [];
    try {
      var raw = target.getItem(STORE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isStoredSession).slice(0, MAX_SESSIONS);
    } catch {
      return [];
    }
  }

  // The cap is applied on write as well as on read: whichever way a history
  // grows, what is stored is never more than the limit.
  function writeStore(storage, sessions) {
    var target = store(storage);
    if (!target) return false;
    try {
      var rows = (Array.isArray(sessions) ? sessions : []).filter(isStoredSession);
      target.setItem(STORE_KEY, JSON.stringify(rows.slice(0, MAX_SESSIONS)));
      return true;
    } catch {
      return false;
    }
  }

  /** The list as a history panel wants it: most recently updated first. */
  function byRecency(sessions) {
    return (Array.isArray(sessions) ? sessions.slice() : []).sort(function (a, b) {
      return updatedAtOf(b) - updatedAtOf(a);
    });
  }

  function updatedAtOf(session) {
    var value = Number(session && session.updatedAt);
    if (Number.isFinite(value) && value > 0) return value;
    var created = Number(session && session.createdAt);
    if (Number.isFinite(created) && created > 0) return created;
    return 0;
  }

  // What counts as a chat session: an id the merge can key on, a messages
  // array to render, and nothing that could not have come from this app.
  function isChatSession(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (typeof value.id !== 'string' || !value.id.trim()) return false;
    if (!Array.isArray(value.messages)) return false;
    for (var i = 0; i < value.messages.length; i += 1) {
      var message = value.messages[i];
      if (!message || typeof message !== 'object') return false;
      if (typeof message.role !== 'string') return false;
      if (message.content != null && typeof message.content !== 'string') return false;
    }
    return true;
  }

  function readList(value) {
    if (Array.isArray(value)) return value;
    // An export of a single session, or the ChatScreen's {sessions:[...]} shape.
    if (value && typeof value === 'object' && Array.isArray(value.sessions)) return value.sessions;
    return null;
  }

  function sanitize(list) {
    var out = [];
    var seen = Object.create(null);
    (readList(list) || []).forEach(function (entry) {
      if (!isChatSession(entry)) return;
      if (seen[entry.id]) return;
      seen[entry.id] = true;
      out.push(entry);
    });
    return out;
  }

  // Merge by id, keeping whichever copy was updated last, then keep the newest
  // `max` of the whole result. Never drops a newer session in favour of an
  // imported older one.
  function merge(raw, incoming, max) {
    var limit = Number(max) > 0 ? Number(max) : MAX_SESSIONS;
    var existing = sanitize(raw);
    var added = sanitize(incoming);
    var byId = new Map();
    var kept = 0;
    var updated = 0;

    existing.forEach(function (session) { byId.set(session.id, session); });
    added.forEach(function (session) {
      var current = byId.get(session.id);
      if (!current) {
        byId.set(session.id, session);
        kept += 1;
        return;
      }
      // A re-import of the same session replaces it only when it is newer
      // (a tie counts as newer: the user deliberately re-imported it).
      if (updatedAtOf(session) >= updatedAtOf(current)) {
        byId.set(session.id, session);
        updated += 1;
      }
    });

    var merged = Array.from(byId.values()).sort(function (a, b) {
      return updatedAtOf(a) - updatedAtOf(b);
    });
    var keptSessions = merged.length > limit ? merged.slice(merged.length - limit) : merged;
    return {
      sessions: keptSessions,
      added: kept,
      updated: updated,
      skipped: (readList(raw) || []).length + (readList(incoming) || []).length - byId.size,
      total: keptSessions.length,
      trimmed: merged.length - keptSessions.length,
    };
  }

  function summary(result) {
    if (!result) return 'Nothing to import.';
    var parts = [];
    if (result.added) parts.push(result.added + ' new');
    if (result.updated) parts.push(result.updated + ' updated');
    if (!parts.length) parts.push('nothing new');
    var text = 'Imported ' + parts.join(', ') + ' — ' + result.total + ' chat(s) kept.';
    if (result.trimmed) text += ' ' + result.trimmed + ' older chat(s) dropped (limit ' + MAX_SESSIONS + ').';
    return text;
  }

  // A download the browser cannot half-do: the anchor is in the document for
  // the click, and the object URL is released afterwards instead of leaking
  // for the life of the window. Both are injected so a test can watch.
  function downloadJson(fileName, text, options) {
    var opts = options || {};
    var scope = typeof globalThis !== 'undefined' ? globalThis : {};
    var doc = opts.document || scope.document || null;
    var urls = opts.URL || scope.URL || null;
    if (!doc || !doc.body) return false;
    var blob = new Blob([text], { type: 'application/json' });
    var href = urls && urls.createObjectURL ? urls.createObjectURL(blob) : '';
    var anchor = doc.createElement('a');
    anchor.href = href;
    anchor.download = fileName;
    anchor.style.display = 'none';
    doc.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      doc.body.removeChild(anchor);
      if (href && urls && urls.revokeObjectURL) urls.revokeObjectURL(href);
    }
    return true;
  }

  return {
    MAX_SESSIONS: MAX_SESSIONS,
    STORE_KEY: STORE_KEY,
    CHATS_CHANGED_EVENT: CHATS_CHANGED_EVENT,
    browserStorage: browserStorage,
    isStoredSession: isStoredSession,
    readStore: readStore,
    writeStore: writeStore,
    byRecency: byRecency,
    isChatSession: isChatSession,
    updatedAtOf: updatedAtOf,
    sanitize: sanitize,
    merge: merge,
    summary: summary,
    downloadJson: downloadJson,
  };
});
