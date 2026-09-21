// Every app-wide shortcut, and the one function that decides what a key press
// means.
//
// App.tsx used to carry two keydown listeners with their own ideas of order
// (Zen in one, Ctrl+K / Esc / Alt+N in another). Here it is a table and a
// resolver: resolveKey(state, event) -> action id or null. Being pure, it is
// node-tested, and the same table drives the conflict check, the Settings list
// and the "shortcuts off" switch.
//
// UMD like the repo's other shared modules (see chats.js for the shape).
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UKeymap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var OVERRIDES_KEY = 'freeai4u.keymap';
  var OFF_KEY = 'freeai4u.shortcuts_off';

  // `when`: 'always' fires even with shortcuts switched off and inside the
  // palette (the ways out must never be remappable into a trap); 'app' is
  // everything else. Order is priority: the first matching row wins.
  var BINDINGS = [
    { id: 'palette', keys: 'Ctrl+K', label: 'Command palette', when: 'always' },
    { id: 'escape', keys: 'Escape', label: 'Close the palette or menu', when: 'always', fixed: true },
    { id: 'zen', keys: 'Ctrl+Shift+Z', label: 'Zen mode', when: 'always' },
    { id: 'new-chat', keys: 'Ctrl+N', label: 'New chat', when: 'app' },
    { id: 'model', keys: 'Ctrl+M', label: 'Pick the model', when: 'app' },
    { id: 'tool-cards', keys: 'Ctrl+T', label: 'Open or fold every tool card', when: 'app' },
    { id: 'history', keys: 'Ctrl+H', label: 'History panel', when: 'app' },
    { id: 'terminal', keys: 'Ctrl+`', label: 'Terminal dock', when: 'app' },
  ];

  var MODIFIERS = ['Ctrl', 'Alt', 'Shift'];

  function storage() {
    try {
      return (typeof globalThis !== 'undefined' && globalThis.localStorage) || null;
    } catch (e) {
      return null;
    }
  }

  /** 'ctrl+shift+z' / 'Shift+Ctrl+Z' -> 'Ctrl+Shift+Z'. */
  function normalise(combo) {
    var parts = String(combo || '').split('+').map(function (p) { return p.trim(); }).filter(Boolean);
    var mods = [];
    var key = '';
    for (var i = 0; i < parts.length; i += 1) {
      var p = parts[i];
      var lower = p.toLowerCase();
      if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'meta') mods.push('Ctrl');
      else if (lower === 'alt' || lower === 'option') mods.push('Alt');
      else if (lower === 'shift') mods.push('Shift');
      else key = p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    }
    var ordered = MODIFIERS.filter(function (m) { return mods.indexOf(m) >= 0; });
    return ordered.concat(key ? [key] : []).join('+');
  }

  /** A KeyboardEvent (or anything shaped like one) as a combo string. */
  function comboOf(event) {
    if (!event) return '';
    var key = String(event.key || '');
    if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return '';
    var parts = [];
    if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    // Shift+z arrives as key 'Z'; one spelling for letters either way.
    parts.push(key.length === 1 ? key.toUpperCase() : key);
    return parts.join('+');
  }

  function readOverrides(store) {
    var s = store || storage();
    if (!s) return {};
    try {
      var raw = JSON.parse(s.getItem(OVERRIDES_KEY) || '{}');
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
      return {};
    }
  }

  /** The table with the person's remaps applied; fixed rows keep their keys. */
  function withOverrides(overrides) {
    var o = overrides || {};
    return BINDINGS.map(function (b) {
      var wanted = typeof o[b.id] === 'string' && !b.fixed ? normalise(o[b.id]) : '';
      return wanted ? Object.assign({}, b, { keys: wanted, custom: true }) : b;
    });
  }

  function setOverride(id, combo, store) {
    var s = store || storage();
    var current = readOverrides(s);
    if (combo) current[id] = normalise(combo);
    else delete current[id];
    if (s) {
      try { s.setItem(OVERRIDES_KEY, JSON.stringify(current)); } catch (e) { /* the session still has it */ }
    }
    return current;
  }

  function enabled(store) {
    var s = store || storage();
    if (!s) return true;
    try { return s.getItem(OFF_KEY) !== '1'; } catch (e) { return true; }
  }

  function setEnabled(on, store) {
    var s = store || storage();
    if (!s) return;
    try {
      if (on) s.removeItem(OFF_KEY);
      else s.setItem(OFF_KEY, '1');
    } catch (e) { /* best effort */ }
  }

  /**
   * Two actions on one combo, and an app action on a key typing needs (a bare
   * letter), are both reported. Alt+1..5 belong to navigation, which is the
   * caller's list, so it is passed in as `reserved`.
   */
  function conflicts(bindings, reserved) {
    var seen = {};
    var out = [];
    var list = (bindings || BINDINGS).slice();
    (reserved || []).forEach(function (r) { list.push({ id: r.id, keys: r.keys, reserved: true }); });
    list.forEach(function (b) {
      var k = normalise(b.keys);
      if (!k) return;
      if (seen[k]) out.push({ keys: k, ids: [seen[k], b.id] });
      else seen[k] = b.id;
      if (!b.reserved && k.indexOf('+') < 0 && k.length === 1) out.push({ keys: k, ids: [b.id], reason: 'a bare key would fire while typing' });
    });
    return out;
  }

  /**
   * What a key press means right now, or null.
   * state: { enabled, paletteOpen, bindings?, nav?: (event) => destination|null }
   * Returns { action } or { action: 'nav', to }.
   */
  function resolveKey(state, event) {
    var st = state || {};
    var combo = comboOf(event);
    if (!combo) return null;
    var table = st.bindings || BINDINGS;
    var on = st.enabled !== false;
    for (var i = 0; i < table.length; i += 1) {
      var b = table[i];
      if (normalise(b.keys) !== combo) continue;
      if (b.when !== 'always' && (!on || st.paletteOpen)) return null;
      return { action: b.id };
    }
    if (!on || st.paletteOpen) return null;
    if (typeof st.nav === 'function' && event.altKey && !event.ctrlKey && !event.metaKey) {
      var to = st.nav(event);
      if (to) return { action: 'nav', to: to };
    }
    return null;
  }

  return {
    BINDINGS: BINDINGS,
    OVERRIDES_KEY: OVERRIDES_KEY,
    OFF_KEY: OFF_KEY,
    normalise: normalise,
    comboOf: comboOf,
    readOverrides: readOverrides,
    withOverrides: withOverrides,
    setOverride: setOverride,
    enabled: enabled,
    setEnabled: setEnabled,
    conflicts: conflicts,
    resolveKey: resolveKey,
  };
});
