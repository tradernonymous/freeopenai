// The thread sidebar's logic: short auto-titles, pinned chats and folders, and
// the sections the History panel draws. Pure functions over the chat list and
// a small meta record, so the grouping is tested without a DOM.
//
// Meta lives apart from the chats (freeai4u.thread_meta) on purpose: pinning or
// filing a chat must not bump its updatedAt and reorder the list.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FreeAI4UThreads = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var META_KEY = 'freeai4u.thread_meta';
  /** Fired (on window) when chats are saved, so open lists redraw. */
  var CHANGED_EVENT = 'freeai4u:chats-changed';
  /** Fired with detail {id, busy} while a chat is generating or running tools. */
  var ACTIVITY_EVENT = 'freeai4u:chat-activity';

  // Words that make a title longer without saying more.
  var FILLER = /^(a|an|the|please|can|could|would|you|me|i|to|for|of|and|or|in|on|with|my|some|how|what|is|do|does|about|write|make|give|tell|help|hey|hi|at|by|from|into|as|it|this|that|these|those|be|are|was)$/i;

  /**
   * autoTitle(text) -> 2-4 words naming a chat from its first message. Filler
   * is dropped; the first letter is capitalised; code and attachments are
   * ignored. Falls back to the first words when everything was filler.
   */
  function autoTitle(text) {
    var body = String(text || '')
      .split('\n--- attached ---')[0]
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ');
    var words = body.split(/\s+/).filter(Boolean);
    if (!words.length) return 'New chat';
    var kept = words.filter(function (w) { return !FILLER.test(w); });
    var pick = (kept.length >= 2 ? kept : words).slice(0, 4);
    var title = pick.join(' ');
    if (title.length > 40) title = title.slice(0, 40).replace(/\s+\S*$/, '');
    return title.charAt(0).toUpperCase() + title.slice(1);
  }

  function cleanMeta(value) {
    var meta = { pinned: [], folders: {} };
    if (!value || typeof value !== 'object') return meta;
    if (Array.isArray(value.pinned)) {
      meta.pinned = value.pinned.filter(function (id) { return typeof id === 'string'; }).slice(0, 50);
    }
    if (value.folders && typeof value.folders === 'object') {
      Object.keys(value.folders).forEach(function (id) {
        var name = String(value.folders[id] || '').trim().slice(0, 40);
        if (name) meta.folders[id] = name;
      });
    }
    return meta;
  }

  function readMeta(store) {
    try { return cleanMeta(JSON.parse((store || globalThis.localStorage).getItem(META_KEY) || '{}')); } catch (e) { return cleanMeta(null); }
  }

  function writeMeta(meta, store) {
    try { (store || globalThis.localStorage).setItem(META_KEY, JSON.stringify(cleanMeta(meta))); } catch (e) { /* storage full: meta is optional */ }
  }

  function togglePin(meta, id) {
    var m = cleanMeta(meta);
    var at = m.pinned.indexOf(id);
    if (at >= 0) m.pinned.splice(at, 1); else m.pinned.unshift(id);
    return m;
  }

  /** File a chat under a folder; an empty name takes it out again. */
  function setFolder(meta, id, name) {
    var m = cleanMeta(meta);
    var clean = String(name || '').trim().slice(0, 40);
    if (clean) m.folders[id] = clean; else delete m.folders[id];
    return m;
  }

  function folderNames(meta) {
    var m = cleanMeta(meta);
    var seen = {};
    Object.keys(m.folders).forEach(function (id) { seen[m.folders[id]] = true; });
    return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
  }

  function matches(session, query) {
    if (!query) return true;
    var q = query.toLowerCase();
    if (String(session.title || '').toLowerCase().indexOf(q) >= 0) return true;
    return (session.messages || []).some(function (m) { return String(m.content || '').toLowerCase().indexOf(q) >= 0; });
  }

  /**
   * sections(sessions, meta, query) -> [{ key, title, items }]
   * Pinned first (in pin order), then each folder A-Z, then everything else,
   * newest first. A chat appears once. Empty sections are left out.
   */
  function sections(sessions, meta, query) {
    var m = cleanMeta(meta);
    var list = (sessions || []).filter(function (s) { return s && matches(s, query); })
      .slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var byId = {};
    list.forEach(function (s) { byId[s.id] = s; });
    var used = {};
    var out = [];
    var pinned = m.pinned.map(function (id) { return byId[id]; }).filter(Boolean);
    pinned.forEach(function (s) { used[s.id] = true; });
    if (pinned.length) out.push({ key: 'pinned', title: 'Pinned', items: pinned });
    folderNames(m).forEach(function (name) {
      var items = list.filter(function (s) { return !used[s.id] && m.folders[s.id] === name; });
      items.forEach(function (s) { used[s.id] = true; });
      if (items.length) out.push({ key: 'folder:' + name, title: name, items: items });
    });
    var rest = list.filter(function (s) { return !used[s.id]; });
    if (rest.length) out.push({ key: 'recent', title: out.length ? 'Recent' : '', items: rest });
    return out;
  }

  /** The hover card's words: the last thing said, trimmed, reasoning removed. */
  function preview(session, max) {
    var limit = Number(max) > 0 ? Number(max) : 160;
    var msgs = (session && session.messages) || [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].note) continue;
      var text = String(msgs[i].content || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/\s+/g, ' ').trim();
      if (text) return (msgs[i].role === 'user' ? 'You: ' : '') + (text.length > limit ? text.slice(0, limit - 1) + '…' : text);
    }
    return 'No messages yet.';
  }

  return {
    META_KEY: META_KEY,
    CHANGED_EVENT: CHANGED_EVENT,
    ACTIVITY_EVENT: ACTIVITY_EVENT,
    autoTitle: autoTitle,
    cleanMeta: cleanMeta,
    readMeta: readMeta,
    writeMeta: writeMeta,
    togglePin: togglePin,
    setFolder: setFolder,
    folderNames: folderNames,
    sections: sections,
    preview: preview,
  };
});
