// The toast queue's rules.
//
// The sidebar used to deliver its one piece of feedback with `setHint(...)` and
// a bare `setTimeout(..., 4000)` in the component -- invisible to a screen
// reader, impossible to dismiss, and re-triggered messages simply overwrote the
// timer. This is the real thing as a pure list transform: what stacks, what
// replaces what, what expires, and what stays until it is dismissed.
//
// UMD like the repo's other shared modules (published unconditionally -- see
// chats.js for why).
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UToasts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MAX_VISIBLE = 3;
  var DEFAULT_MS = 6000;
  var REPEAT_WINDOW_MS = 4000;

  var ICONS = { info: 'activity', ok: 'check', warn: 'alert', error: 'alert' };

  function iconFor(kind) {
    return ICONS[kind] || ICONS.info;
  }

  // Add a message. The newest repeats win over the oldest: saying the same
  // thing twice should refresh what is on screen, not stack a second copy, and
  // the list never grows past what a user can read at once.
  function push(list, toast, now) {
    var time = Number(now) || Date.now();
    var rows = (Array.isArray(list) ? list : []).slice();
    var message = String((toast && toast.text) || '').trim();
    if (!message) return rows;
    var kind = (toast && toast.kind) || 'info';
    var sticky = !!(toast && toast.sticky);
    var repeatAt = rows.findIndex(function (row) {
      return row.text === message && time - row.at <= REPEAT_WINDOW_MS;
    });
    if (repeatAt >= 0) {
      var previous = rows[repeatAt];
      rows[repeatAt] = { id: previous.id, text: message, kind: kind, sticky: sticky, at: time };
      return rows;
    }
    var id = (toast && toast.id) || ('t' + time.toString(36) + Math.random().toString(36).slice(2, 6));
    rows.push({ id: id, text: message, kind: kind, sticky: sticky, at: time });
    // Keep the newest when trimming: an old toast is the one to lose.
    if (rows.length > MAX_VISIBLE) rows = rows.slice(rows.length - MAX_VISIBLE);
    return rows;
  }

  function dismiss(list, id) {
    return (Array.isArray(list) ? list : []).filter(function (row) { return row.id !== id; });
  }

  // What has aged out. A sticky toast stays until it is dismissed, and one that
  // carries an action stays long enough to be clicked.
  function expired(list, now, lifetimeMs) {
    var time = Number(now) || Date.now();
    var life = Number(lifetimeMs) > 0 ? Number(lifetimeMs) : DEFAULT_MS;
    return (Array.isArray(list) ? list : []).filter(function (row) {
      if (row.sticky) return false;
      return time - row.at >= life;
    });
  }

  /** Drop everything that has aged out; returns the list to render. */
  function prune(list, now, lifetimeMs) {
    var gone = expired(list, now, lifetimeMs);
    if (!gone.length) return Array.isArray(list) ? list : [];
    var ids = gone.map(function (row) { return row.id; });
    return (Array.isArray(list) ? list : []).filter(function (row) { return ids.indexOf(row.id) < 0; });
  }

  return {
    MAX_VISIBLE: MAX_VISIBLE,
    DEFAULT_MS: DEFAULT_MS,
    REPEAT_WINDOW_MS: REPEAT_WINDOW_MS,
    iconFor: iconFor,
    push: push,
    dismiss: dismiss,
    expired: expired,
    prune: prune,
  };
});
