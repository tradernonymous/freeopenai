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
  // Published to the global UNCONDITIONALLY, and to module.exports when node
  // is asking. The traditional UMD shape that assigns the API only in the
  // fallback branch -- the one that runs when node is NOT detected -- is unsound
  // once a bundler is involved: Vite's CommonJS interop leaves a `module`
  // object in scope, so the wrapper takes the CommonJS branch and the global
  // is never set. That is exactly how a production build shipped a window
  // that drew its background colour and nothing else -- dev worked, the bundle
  // died on the first read of these globals.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UChats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 60 used to be the cap, chosen when a chat was a few short turns. Tool-
  // heavy transcripts are long, so the cap is now generous. Under the shell
  // the history lives in an encrypted SQLite file (see "persistence" below);
  // in a plain browser the limit is localStorage's quota, which writeStore
  // handles by dropping the oldest sessions until the write fits.
  var MAX_SESSIONS = 500;
  // Fired after an import so a mounted Chat screen reloads what it is showing.
  var CHATS_CHANGED_EVENT = 'freeai4u:chats-changed';
  var STORE_KEY = 'freeai4u.chats';
  // Chats one window hands another under the shell store (handOff/absorb).
  // Kept apart from STORE_KEY so absorbing one never touches the history of
  // a window that fell back to localStorage.
  var INBOX_KEY = 'freeai4u.chats.inbox';

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

  // ---- persistence ---------------------------------------------------------
  //
  // Two homes for the history:
  //
  //   'local' -- localStorage, exactly as before. The default, the browser
  //              build, and the fallback whenever the shell store fails.
  //   'shell' -- an in-memory cache is the source of truth for the synchronous
  //              readStore/writeStore every screen already calls; a debounced
  //              flush sends only the chats that changed to the backend (the
  //              shell's SQLite file, each chat encrypted: chat-crypto.js).
  //
  // hydrate(backend) is called once at boot. It reads the backend, moves any
  // localStorage chats into it (verified by reading back before the old copy
  // is removed), and switches to 'shell'. Any failure leaves 'local' in place
  // and says so once through onNotice.
  //
  // A backend is { list(): Promise<session[]>, put(sessions): Promise<any>,
  // remove(ids): Promise<any> } -- plain sessions; encryption is its business.
  var DEFAULT_FLUSH_DELAY = 400;
  var state = {
    mode: 'local',
    backend: null,
    storage: null,
    cache: [],
    // id -> signature of what the backend holds, so a flush sends only changes.
    flushed: new Map(),
    // object -> signature, so an untouched session is not re-serialised.
    seen: new WeakMap(),
    timer: null,
    flushing: null,
    hydrating: null,
    dirty: false,
    delay: DEFAULT_FLUSH_DELAY,
    onNotice: null,
    noticed: false,
    // NEURA-022: the store's key cannot open the chats that are there.
    onRecovery: null,
    recovery: null,
  };

  function legacyStorage() {
    return state.storage || browserStorage();
  }

  function notice(text) {
    if (state.noticed) return;
    state.noticed = true;
    if (typeof state.onNotice === 'function') {
      try { state.onNotice(text); } catch { /* a toast must not break the store */ }
    }
  }

  function announce() {
    var scope = typeof globalThis !== 'undefined' ? globalThis : {};
    if (typeof scope.dispatchEvent !== 'function' || typeof scope.Event !== 'function') return;
    try { scope.dispatchEvent(new scope.Event(CHATS_CHANGED_EVENT)); } catch { /* no window */ }
  }

  // FNV-1a over the JSON: cheap, and only ever compared with itself. The
  // object cache is keyed on updatedAt too, so a session patched in place with
  // a new timestamp is re-read rather than trusted.
  function signature(session) {
    var cached = state.seen.get(session);
    if (cached && cached.at === updatedAtOf(session)) return cached.sig;
    var text = JSON.stringify(session);
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    var sig = updatedAtOf(session) + ':' + text.length + ':' + (hash >>> 0).toString(16);
    state.seen.set(session, { at: updatedAtOf(session), sig: sig });
    return sig;
  }

  /** True when the history lives in the shell's store, not localStorage. */
  function persistent() {
    return state.mode === 'shell';
  }

  function scheduleFlush() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      state.timer = null;
      flush().catch(function () { /* flush reports through onNotice */ });
    }, state.delay);
  }

  // The store failed after boot: keep what is in memory by writing it where
  // the history used to live, and stop using the backend.
  function fallBack(reason) {
    var rows = state.cache;
    state.mode = 'local';
    state.backend = null;
    listen(false);
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    writeLocal(legacyStorage(), rows);
    notice('Chat history could not be saved to the encrypted store (' + reason + '); using browser storage for now.');
  }

  /**
   * Send what changed since the last flush. Resolves when the backend has it.
   * A flush asked for while one runs is folded into one more pass after it.
   */
  function flush() {
    if (state.mode !== 'shell' || !state.backend) return Promise.resolve(false);
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.flushing) {
      state.dirty = true;
      return state.flushing;
    }
    var backend = state.backend;
    var rows = state.cache.slice();
    var next = new Map();
    var changed = [];
    rows.forEach(function (session) {
      var sig = signature(session);
      next.set(session.id, sig);
      if (state.flushed.get(session.id) !== sig) changed.push(session);
    });
    var removed = [];
    state.flushed.forEach(function (_sig, id) {
      if (!next.has(id)) removed.push(id);
    });
    if (!changed.length && !removed.length) return Promise.resolve(true);

    state.flushing = Promise.resolve()
      .then(function () { return changed.length ? backend.put(changed) : null; })
      .then(function () { return removed.length ? backend.remove(removed) : null; })
      .then(function () {
        state.flushed = next;
        return true;
      }, function (err) {
        fallBack((err && err.message) || String(err));
        return false;
      })
      .then(function (ok) {
        state.flushing = null;
        if (state.dirty && state.mode === 'shell') {
          state.dirty = false;
          return flush();
        }
        state.dirty = false;
        return ok;
      });
    return state.flushing;
  }

  function ids(list) {
    return list.map(function (s) { return s.id; });
  }

  /**
   * Read the backend in, move localStorage chats into it, switch to 'shell'.
   * `backend` may be the backend, a promise of one, or a function returning
   * either (so the key lookup can fail inside the same try). null/undefined
   * means "no shell": the history stays in localStorage.
   */
  function hydrate(backend, options) {
    var opts = options || {};
    if (opts.storage !== undefined) state.storage = opts.storage;
    if (typeof opts.onNotice === 'function') state.onNotice = opts.onNotice;
    if (typeof opts.onRecovery === 'function') state.onRecovery = opts.onRecovery;
    if (typeof opts.delay === 'number' && opts.delay >= 0) state.delay = opts.delay;
    if (!backend) return Promise.resolve({ mode: 'local', migrated: 0 });
    // Once per app: React's dev double-effect, or a second caller, gets the
    // same answer instead of a second migration racing the first.
    if (state.hydrating) return state.hydrating;
    if (state.mode === 'shell') return Promise.resolve({ mode: 'shell', migrated: 0 });
    state.hydrating = run(backend).then(function (result) {
      state.hydrating = null;
      return result;
    });
    return state.hydrating;
  }

  function run(backend) {
    var active = null;
    var migrated = 0;
    return Promise.resolve()
      .then(function () { return typeof backend === 'function' ? backend() : backend; })
      .then(function (b) {
        if (!b || typeof b.list !== 'function' || typeof b.put !== 'function' || typeof b.remove !== 'function') {
          throw new Error('no chat store');
        }
        active = b;
        return active.list();
      })
      .then(function (stored) {
        var fromBackend = (Array.isArray(stored) ? stored : []).filter(isStoredSession);
        // Chats still in localStorage: a first run, or ones written while the
        // backend was loading. Only the ones newer than the backend's copy go in.
        // Our own data on both sides, so the forgiving check (isStoredSession),
        // not the import one: a chat must never be dropped for a missing field.
        var legacy = readLocal(legacyStorage());
        var byId = new Map();
        fromBackend.forEach(function (s) { byId.set(s.id, s); });
        var toWrite = [];
        legacy.forEach(function (s) {
          var current = byId.get(s.id);
          if (current && updatedAtOf(current) >= updatedAtOf(s)) return;
          byId.set(s.id, s);
          toWrite.push(s);
        });
        var sessions = Array.from(byId.values());
        if (!toWrite.length) return { sessions: sessions, fromBackend: fromBackend, legacy: legacy };
        return Promise.resolve(active.put(toWrite))
          .then(function () { return active.list(); })
          .then(function (again) {
            var have = new Set(ids((Array.isArray(again) ? again : []).filter(isStoredSession)));
            var missing = ids(toWrite).filter(function (id) { return !have.has(id); });
            if (missing.length) throw new Error(missing.length + ' chat(s) did not read back');
            migrated = toWrite.length;
            return { sessions: sessions, fromBackend: fromBackend, legacy: legacy };
          });
      })
      .then(function (result) {
        // What the backend now holds, verified. Its signatures are recorded
        // before anything written since is folded in, so those count as changes.
        var flushed = new Map();
        var byId = new Map();
        result.sessions.forEach(function (s) {
          byId.set(s.id, s);
          flushed.set(s.id, signature(s));
        });
        // A screen may have written to localStorage while the backend was
        // being read; those writes are newer than what was migrated.
        var late = readLocal(legacyStorage());
        var pending = false;
        late.forEach(function (s) {
          var current = byId.get(s.id);
          if (current && updatedAtOf(current) >= updatedAtOf(s)) return;
          byId.set(s.id, s);
          pending = true;
        });
        // The old copy can go: everything in it is either in the backend or in
        // the cache, which flushes below. Nothing awaits between here and the
        // switch, so no write can land in localStorage in between.
        if (result.legacy.length || late.length) removeLocal(legacyStorage());
        state.backend = active;
        state.mode = 'shell';
        state.cache = byRecency(Array.from(byId.values())).slice(0, MAX_SESSIONS);
        state.flushed = flushed;
        // Rows past the cap were never in the cache: the next flush deletes them.
        if (pending || state.flushed.size > state.cache.length) scheduleFlush();
        listen(true);
        // A hand-off made while this window was starting.
        absorb();
        announce();
        return { mode: 'shell', migrated: migrated };
      })
      .catch(function (err) {
        state.mode = 'local';
        state.backend = null;
        var reason = (err && err.message) || String(err);
        var plan = recoveryFor(err);
        if (plan) {
          // Once per launch: a second hydrate (the dev double effect) does not
          // stack a second notice.
          var first = !state.recovery;
          state.recovery = plan;
          if (first && typeof state.onRecovery === 'function') {
            try { state.onRecovery(plan); } catch { /* the notice must not break the store */ }
          } else if (first) {
            notice('Chat history is in browser storage: ' + reason + '.');
          }
          return { mode: 'local', migrated: 0, error: reason, recovery: true };
        }
        notice('Chat history is in browser storage: the encrypted store is unavailable (' + reason + ').');
        return { mode: 'local', migrated: 0, error: reason };
      });
  }

  // Fold sessions into the cache when they are newer than its copy. `known`
  // marks them as already in the backend (a refresh); otherwise they flush.
  function fold(list, known) {
    var byId = new Map();
    state.cache.forEach(function (s) { byId.set(s.id, s); });
    var changed = false;
    list.forEach(function (s) {
      var current = byId.get(s.id);
      if (current && updatedAtOf(current) >= updatedAtOf(s)) return;
      byId.set(s.id, s);
      if (known) state.flushed.set(s.id, signature(s));
      changed = true;
    });
    if (changed) state.cache = byRecency(Array.from(byId.values())).slice(0, MAX_SESSIONS);
    return changed;
  }

  /**
   * Another window (the Quick window is its own webview, with its own copy of
   * this module) wrote to the store: read the backend again and take what is
   * newer. Nothing is deleted -- a refresh never loses a chat.
   */
  function refresh() {
    if (state.mode !== 'shell' || !state.backend) return Promise.resolve(false);
    return Promise.resolve(state.backend.list()).then(function (stored) {
      var changed = fold((Array.isArray(stored) ? stored : []).filter(isStoredSession), true);
      if (changed) announce();
      return changed;
    }, function () { return false; });
  }

  /**
   * Chats a window left in localStorage for this one (handOff below). The
   * 'storage' event is synchronous and in order, so a hand-off's chat is in
   * the cache before the event that asks to open it is handled.
   */
  function absorb() {
    if (state.mode !== 'shell') return false;
    var target = legacyStorage();
    var inbox = readLocal(target, INBOX_KEY);
    if (!inbox.length) return false;
    var changed = fold(inbox, false);
    removeLocal(target, INBOX_KEY);
    if (changed) {
      scheduleFlush();
      announce();
    }
    return changed;
  }

  function onStorage(event) {
    if (event && event.key === INBOX_KEY && event.newValue) absorb();
  }

  /**
   * Save a chat made in another window (the Quick window's "Continue in
   * NeuraOS") so the main window has it at once. Under the shell it goes to
   * this window's store AND to the localStorage inbox, which the main window
   * absorbs on the 'storage' event; without the shell, localStorage is the
   * store, as before.
   */
  function handOff(session) {
    if (!isStoredSession(session)) return false;
    var rest = function (list) { return list.filter(function (s) { return s.id !== session.id; }); };
    if (state.mode !== 'shell') return writeStore(null, [session].concat(rest(readStore())));
    writeStore(null, [session].concat(rest(state.cache)));
    var target = legacyStorage();
    return writeLocal(target, [session].concat(rest(readLocal(target, INBOX_KEY))), INBOX_KEY).ok;
  }

  // The window is going away (reload, close, the tray Quit tearing the
  // webview down): send what the 400 ms debounce is still holding. A page
  // cannot hold its own unload open for a promise, so this starts the write
  // and hopes; the tray Quit waits for it properly (onAppQuitting in App.tsx,
  // quit_ready in main.rs).
  function onLeave() {
    flush().catch(function () { /* flush reports through onNotice */ });
  }

  function listen(on) {
    var scope = typeof globalThis !== 'undefined' ? globalThis : {};
    var method = on ? 'addEventListener' : 'removeEventListener';
    if (typeof scope[method] !== 'function') return;
    scope[method]('storage', onStorage);
    scope[method]('pagehide', onLeave);
    scope[method]('beforeunload', onLeave);
  }

  // ---- an unreadable store (NEURA-022) ----------------------------------------
  //
  // The key is gone from the credential store, or it no longer opens the rows
  // that are there. Falling back to localStorage quietly would leave the person
  // with an empty history and no idea why, so the store says so once and offers
  // two ways on. Neither deletes anything: "start fresh" renames the old file
  // (chat_store_set_aside) and makes a new key; "keep browser storage" changes
  // nothing and asks again next launch.
  var UNREADABLE = 'chat-key-unreadable';
  var RECOVERY_ACTIONS = [
    { id: 'start-fresh', label: 'Start fresh (keep the old file)' },
    { id: 'keep-local', label: 'Keep using browser storage for now' },
  ];

  /**
   * What to tell the person about a failure to open the store: a recovery
   * notice with its two actions when the key cannot open existing chats, or
   * null for any other failure (those keep the plain one-line notice).
   */
  function recoveryFor(error) {
    if (!error || error.code !== UNREADABLE) return null;
    var rows = Number(error.rows) > 0 ? Number(error.rows) : 0;
    var why = error.reason === 'missing'
      ? 'The key that opens your saved chats is missing from the system credential store'
      : 'The key in the system credential store does not open your saved chats';
    return {
      reason: error.reason || 'unusable',
      rows: rows,
      text: why + (rows ? ' (' + rows + ' saved chat' + (rows === 1 ? '' : 's') + ')' : '') + '. '
        + 'Nothing has been deleted. Start fresh sets the old file aside as chats.unreadable-<time>.sqlite3 '
        + 'and begins a new encrypted history; or keep using browser storage for now.',
      actions: RECOVERY_ACTIONS.slice(),
    };
  }

  /** The pending recovery notice, or null. */
  function recovery() {
    return state.recovery;
  }

  /**
   * Answer the recovery notice. 'keep-local' leaves everything as it is.
   * 'start-fresh' needs options.setAside (renames the old file; resolves with
   * its new name) and options.backend (as for hydrate, making a new key); it
   * sets the file aside, then hydrates into the new store, moving the chats
   * written to localStorage meanwhile across. A failed set-aside keeps the
   * notice and the localStorage history as they were.
   */
  function recover(choice, options) {
    var opts = options || {};
    if (!state.recovery) return Promise.resolve({ mode: state.mode, migrated: 0, choice: choice, done: false });
    if (choice === 'keep-local') {
      state.recovery = null;
      return Promise.resolve({ mode: 'local', migrated: 0, choice: choice, done: true });
    }
    if (choice !== 'start-fresh') return Promise.reject(new Error('unknown recovery choice: ' + choice));
    if (typeof opts.setAside !== 'function' || !opts.backend) {
      return Promise.reject(new Error('starting fresh needs setAside and backend'));
    }
    return Promise.resolve()
      .then(function () { return opts.setAside(); })
      .then(function (movedTo) {
        state.recovery = null;
        state.hydrating = null;
        // A new store is a new story: its failures deserve their own notice.
        state.noticed = false;
        return hydrate(opts.backend).then(function (result) {
          var out = { mode: result.mode, migrated: result.migrated, choice: choice, done: true, movedTo: movedTo || '' };
          if (result.error) out.error = result.error;
          return out;
        });
      });
  }

  /** Back to the plain localStorage store, forgetting the backend (tests). */
  function detach() {
    listen(false);
    if (state.timer) clearTimeout(state.timer);
    state.mode = 'local';
    state.backend = null;
    state.storage = null;
    state.cache = [];
    state.flushed = new Map();
    state.seen = new WeakMap();
    state.timer = null;
    state.flushing = null;
    state.hydrating = null;
    state.dirty = false;
    state.delay = DEFAULT_FLUSH_DELAY;
    state.onNotice = null;
    state.noticed = false;
    state.onRecovery = null;
    state.recovery = null;
  }

  function removeLocal(target, key) {
    if (!target) return;
    var name = key || STORE_KEY;
    try {
      if (typeof target.removeItem === 'function') target.removeItem(name);
      else target.setItem(name, '[]');
    } catch { /* the backend has the chats; a stale copy is merged next boot */ }
  }

  // readStore/writeStore: an explicit storage is always that storage (the
  // tests, and anything that really means localStorage). With none, the
  // active home answers.
  function readStore(storage) {
    if (!storage && state.mode === 'shell') return state.cache.slice();
    return readLocal(storage ? storage : legacyStorage());
  }

  function readLocal(storage, key) {
    var target = store(storage);
    if (!target) return [];
    try {
      var raw = target.getItem(key || STORE_KEY);
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
  //
  // localStorage refuses a write that would exceed its quota (5-10 MB in
  // WebView2) by throwing, and the old code answered that by keeping nothing
  // -- every new message after the quota was silently lost. Now the tail (the
  // oldest sessions; the screen prepends the newest) is dropped a slice at a
  // time until the write fits. `dropped` says how many were lost so the
  // screen can tell the user, rather than letting history vanish quietly.
  function writeStore(storage, sessions) {
    return writeStoreReport(storage, sessions).ok;
  }

  function writeStoreReport(storage, sessions) {
    if (!storage && state.mode === 'shell') {
      // The cache is the truth now; the backend catches up on the next flush.
      // No quota here -- only the session cap.
      var rows = (Array.isArray(sessions) ? sessions : []).filter(isStoredSession);
      var kept = rows.slice(0, MAX_SESSIONS);
      state.cache = kept;
      scheduleFlush();
      return { ok: true, kept: kept.length, dropped: rows.length - kept.length, quota: false };
    }
    return writeLocal(storage ? storage : legacyStorage(), sessions);
  }

  function writeLocal(storage, sessions, key) {
    var target = store(storage);
    if (!target) return { ok: false, kept: 0, dropped: 0, quota: false };
    var rows = (Array.isArray(sessions) ? sessions : []).filter(isStoredSession).slice(0, MAX_SESSIONS);
    var quota = false;
    var keep = rows.length;
    while (keep > 0 || rows.length === 0) {
      try {
        target.setItem(key || STORE_KEY, JSON.stringify(rows.slice(0, keep)));
        return { ok: true, kept: keep, dropped: rows.length - keep, quota: quota };
      } catch {
        if (keep === 0) break;
        quota = true;
        // Halve, but never below one fewer than now, so the newest session
        // always gets its chance to be written alone.
        keep = Math.min(keep - 1, Math.floor(keep / 2));
      }
    }
    // Nothing fits, not even the newest session alone. The store is left as it
    // was: an empty list written here would be the loss this function exists
    // to prevent.
    return { ok: false, kept: 0, dropped: rows.length, quota: quota };
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
    writeStoreReport: writeStoreReport,
    hydrate: hydrate,
    flush: flush,
    refresh: refresh,
    absorb: absorb,
    handOff: handOff,
    persistent: persistent,
    detach: detach,
    UNREADABLE: UNREADABLE,
    recoveryFor: recoveryFor,
    recovery: recovery,
    recover: recover,
    byRecency: byRecency,
    isChatSession: isChatSession,
    updatedAtOf: updatedAtOf,
    sanitize: sanitize,
    merge: merge,
    summary: summary,
    downloadJson: downloadJson,
  };
});
