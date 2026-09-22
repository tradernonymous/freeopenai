// Chat history encryption at rest.
//
// The shell keeps chats in a SQLite file (src-tauri/src/chat_store.rs). That
// file sits in the user's profile, where a backup, a sync client or a copied
// folder can read it, so each chat is sealed before it leaves the page:
//
//   * AES-GCM with a 256-bit key, through WebCrypto (globalThis.crypto.subtle,
//     which the webview and node both have);
//   * a fresh random 12-byte IV for every chat, every write -- an IV reused
//     under one GCM key breaks it, so none is ever derived or counted;
//   * blob = base64(iv || ciphertext+tag). GCM's tag means a wrong key or a
//     damaged blob fails loudly instead of decrypting into garbage;
//   * the key is random, made once, and kept in the OS credential store (the
//     shell's chat_store_key_get / chat_store_key_set), never in the database
//     or in localStorage.
//
// Pure functions over injected storage and an injected `call`, so node:test
// runs them for real. UMD, published to the global unconditionally (see
// chats.js for why).
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UChatCrypto = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var IV_BYTES = 12;
  var ALGORITHM = 'AES-GCM';

  function scope() {
    return typeof globalThis !== 'undefined' ? globalThis : {};
  }

  function subtle() {
    var c = scope().crypto;
    if (!c || !c.subtle) throw new Error('this runtime has no WebCrypto');
    return c.subtle;
  }

  function randomBytes(n) {
    var bytes = new Uint8Array(n);
    scope().crypto.getRandomValues(bytes);
    return bytes;
  }

  // btoa/atob take "binary strings"; the conversion is chunked so a chat with
  // pictures in it (megabytes) does not overflow the argument limit.
  function toBase64(bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var parts = [];
    var CHUNK = 0x8000;
    for (var i = 0; i < view.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, view.subarray(i, i + CHUNK)));
    }
    return scope().btoa(parts.join(''));
  }

  function fromBase64(text) {
    var binary = scope().atob(String(text || ''));
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  function generateKey() {
    return subtle().generateKey({ name: ALGORITHM, length: 256 }, true, ['encrypt', 'decrypt']);
  }

  function exportKey(key) {
    return subtle().exportKey('raw', key).then(toBase64);
  }

  function importKey(base64) {
    var raw = fromBase64(base64);
    if (raw.length !== 32) return Promise.reject(new Error('the chat key is not a 256-bit key'));
    return subtle().importKey('raw', raw, { name: ALGORITHM }, false, ['encrypt', 'decrypt']);
  }

  /** text -> base64(iv || ciphertext), with a new IV every call. */
  function encrypt(key, text) {
    var iv = randomBytes(IV_BYTES);
    var data = new TextEncoder().encode(String(text));
    return subtle().encrypt({ name: ALGORITHM, iv: iv }, key, data).then(function (sealed) {
      var body = new Uint8Array(sealed);
      var out = new Uint8Array(iv.length + body.length);
      out.set(iv, 0);
      out.set(body, iv.length);
      return toBase64(out);
    });
  }

  /** The inverse of encrypt. Rejects on a wrong key or a damaged blob. */
  function decrypt(key, blob) {
    var bytes;
    try {
      bytes = fromBase64(blob);
    } catch {
      return Promise.reject(new Error('the stored chat is not base64'));
    }
    if (bytes.length <= IV_BYTES) return Promise.reject(new Error('the stored chat is too short'));
    var iv = bytes.subarray(0, IV_BYTES);
    var body = bytes.subarray(IV_BYTES);
    return subtle().decrypt({ name: ALGORITHM, iv: iv }, key, body).then(function (plain) {
      return new TextDecoder().decode(plain);
    });
  }

  /**
   * The key from the credential store, or a new one made and stored there.
   * `store` is { get(): Promise<string|null>, set(value): Promise<void> }.
   * A new key is read back before it is used: a key that did not persist would
   * seal chats that the next launch cannot open.
   */
  function loadOrCreateKey(store) {
    return Promise.resolve(store.get()).then(function (existing) {
      if (existing) return importKey(existing);
      return generateKey().then(exportKey).then(function (base64) {
        return Promise.resolve(store.set(base64))
          .then(function () { return store.get(); })
          .then(function (stored) {
            if (stored !== base64) throw new Error('the credential store did not keep the chat key');
            return importKey(base64);
          });
      });
    });
  }

  function rowTime(session) {
    var value = Math.floor(Number(session && session.updatedAt));
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /**
   * A chats.js backend (plain sessions in and out) over the shell's commands:
   * `call(command, args)` is bridge.call. Every session is encrypted on its
   * way out and decrypted on its way back.
   */
  function backend(options) {
    var call = options.call;
    var key = options.key;
    return {
      list: function () {
        return Promise.resolve(call('chat_store_list')).then(function (rows) {
          var list = Array.isArray(rows) ? rows : [];
          return Promise.all(list.map(function (row) {
            return decrypt(key, row && row.blob)
              .then(function (text) { return JSON.parse(text); })
              .catch(function () { return null; });
          })).then(function (sessions) {
            var opened = sessions.filter(Boolean);
            // Rows exist and not one of them opens: this is the wrong key (the
            // credential entry was lost or replaced), not a few damaged rows.
            // Say so rather than show an empty history over the real one.
            if (list.length && !opened.length) {
              throw new Error('the chat key does not open the stored chats');
            }
            return opened;
          });
        });
      },
      put: function (sessions) {
        return Promise.all((sessions || []).map(function (session) {
          return encrypt(key, JSON.stringify(session)).then(function (blob) {
            return { id: String(session.id), updated_at: rowTime(session), blob: blob };
          });
        })).then(function (rows) {
          if (!rows.length) return 0;
          return call('chat_store_put', { rows: rows });
        });
      },
      remove: function (ids) {
        if (!ids || !ids.length) return Promise.resolve(0);
        return Promise.resolve(call('chat_store_delete', { ids: ids }));
      },
      clear: function () {
        return Promise.resolve(call('chat_store_clear'));
      },
    };
  }

  return {
    IV_BYTES: IV_BYTES,
    toBase64: toBase64,
    fromBase64: fromBase64,
    generateKey: generateKey,
    exportKey: exportKey,
    importKey: importKey,
    encrypt: encrypt,
    decrypt: decrypt,
    loadOrCreateKey: loadOrCreateKey,
    backend: backend,
  };
});
