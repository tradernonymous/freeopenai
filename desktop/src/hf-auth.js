// HuggingFace OAuth for the desktop app.
//
// Two flows, one surface:
//   1. PKCE loopback — the app opens the HF authorize URL in the system browser,
//      spins up a one-shot HTTP server on 127.0.0.1:<port>/callback, exchanges
//      the code for a token, and shuts the server down. Fast, seamless, no
//      client secret (HF public apps use PKCE).
//   2. Device-code fallback — for headless or when the loopback fails: the app
//      shows a code and a URL, the user authorises in any browser, and the app
//      polls until the token arrives.
//
// Where the token lives: under the desktop shell, in the OS credential store
// (Credential Manager on Windows; secrets.rs), read once at boot by hydrate()
// into memory and written back on every change. In a plain browser -- vite
// dev, the web build -- there is no such store, and localStorage under
// `freeai4u.hf_token` is what there is. A token found in localStorage when a
// store IS available is moved into the store and removed, so an existing
// install stops holding it in plain text on its first run.
//
// The token is never logged, never committed, and never sent to the FreeAI4U
// engine -- it stays on this machine and is only used for Hugging Face
// requests (model downloads, gated-repo access, the inference router).
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UHfAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var TOKEN_KEY = 'freeai4u.hf_token';
  var USER_KEY  = 'freeai4u.hf_user';
  // The credential-store names (secrets.rs KEYS), and the event fired when
  // the token changes or arrives, so a mounted screen can re-read it.
  var SECRET_TOKEN = 'hf_token';
  var SECRET_USER = 'hf_user';
  var AUTH_CHANGED_EVENT = 'freeai4u:hf-auth-changed';

  // HF's public OAuth app — no client secret, PKCE only.
  var CLIENT_ID = '3087aa798961c2c8e4432978c9641a19';
  var AUTHORIZE = 'https://huggingface.co/oauth/authorize';
  var TOKEN_URL = 'https://huggingface.co/oauth/token';
  var DEVICE_URL = 'https://huggingface.co/oauth/device';
  var API_ME    = 'https://huggingface.co/api/whoami-v2';
  // `inference-api` is the scope the router (hf-inference.js) checks. Without
  // it every chat turn answers 401 with a token that otherwise works fine for
  // the Hub, which is the most confusing failure this app can produce.
  var SCOPE = 'read-repos write-repos inference-api';
  // The device-code and PKCE flows above need an OAuth app, and the one this
  // app shipped with is gone (HF answers `invalid_client: Client not found`),
  // so the button did nothing. A personal access token needs no app: this
  // page opens with the one permission the router checks already ticked.
  var TOKEN_PAGE = 'https://huggingface.co/settings/tokens/new?tokenType=fineGrained'
    + '&ownUserPermissions=inference.serverless.write&description=NeuraOS%20Desktop';

  // --- helpers ------------------------------------------------------------

  function base64url(buf) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function sha256(input) {
    var data = new TextEncoder().encode(input);
    var hash = await crypto.subtle.digest('SHA-256', data);
    return base64url(hash);
  }

  function randomString(len) {
    var arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return base64url(arr).slice(0, len);
  }

  // --- token store --------------------------------------------------------

  // The credential store, when there is one: { get(key), set(key, value),
  // remove(key) }, all returning promises. Reads are synchronous everywhere
  // else in this module, so the store is mirrored in memory by hydrate().
  var secretStore = null;
  var memory = { token: null, user: null, hydrated: false };

  function browserStorage() {
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
        scope.dispatchEvent(new scope.Event(AUTH_CHANGED_EVENT));
      }
    } catch { /* a listener is a convenience, not a requirement */ }
  }

  function configureStore(store) {
    secretStore = store && typeof store.get === 'function' ? store : null;
    memory = { token: null, user: null, hydrated: false };
  }

  /**
   * Read the store into memory, moving a localStorage token into it on the
   * way. Resolves with whether a token is now present. Safe to call with no
   * store (a no-op) and safe to call twice.
   */
  async function hydrate() {
    if (!secretStore) return signedIn();
    var storage = browserStorage();
    try {
      var raw = await secretStore.get(SECRET_TOKEN);
      var rawUser = await secretStore.get(SECRET_USER);
      if (!raw && storage) {
        // First run after the move: the plain-text copy is taken in and
        // removed. The user copy is not a secret, but it goes with its token.
        var legacy = storage.getItem(TOKEN_KEY);
        var legacyUser = storage.getItem(USER_KEY);
        if (legacy) {
          await secretStore.set(SECRET_TOKEN, legacy);
          raw = legacy;
          storage.removeItem(TOKEN_KEY);
        }
        if (legacyUser) {
          await secretStore.set(SECRET_USER, legacyUser);
          rawUser = legacyUser;
          storage.removeItem(USER_KEY);
        }
      }
      memory.token = raw ? JSON.parse(raw) : null;
      memory.user = rawUser ? JSON.parse(rawUser) : null;
    } catch {
      memory.token = null;
      memory.user = null;
    }
    memory.hydrated = true;
    announce();
    return signedIn();
  }

  function saveToken(token) {
    if (secretStore) {
      memory.token = token;
      Promise.resolve(secretStore.set(SECRET_TOKEN, JSON.stringify(token))).catch(function () {});
      announce();
      return;
    }
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    } catch { /* best effort */ }
    announce();
  }

  function loadToken() {
    if (secretStore) return memory.token || null;
    try {
      var raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function clearToken() {
    if (secretStore) {
      memory.token = null;
      memory.user = null;
      Promise.resolve(secretStore.remove(SECRET_TOKEN)).catch(function () {});
      Promise.resolve(secretStore.remove(SECRET_USER)).catch(function () {});
      announce();
      return;
    }
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch { /* best effort */ }
    announce();
  }

  function saveUser(user) {
    if (secretStore) {
      memory.user = user;
      Promise.resolve(secretStore.set(SECRET_USER, JSON.stringify(user))).catch(function () {});
      return;
    }
    try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {}
  }

  /** The access token string, or null when not signed in. */
  function accessToken() {
    var t = loadToken();
    if (!t) return null;
    if (t.expires_at && Date.now() >= t.expires_at) {
      // The refresh token, if present, lets us renew without user interaction.
      if (t.refresh_token) return t; // caller should refresh
      clearToken();
      return null;
    }
    return t;
  }

  /** Whether the user has a valid (or refreshable) HF token. */
  function signedIn() {
    var t = accessToken();
    return !!(t && t.access_token);
  }

  // --- PKCE loopback flow -------------------------------------------------
  //
  // The loopback server is a one-shot thing: listen for exactly one request on
  // 127.0.0.1:<port>, exchange the code, shut down. The port is chosen by the
  // OS (port 0) on systems that support it, or falls back to a fixed high port.

  var LOOPBACK_PORT = 18923;
  var REDIRECT_URI;

  /** Build the authorize URL and start the loopback listener. */
  async function signInPKCE() {
    var codeVerifier = randomString(64);
    var codeChallenge = await sha256(codeVerifier);
    var state = randomString(32);

    // The redirect URI must match what HF expects: 127.0.0.1 (not localhost).
    REDIRECT_URI = 'http://127.0.0.1:' + LOOPBACK_PORT + '/callback';

    var params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    var authorizeUrl = AUTHORIZE + '?' + params.toString();

    // Open the browser.
    window.open(authorizeUrl, '_blank');

    // Start a tiny server to catch the callback.
    return new Promise(function (resolve, reject) {
      var server = null;
      var timeout = setTimeout(function () {
        if (server) server.close();
        reject(new Error('Sign-in timed out — the callback was not received within 120 seconds.'));
      }, 120_000);

      // We use a WebSocket-less approach: a simple fetch to our own loopback
      // endpoint. In the Tauri shell, the Rust side handles the callback
      // server. In a browser, we poll a known endpoint.
      //
      // Since we cannot start an HTTP server from JS in a browser, the PKCE
      // flow in the desktop app actually goes through the Rust shell. This
      // JS module provides the URL construction and token exchange; the shell
      // provides the listener.
      //
      // For the browser/dev path, we fall back to device-code.
      clearTimeout(timeout);
      reject(new Error('pkce_needs_shell'));
    });
  }

  // --- device-code flow ---------------------------------------------------

  /** Start the device-code flow: returns { device_code, user_code, verification_url, expires_in }. */
  async function startDeviceCode() {
    var res = await fetch(DEVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: SCOPE,
      }).toString(),
    });
    if (!res.ok) {
      var body = await res.text();
      throw new Error('Device code request failed (' + res.status + '): ' + body);
    }
    return res.json();
  }

  /** Poll for the device-code token. Resolves with the token object. */
  async function pollDeviceCode(deviceCode, interval, expiresAt) {
    var deadline = expiresAt || Date.now() + 900_000; // 15 min default
    var pollInterval = Math.max(interval || 5, 5) * 1000;

    while (Date.now() < deadline) {
      await new Promise(function (r) { setTimeout(r, pollInterval); });
      var res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: CLIENT_ID,
        }).toString(),
      });
      var data = await res.json();
      if (data.access_token) {
        data.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
        saveToken(data);
        return data;
      }
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') {
        pollInterval += 5000;
        continue;
      }
      throw new Error(data.error_description || data.error || 'Device code flow failed');
    }
    throw new Error('Device code expired — please try again.');
  }

  // --- token refresh ------------------------------------------------------

  async function refreshAccessToken() {
    var t = loadToken();
    if (!t || !t.refresh_token) {
      clearToken();
      return null;
    }
    var res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: CLIENT_ID,
      }).toString(),
    });
    if (!res.ok) {
      clearToken();
      return null;
    }
    var data = await res.json();
    data.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
    saveToken(data);
    return data;
  }

  // --- user info ----------------------------------------------------------

  async function fetchUser() {
    var t = accessToken();
    if (!t) return null;
    try {
      var token = t.access_token;
      // Refresh if close to expiry.
      if (t.expires_at && Date.now() > t.expires_at - 60_000 && t.refresh_token) {
        var refreshed = await refreshAccessToken();
        if (refreshed) token = refreshed.access_token;
      }
      var res = await fetch(API_ME, {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) return null;
      var user = await res.json();
      saveUser(user);
      return user;
    } catch {
      return null;
    }
  }

  function cachedUser() {
    if (secretStore) return memory.user || null;
    try {
      var raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // --- personal access token ---------------------------------------------

  /**
   * Sign in with a pasted access token: checked against whoami first, so a
   * typo or a token without the Inference Providers permission is refused
   * here rather than as a 401 on the first chat turn. Resolves with the user.
   */
  async function useToken(token, fetchImpl) {
    var value = String(token || '').trim();
    if (!/^hf_[A-Za-z0-9]{20,}$/.test(value)) {
      throw new Error('That does not look like a Hugging Face token (they start with hf_).');
    }
    var doFetch = fetchImpl || fetch;
    var res = await doFetch(API_ME, { headers: { Authorization: 'Bearer ' + value } });
    if (res.status === 401) throw new Error('Hugging Face refused that token. Create a new one and paste it again.');
    if (!res.ok) throw new Error('Hugging Face did not answer (' + res.status + '). Try again in a moment.');
    var user = await res.json();
    var perms = user && user.auth && user.auth.accessToken && user.auth.accessToken.fineGrained;
    var scoped = perms && Array.isArray(perms.scoped) ? perms.scoped : [];
    var wide = perms && Array.isArray(perms.global) ? perms.global : [];
    var canInfer = !perms
      || wide.indexOf('inference.serverless.write') >= 0
      || scoped.some(function (s) { return (s.permissions || []).indexOf('inference.serverless.write') >= 0; });
    if (!canInfer) {
      throw new Error('This token cannot call Inference Providers. Tick "Make calls to Inference Providers" when you create it.');
    }
    saveUser(user);
    saveToken({ access_token: value, token_type: 'bearer', source: 'pat' });
    return user;
  }

  // --- sign out -----------------------------------------------------------

  function signOut() {
    clearToken();
  }

  // --- auth header helper -------------------------------------------------

  /** Returns { Authorization: 'Bearer <token>' } or {} when not signed in. */
  function authHeaders() {
    var t = accessToken();
    if (!t) return {};
    return { Authorization: 'Bearer ' + t.access_token };
  }

  return {
    TOKEN_KEY: TOKEN_KEY,
    SECRET_TOKEN: SECRET_TOKEN,
    SECRET_USER: SECRET_USER,
    AUTH_CHANGED_EVENT: AUTH_CHANGED_EVENT,
    configureStore: configureStore,
    hydrate: hydrate,
    CLIENT_ID: CLIENT_ID,
    SCOPE: SCOPE,
    TOKEN_PAGE: TOKEN_PAGE,
    useToken: useToken,
    signedIn: signedIn,
    accessToken: accessToken,
    authHeaders: authHeaders,
    signInPKCE: signInPKCE,
    startDeviceCode: startDeviceCode,
    pollDeviceCode: pollDeviceCode,
    refreshAccessToken: refreshAccessToken,
    fetchUser: fetchUser,
    cachedUser: cachedUser,
    signOut: signOut,
    saveToken: saveToken,
    loadToken: loadToken,
    clearToken: clearToken,
  };
});
