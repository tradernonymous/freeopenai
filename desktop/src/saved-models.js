// My models: the local models a person chose to keep in the pickers.
//
// Two kinds, because two different programs run them:
//
//   * 'ollama'  -- a model Ollama has, reached through Ollama's own server
//     (http://127.0.0.1:11434). Ollama runs everything it lists, including its
//     own engine formats llama-server cannot load, so nothing here can turn
//     out "unsupported". Identified by its Ollama name (`deepseek-r1:latest`).
//   * 'unsloth' -- a GGUF file in a folder the person pointed at (Unsloth
//     Studio's, the Hugging Face cache, anywhere). Run by llama-server with
//     `-m <path>`; identified by its path.
//
// Adding a model copies nothing: it remembers a name or a path. The pickers in
// Chat, Design and Code then show two providers, "Ollama Local" and "Unsloth
// Local", holding exactly the models that were added -- and no provider at all
// for a kind with nothing in it.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global (published unconditionally -- see chats.js).
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4USavedModels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var STORE_KEY = 'freeai4u.saved_models';
  var FOLDERS_KEY = 'freeai4u.model_folders';
  var CHANGED_EVENT = 'freeai4u:saved-models-changed';
  var OLLAMA_BASE = 'http://127.0.0.1:11434';

  var PROVIDERS = {
    ollama: { id: 'ollama-local', label: 'Ollama Local', note: 'runs in Ollama on this PC' },
    unsloth: { id: 'unsloth-local', label: 'Unsloth Local', note: 'GGUF on this PC · llama-server' },
  };

  function storage(given) {
    if (given) return given;
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : {};
      return scope.localStorage || null;
    } catch {
      return null;
    }
  }

  function announce() {
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : null;
      if (scope && typeof scope.dispatchEvent === 'function' && typeof scope.Event === 'function') {
        scope.dispatchEvent(new scope.Event(CHANGED_EVENT));
      }
    } catch { /* a listener is a convenience */ }
  }

  function kindOf(providerId) {
    if (providerId === PROVIDERS.ollama.id) return 'ollama';
    if (providerId === PROVIDERS.unsloth.id) return 'unsloth';
    return '';
  }

  function isSavedProvider(providerId) {
    return !!kindOf(providerId);
  }

  /** The file name of a path, without the extension: what a person calls it. */
  function nameFromPath(path) {
    var base = String(path || '').split(/[\\/]/).pop() || '';
    return base.replace(/\.gguf$/i, '');
  }

  // What may be stored. An entry from an older build, or a hand-edited one,
  // is dropped rather than rendered wrong.
  function valid(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.kind !== 'ollama' && entry.kind !== 'unsloth') return false;
    if (typeof entry.name !== 'string' || !entry.name.trim()) return false;
    if (entry.kind === 'unsloth' && (typeof entry.path !== 'string' || !/\.gguf$/i.test(entry.path))) return false;
    return true;
  }

  function idFor(kind, nameOrPath) {
    return kind + ':' + String(nameOrPath || '').trim();
  }

  function list(given) {
    var target = storage(given);
    if (!target) return [];
    try {
      var parsed = JSON.parse(target.getItem(STORE_KEY) || '[]');
      return (Array.isArray(parsed) ? parsed : []).filter(valid);
    } catch {
      return [];
    }
  }

  function write(given, rows) {
    var target = storage(given);
    if (!target) return false;
    try {
      target.setItem(STORE_KEY, JSON.stringify(rows));
      announce();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * add(entry) -> { ok, added, entry, reason }
   *
   * `entry` is { kind, name, path?, base?, bytes?, detail? }. Adding the same
   * model twice is not an error: it says so and changes nothing.
   */
  function add(entry, given) {
    var e = entry || {};
    var kind = e.kind;
    var row = {
      kind: kind,
      name: String(e.name || (kind === 'unsloth' ? nameFromPath(e.path) : '')).trim(),
      path: kind === 'unsloth' ? String(e.path || '') : '',
      base: kind === 'ollama' ? String(e.base || OLLAMA_BASE) : '',
      bytes: Number(e.bytes || 0) || 0,
      detail: String(e.detail || ''),
      addedAt: Number(e.addedAt) || Date.now(),
    };
    row.id = idFor(kind, kind === 'unsloth' ? row.path : row.name);
    if (!valid(row)) return { ok: false, added: false, entry: null, reason: 'That is not a model this app can keep.' };
    var rows = list(given);
    if (rows.some(function (r) { return r.id === row.id; })) {
      return { ok: true, added: false, entry: row, reason: 'Already in your models.' };
    }
    rows.push(row);
    return { ok: write(given, rows), added: true, entry: row, reason: '' };
  }

  function remove(id, given) {
    var rows = list(given);
    var next = rows.filter(function (r) { return r.id !== id; });
    if (next.length === rows.length) return false;
    return write(given, next);
  }

  function has(id, given) {
    return list(given).some(function (r) { return r.id === id; });
  }

  /** The provider rows the pickers show: one per kind that has a model. */
  function providerRows(given) {
    var rows = list(given);
    return ['ollama', 'unsloth']
      .filter(function (kind) { return rows.some(function (r) { return r.kind === kind; }); })
      .map(function (kind) {
        return {
          id: PROVIDERS[kind].id,
          label: PROVIDERS[kind].label,
          configured: true,
          kind: 'chat',
          local: true,
          freeTier: { text: PROVIDERS[kind].note },
        };
      });
  }

  /** The models under one of those providers, in the picker's shape. */
  function modelsFor(providerId, given) {
    var kind = kindOf(providerId);
    if (!kind) return [];
    return list(given)
      .filter(function (r) { return r.kind === kind; })
      .map(function (r) {
        var size = r.bytes ? (r.bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB' : '';
        return { id: r.name, free: [size, r.detail].filter(Boolean).join(' · ') || PROVIDERS[kind].note };
      });
  }

  /** The saved entry behind a (provider, model) pick, or null. */
  function find(providerId, modelName, given) {
    var kind = kindOf(providerId);
    if (!kind) return null;
    var rows = list(given);
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].kind === kind && rows[i].name === modelName) return rows[i];
    }
    return null;
  }

  // ---- what Ollama reports, in the card's shape -----------------------------

  /** `GET /api/tags` -> [{ name, bytes, detail }], biggest last like Ollama. */
  function fromOllamaTags(body) {
    var models = body && Array.isArray(body.models) ? body.models : [];
    return models
      .map(function (m) {
        var d = (m && m.details) || {};
        return {
          name: String((m && (m.name || m.model)) || ''),
          bytes: Number(m && m.size) || 0,
          detail: [d.parameter_size, d.quantization_level].filter(Boolean).join(' · '),
        };
      })
      .filter(function (m) { return m.name; });
  }

  // ---- where the person last looked -----------------------------------------

  function folders(given) {
    var target = storage(given);
    var out = { ollama: OLLAMA_BASE, unsloth: '' };
    if (!target) return out;
    try {
      var parsed = JSON.parse(target.getItem(FOLDERS_KEY) || '{}');
      if (parsed && typeof parsed.ollama === 'string' && parsed.ollama) out.ollama = parsed.ollama;
      if (parsed && typeof parsed.unsloth === 'string') out.unsloth = parsed.unsloth;
    } catch { /* defaults */ }
    return out;
  }

  function setFolder(kind, value, given) {
    var target = storage(given);
    if (!target || (kind !== 'ollama' && kind !== 'unsloth')) return false;
    var next = folders(given);
    next[kind] = String(value || '');
    try {
      target.setItem(FOLDERS_KEY, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  }

  return {
    STORE_KEY: STORE_KEY,
    FOLDERS_KEY: FOLDERS_KEY,
    CHANGED_EVENT: CHANGED_EVENT,
    OLLAMA_BASE: OLLAMA_BASE,
    PROVIDERS: PROVIDERS,
    kindOf: kindOf,
    isSavedProvider: isSavedProvider,
    nameFromPath: nameFromPath,
    idFor: idFor,
    list: list,
    add: add,
    remove: remove,
    has: has,
    providerRows: providerRows,
    modelsFor: modelsFor,
    find: find,
    fromOllamaTags: fromOllamaTags,
    folders: folders,
    setFolder: setFolder,
  };
});
