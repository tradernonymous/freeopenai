// NEURA-054 -- bring your own key: an OpenAI-shaped endpoint the user adds.
//
// A person pastes three things in the model picker: a base URL, a model id and
// an API key. The first two are theirs to see and to edit; the third is not
// data this app keeps. It goes straight to the OS credential store through the
// shell (src-tauri/src/secrets.rs) under the name `byok.<id>`, and from that
// moment the page never holds it again:
//
//   * nothing here ever returns, caches or stores a key -- there is no `key`
//     field on a stored endpoint, and `secretName(id)` is the only thing this
//     module knows about one;
//   * the request is issued in RUST (src-tauri/src/byok.rs), which reads the
//     secret itself and sets the Authorization header there, so the key does
//     not cross back into the webview to be sent;
//   * a key is never put in a URL, so a base URL carrying a query string or
//     userinfo is refused rather than quietly cleaned up;
//   * a refusal always says why: these are the user's own credentials, and
//     "invalid" is not something anybody can act on.
//
// WHY THE CALL GOES THROUGH RUST AT ALL (the net.rs rule)
//
// src-tauri/src/net.rs states the network edge in one sentence: https only on
// an explicit host allowlist, http only on loopback, re-checked on every
// redirect hop. A BYOK host is by definition NOT on that allowlist -- the user
// invents it -- and `ollama::shell_chat_stream` is loopback-only, so neither
// existing door fits. The frontend cannot take the other route and fetch() the
// endpoint from the page either, because that is exactly the path that would
// need the key in the page. So NEURA-054 adds one narrow door beside them: a
// command that takes the base URL the user configured, applies the same scheme
// rule (https, or http only for a runtime on this machine), follows no
// redirects at all (a redirect off the configured origin would carry the
// Authorization header somewhere the user never named), and injects the key
// from the credential store on the Rust side.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global (published unconditionally -- see chats.js).
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UByok = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var STORE_KEY = 'freeai4u.byok_endpoints';
  var CHANGED_EVENT = 'freeai4u:byok-changed';
  var PROVIDER_ID = 'byok';
  var PROVIDER_LABEL = 'My endpoints';
  /** The prefix secrets.rs allows for a per-endpoint key. */
  var SECRET_PREFIX = 'byok.';

  // ---- storage --------------------------------------------------------------

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

  /** The credential-store name for an endpoint's key. Must match secrets.rs. */
  function secretName(id) {
    return SECRET_PREFIX + String(id || '');
  }

  // ---- what may be typed ----------------------------------------------------

  function hostOf(url) {
    var value = String(url == null ? '' : url);
    var at = value.indexOf('://');
    if (at <= 0) return '';
    var authority = value.slice(at + 3).split(/[/?#]/)[0];
    var creds = authority.lastIndexOf('@');
    if (creds >= 0) authority = authority.slice(creds + 1);
    var host;
    if (authority.charAt(0) === '[') {
      var end = authority.indexOf(']');
      host = end < 0 ? '' : authority.slice(0, end + 1);
    } else {
      host = authority.split(':')[0];
    }
    return host.trim().toLowerCase();
  }

  function isLoopback(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  }

  /**
   * validateBaseUrl(raw) -> { ok, url, reason }
   *
   * The same scheme rule net.rs enforces, checked here first so a refusal is a
   * sentence in the panel instead of an error string from the shell. The Rust
   * side checks it again -- this copy is for the person, not for safety.
   */
  function validateBaseUrl(raw) {
    var value = String(raw == null ? '' : raw).trim();
    if (!value) return { ok: false, url: '', reason: 'Give the endpoint’s base URL, like https://api.example.com/v1.' };
    var at = value.indexOf('://');
    if (at <= 0) {
      return { ok: false, url: '', reason: 'That is not a full address. Start it with https:// (or http:// for a runtime on this machine).' };
    }
    var scheme = value.slice(0, at).toLowerCase();
    var rest = value.slice(at + 3);
    if (!rest) return { ok: false, url: '', reason: 'That address has no host.' };
    var authority = rest.split(/[/?#]/)[0];
    if (authority.indexOf('@') >= 0) {
      return { ok: false, url: '', reason: 'Leave the user:password out of the URL — the key is stored in the operating system, never in an address.' };
    }
    var host = hostOf(value);
    if (!host) return { ok: false, url: '', reason: 'That address has no host.' };
    if (scheme === 'http') {
      if (!isLoopback(host)) {
        return {
          ok: false,
          url: '',
          reason: 'http is refused for ' + host + ': the key would cross the network in clear text. Use https, or a runtime on 127.0.0.1.',
        };
      }
    } else if (scheme !== 'https') {
      return { ok: false, url: '', reason: scheme + ':// is not an endpoint this app calls. Use https (or http on 127.0.0.1).' };
    }
    if (value.indexOf('?') >= 0 || value.indexOf('#') >= 0) {
      return { ok: false, url: '', reason: 'Give the base URL only — no query string. A key must never travel in a URL.' };
    }
    return { ok: true, url: value.replace(/\/+$/, ''), reason: '' };
  }

  /** The one URL a chat turn goes to for this endpoint. */
  function chatUrl(baseUrl) {
    return String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  }

  /**
   * validateKey(raw) -> { ok, reason }
   *
   * Only the shape a header can carry: a key with a space or a control
   * character in it is a paste that went wrong, and it would come back as an
   * unreadable 401 an hour later.
   */
  function validateKey(raw) {
    var value = String(raw == null ? '' : raw);
    if (!value.trim()) return { ok: false, reason: 'Paste the API key. It is stored in this computer’s credential manager, not in the app.' };
    if (value !== value.trim()) return { ok: false, reason: 'The key has a space at one end — paste it again without it.' };
    if (/[\s\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: 'That key has a space or a line break in it, which no HTTP header can carry.' };
    return { ok: true, reason: '' };
  }

  /** An id made only of the characters secrets.rs allows, unique in `taken`. */
  function idFor(baseUrl, model, taken) {
    var seed = (hostOf(baseUrl) + '-' + String(model || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    var base = (seed || 'endpoint').slice(0, 48);
    var id = base;
    var n = 2;
    var used = taken || [];
    while (used.indexOf(id) >= 0) {
      id = base + '-' + n;
      n += 1;
    }
    return id;
  }

  // What may be stored. Note what is NOT here: there is no key field, and an
  // entry that somehow carries one is not repaired -- it is dropped, so a
  // hand-edited localStorage cannot make the page hold a credential.
  function valid(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.id !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(entry.id)) return false;
    if (typeof entry.model !== 'string' || !entry.model.trim()) return false;
    if (!validateBaseUrl(entry.baseUrl).ok) return false;
    if ('key' in entry || 'apiKey' in entry || 'token' in entry) return false;
    return true;
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
   * add({ label, baseUrl, model }) -> { ok, entry, reason }
   *
   * The key is NOT a field of this call. Storing one is saveKey() below, which
   * hands it to the shell and keeps nothing.
   */
  function add(entry, given) {
    var e = entry || {};
    var base = validateBaseUrl(e.baseUrl);
    if (!base.ok) return { ok: false, entry: null, reason: base.reason };
    var model = String(e.model || '').trim();
    if (!model) return { ok: false, entry: null, reason: 'Give the model id the endpoint expects, like gpt-4o-mini.' };
    var rows = list(given);
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].baseUrl === base.url && rows[i].model === model) {
        return { ok: false, entry: rows[i], reason: 'That endpoint and model are already in your list.' };
      }
    }
    var row = {
      id: idFor(base.url, model, rows.map(function (r) { return r.id; })),
      label: String(e.label || '').trim() || hostOf(base.url),
      baseUrl: base.url,
      model: model,
      addedAt: Number(e.addedAt) || Date.now(),
    };
    if (!valid(row)) return { ok: false, entry: null, reason: 'That endpoint is not one this app can keep.' };
    rows.push(row);
    return { ok: write(given, rows), entry: row, reason: '' };
  }

  function find(id, given) {
    var rows = list(given);
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].id === id) return rows[i];
    }
    return null;
  }

  /** The saved endpoint behind a (provider, model) pick, or null. */
  function findByModel(providerId, model, given) {
    if (providerId !== PROVIDER_ID) return null;
    var rows = list(given);
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].model === model) return rows[i];
    }
    return null;
  }

  /**
   * saveKey(id, key, shell) -> Promise<{ ok, reason }>
   *
   * `shell` is bridge.ts's { secretSet }. The key goes from the input straight
   * to the credential store; this function returns nothing that contains it and
   * holds no reference once it resolves.
   */
  async function saveKey(id, key, shell) {
    var check = validateKey(key);
    if (!check.ok) return { ok: false, reason: check.reason };
    if (!shell || typeof shell.secretSet !== 'function') {
      return { ok: false, reason: 'A key can only be stored by the installed desktop app, which has the credential manager.' };
    }
    try {
      await shell.secretSet(secretName(id), String(key));
      return { ok: true, reason: '' };
    } catch (err) {
      return { ok: false, reason: 'The credential manager refused the key: ' + ((err && err.message) || err) };
    }
  }

  /**
   * remove(id, shell) -> Promise<{ ok, reason }>
   *
   * Deleting an endpoint deletes its key. The secret goes FIRST: an entry gone
   * from the list while its key is still in the credential store is a
   * credential nobody can see to remove.
   */
  async function remove(id, shell, given) {
    var entry = find(id, given);
    if (!entry) return { ok: false, reason: 'That endpoint is not in your list.' };
    if (shell && typeof shell.secretDelete === 'function') {
      try {
        await shell.secretDelete(secretName(id));
      } catch (err) {
        return { ok: false, reason: 'The key could not be removed from the credential manager, so the endpoint was kept: ' + ((err && err.message) || err) };
      }
    }
    var rows = list(given).filter(function (r) { return r.id !== id; });
    return { ok: write(given, rows), reason: '' };
  }

  // ---- the picker's rows ----------------------------------------------------

  /** One provider row, only when there is at least one endpoint. */
  function providerRow(given) {
    var rows = list(given);
    if (!rows.length) return null;
    return {
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      configured: true,
      kind: 'chat',
      freeTier: { text: 'your own key · billed by the service' },
    };
  }

  function modelsFor(providerId, given) {
    if (providerId !== PROVIDER_ID) return [];
    return list(given).map(function (r) {
      return { id: r.model, free: r.label };
    });
  }

  // ---- talking to it --------------------------------------------------------

  /** What a non-2xx answer means, in words worth acting on. */
  function explain(status, body) {
    var text = String(body || '').slice(0, 200);
    if (status === 401 || status === 403) {
      return 'The endpoint refused the key (' + status + '). Remove it in the picker and add the key again.';
    }
    if (status === 404) {
      return 'The endpoint has no /chat/completions there (404). Check the base URL — most services want it to end in /v1.';
    }
    if (status === 429) return 'The endpoint is rate-limiting this key (429). Wait, or use another endpoint.';
    return 'The endpoint answered ' + status + ': ' + text;
  }

  /** One SSE `data:` payload, as a frame. Returns null for one to ignore. */
  function frameOf(payload) {
    if (!payload) return null;
    if (payload === '[DONE]') return { done: true };
    var row;
    try {
      row = JSON.parse(payload);
    } catch {
      return null;
    }
    if (row && row.error) {
      throw new Error(typeof row.error === 'string' ? row.error : (row.error.message || 'the endpoint reported an error'));
    }
    var delta = row && row.choices && row.choices[0] && row.choices[0].delta;
    var text = delta && typeof delta.content === 'string' ? delta.content : undefined;
    var called = delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length ? delta.tool_calls : undefined;
    if (!text && !called) return null;
    var out = { content: text, model: row.model };
    if (called) out.toolCalls = called;
    return out;
  }

  /**
   * streamChat(entry, messages, onFrame, signal, shell, tools)
   *
   * `shell` is bridge.ts's { byokStream }. Note what is NOT passed: a key. The
   * page hands over the endpoint's secret NAME and the shell reads the value
   * itself (src-tauri/src/byok.rs).
   */
  async function streamChat(entry, messages, onFrame, signal, shell, tools) {
    if (!entry) throw new Error('That endpoint is no longer in your list. Add it again in the model picker.');
    var base = validateBaseUrl(entry.baseUrl);
    if (!base.ok) throw new Error(base.reason);
    if (!shell || typeof shell.byokStream !== 'function') {
      throw new Error('Your own endpoints are called by the installed desktop app, which holds the key.');
    }
    var body = JSON.stringify(Object.assign(
      { model: entry.model, messages: messages, stream: true },
      tools && tools.length ? { tools: tools } : {},
    ));
    var status = 200;
    var failure = '';
    var buffer = '';
    var drain = function (final) {
      var idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (status >= 400) { failure += line; continue; }
        if (line.indexOf('data:') !== 0) continue;
        var frame = frameOf(line.slice(5).trim());
        if (frame) onFrame(frame);
      }
      if (final && buffer) {
        if (status >= 400) failure += buffer;
        buffer = '';
      }
    };
    await shell.byokStream(
      { secret: secretName(entry.id), base: base.url, body: body },
      function (chunk) { buffer += chunk; drain(false); },
      function (code) { status = code; },
      signal,
    );
    drain(true);
    if (status >= 400) {
      var message = failure.slice(0, 300);
      try {
        var parsed = JSON.parse(failure);
        message = (parsed && parsed.error && (parsed.error.message || parsed.error)) || message;
      } catch { /* as it came */ }
      throw new Error(explain(status, message));
    }
  }

  return {
    STORE_KEY: STORE_KEY,
    CHANGED_EVENT: CHANGED_EVENT,
    PROVIDER_ID: PROVIDER_ID,
    PROVIDER_LABEL: PROVIDER_LABEL,
    SECRET_PREFIX: SECRET_PREFIX,
    secretName: secretName,
    validateBaseUrl: validateBaseUrl,
    validateKey: validateKey,
    chatUrl: chatUrl,
    idFor: idFor,
    list: list,
    add: add,
    find: find,
    findByModel: findByModel,
    saveKey: saveKey,
    remove: remove,
    providerRow: providerRow,
    modelsFor: modelsFor,
    explain: explain,
    frameOf: frameOf,
    streamChat: streamChat,
  };
});
