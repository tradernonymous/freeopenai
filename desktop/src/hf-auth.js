// Hugging Face sign-in for the desktop app.
//
// Two ways in, one token store:
//   1. One click (beginOAuth) -- OAuth authorization code + PKCE with a
//      loopback redirect. The shell (hf_oauth.rs) listens on the fixed address
//      registered with the OAuth app, http://127.0.0.1:47823/hf/callback, the
//      authorize page opens in the system browser, and the code that comes
//      back is traded for a token. Needs an OAuth client id: compiled in from
//      NEURAOS_HF_CLIENT_ID, or set in Settings -> Connectors. No secret (a
//      public client; PKCE is the proof).
//   2. A pasted personal access token (useToken) -- always available, and the
//      only way when no client id is configured or there is no shell.
//
// The orchestration takes its side effects as arguments (open a URL, listen,
// exchange), so it runs -- and is tested -- without a shell.
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

  var AUTHORIZE = 'https://huggingface.co/oauth/authorize';
  var API_ME    = 'https://huggingface.co/api/whoami-v2';
  // `inference-api` is the scope the router (hf-inference.js) checks. Without
  // it every chat turn answers 401 with a token that otherwise works fine for
  // the Hub, which is the most confusing failure this app can produce. The
  // OAuth app must be registered with every scope asked for here.
  var SCOPE = 'openid profile read-repos inference-api';
  // The one redirect address, registered with the OAuth app character for
  // character (hf_oauth.rs REDIRECT_URI). A fixed port: HF matches it exactly.
  var LOOPBACK_PORT = 47823;
  var REDIRECT_URI = 'http://127.0.0.1:47823/hf/callback';
  var DEFAULT_TIMEOUT_SECS = 180;
  // A Settings override of the compiled-in client id. Not a secret.
  var CLIENT_ID_KEY = 'freeai4u.hf_client_id';
  // How to register the OAuth app (docs/desktop.md).
  var DOCS_URL = 'https://github.com/tradernonymous/freeopenai/blob/main/docs/desktop.md#one-click-hugging-face-sign-in';
  // A personal access token needs no OAuth app: this page opens with the one
  // permission the router checks already ticked.
  var TOKEN_PAGE = 'https://huggingface.co/settings/tokens/new?tokenType=fineGrained'
    + '&ownUserPermissions=inference.serverless.write&description=NeuraOS%20Desktop';
  // Refresh this long before the access token runs out.
  var REFRESH_MARGIN_MS = 60 * 1000;

  // --- helpers ------------------------------------------------------------

  function base64url(buf) {
    var bytes = new Uint8Array(buf);
    var text = '';
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function webCrypto() {
    var c = globalThis.crypto;
    if (!c || !c.subtle || typeof c.getRandomValues !== 'function') {
      throw new Error('This window has no Web Crypto, so one-click sign-in cannot run. Use an access token instead.');
    }
    return c;
  }

  /** `bytes` random bytes, base64url: 24 -> 32 characters, 48 -> 64. */
  function randomToken(bytes) {
    var arr = new Uint8Array(bytes);
    webCrypto().getRandomValues(arr);
    return base64url(arr);
  }

  function messageOf(e) {
    return String((e && e.message) || e || 'unknown error');
  }

  // --- token store --------------------------------------------------------

  // The credential store, when there is one: { get(key), set(key, value),
  // remove(key) }, all returning promises. Reads are synchronous everywhere
  // else in this module, so the store is mirrored in memory by hydrate().
  var secretStore = null;
  var memory = { token: null, user: null, hydrated: false };
  // refresh(refreshToken, clientId) -> HF's token JSON; see configureRefresh.
  var refresher = null;

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

  /**
   * The stored token, or null when not signed in. An OAuth token close to
   * running out starts a refresh in the background (when a refresher is
   * configured); until it lands the old token is returned.
   */
  function accessToken() {
    var t = loadToken();
    if (!t) return null;
    if (t.expires_at && Date.now() >= t.expires_at - REFRESH_MARGIN_MS) {
      if (t.refresh_token && refresher) refreshAccessToken();
      if (Date.now() >= t.expires_at) {
        if (t.refresh_token) return t; // renewed without the user, see above
        clearToken();
        return null;
      }
    }
    return t;
  }

  /** Whether the user has a valid (or refreshable) HF token. */
  function signedIn() {
    var t = accessToken();
    return !!(t && t.access_token);
  }

  // --- the OAuth client id ------------------------------------------------
  //
  // Compiled into the shell from NEURAOS_HF_CLIENT_ID (hf_oauth_config), and
  // overridable in Settings -> Connectors (localStorage, it is not a secret).
  // No id anywhere: one-click sign-in is not offered, the token paste is.

  function validClientId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id.trim());
  }

  function clientIdOverride() {
    try {
      var storage = browserStorage();
      var value = storage ? storage.getItem(CLIENT_ID_KEY) : null;
      return value && validClientId(value) ? value.trim() : null;
    } catch {
      return null;
    }
  }

  /** Keep (or, with an empty value, forget) the Settings override. */
  function setClientIdOverride(id) {
    var value = String(id == null ? '' : id).trim();
    if (value && !validClientId(value)) {
      throw new Error('A Hugging Face OAuth client id is letters, digits and dashes.');
    }
    var storage = browserStorage();
    if (storage) {
      if (value) storage.setItem(CLIENT_ID_KEY, value);
      else storage.removeItem(CLIENT_ID_KEY);
    }
    announce();
  }

  /** The client id to sign in with: the Settings override, else the build's, else null. */
  function resolveClientId(buildClientId) {
    var override = clientIdOverride();
    if (override) return override;
    var built = String(buildClientId == null ? '' : buildClientId).trim();
    return validClientId(built) ? built : null;
  }

  // --- one-click sign-in (authorization code + PKCE, loopback) --------------

  /** A PKCE verifier (64 characters) and its S256 challenge. */
  async function pkcePair() {
    var verifier = randomToken(48);
    var digest = await webCrypto().subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier: verifier, challenge: base64url(digest) };
  }

  /** The huggingface.co authorize page for this request. */
  function authorizeUrl(opts) {
    var params = new URLSearchParams({
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri || REDIRECT_URI,
      response_type: 'code',
      scope: opts.scope || SCOPE,
      state: opts.state,
      code_challenge: opts.challenge,
      code_challenge_method: 'S256',
    });
    return AUTHORIZE + '?' + params.toString();
  }

  /** The token as it is kept: what HF answered, plus where it came from. */
  function storedToken(data, clientId, now) {
    var token = {
      access_token: data.access_token,
      token_type: data.token_type || 'bearer',
      source: 'oauth',
      client_id: clientId,
    };
    if (data.refresh_token) token.refresh_token = data.refresh_token;
    if (data.scope) token.scope = data.scope;
    var secs = Number(data.expires_in);
    if (secs > 0) token.expires_at = now + secs * 1000;
    return token;
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * One-click sign-in. Every side effect is passed in:
   *   openUrl(url)                        open the system browser
   *   listen(state, timeoutSecs)          -> the code (the shell checks the state)
   *   exchange(code, verifier, clientId, redirectUri) -> HF's token JSON
   *   cancel()                            optional: stop listening
   *   fetchImpl                           optional: for whoami
   * Listens BEFORE the browser opens, so the answer always finds someone;
   * resolves with the Hugging Face user once the token is checked and kept.
   */
  async function beginOAuth(opts) {
    var o = opts || {};
    var clientId = String(o.clientId == null ? '' : o.clientId).trim();
    if (!validClientId(clientId)) {
      throw new Error('One-click sign-in is not set up (no OAuth client id). Use an access token, or add the client id in Settings -> Connectors.');
    }
    var redirectUri = o.redirectUri || REDIRECT_URI;
    if (redirectUri !== REDIRECT_URI) {
      throw new Error('The redirect address must be ' + REDIRECT_URI + '.');
    }
    ['openUrl', 'listen', 'exchange'].forEach(function (name) {
      if (typeof o[name] !== 'function') throw new Error('beginOAuth needs ' + name + '()');
    });

    var pair = await pkcePair();
    var state = randomToken(24);
    var url = authorizeUrl({ clientId: clientId, redirectUri: redirectUri, state: state, challenge: pair.challenge, scope: o.scope });

    var listening = Promise.resolve().then(function () {
      return o.listen(state, o.timeoutSecs || DEFAULT_TIMEOUT_SECS);
    });
    // A busy port fails at once: give it a moment to say so, rather than
    // open a browser tab that can never come back.
    var settleMs = o.settleMs == null ? 300 : o.settleMs;
    var early = await Promise.race([
      listening.then(function () { return null; }, function (e) { return e || new Error('the sign-in listener failed'); }),
      wait(settleMs).then(function () { return null; }),
    ]);
    if (early) throw early instanceof Error ? early : new Error(messageOf(early));

    try {
      await o.openUrl(url);
    } catch (e) {
      listening.catch(function () {});
      if (typeof o.cancel === 'function') {
        try { await o.cancel(); } catch { /* it times out on its own */ }
      }
      throw new Error('Could not open the browser: ' + messageOf(e));
    }

    var answer = await listening;
    // The shell checks the state; a listener that hands back the whole answer
    // is checked here too.
    var code = answer;
    if (answer && typeof answer === 'object') {
      if (answer.state !== state) throw new Error('The sign-in answer did not match this request (state mismatch). Start the sign-in again.');
      code = answer.code;
    }
    if (!code || typeof code !== 'string') throw new Error('Hugging Face sent no authorization code.');

    var data = await o.exchange(code, pair.verifier, clientId, redirectUri);
    if (!data || !data.access_token) {
      throw new Error('Hugging Face did not hand out a token' + (data && data.error ? ' (' + data.error + ')' : '') + '.');
    }
    var token = storedToken(data, clientId, Date.now());
    var user = await whoami(token.access_token, o.fetchImpl);
    saveUser(user);
    saveToken(token);
    return user;
  }

  // --- token refresh ------------------------------------------------------
  //
  // An OAuth token runs out; its refresh token renews it without the browser.
  // The refresh itself is the shell's (hf_oauth_refresh), passed in once by
  // configureRefresh, or per call.

  var refreshing = null;

  function configureRefresh(fn) {
    refresher = typeof fn === 'function' ? fn : null;
  }

  /** Renew the stored OAuth token. Resolves with the new token, or null. */
  function refreshAccessToken(refreshFn) {
    var fn = typeof refreshFn === 'function' ? refreshFn : refresher;
    var t = loadToken();
    if (!t || !t.refresh_token || !t.client_id || !fn) return Promise.resolve(null);
    if (refreshing) return refreshing;
    refreshing = (async function () {
      await null; // `refreshing` is set before anything below can finish
      try {
        var data = await fn(t.refresh_token, t.client_id);
        if (!data || !data.access_token) throw new Error('no access token in the refresh answer');
        var next = storedToken(data, t.client_id, Date.now());
        if (!next.refresh_token) next.refresh_token = t.refresh_token;
        saveToken(next);
        return next;
      } catch (e) {
        // A refused refresh token (revoked, or run out) means signing in
        // again; a network blip does not.
        if (/invalid_grant|invalid_client|unauthorized_client/.test(messageOf(e))) clearToken();
        return null;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  // --- user info ----------------------------------------------------------

  async function fetchUser() {
    var t = accessToken();
    if (!t) return null;
    try {
      var token = t.access_token;
      // Refresh if close to expiry.
      if (t.expires_at && Date.now() > t.expires_at - REFRESH_MARGIN_MS && t.refresh_token) {
        var refreshed = await refreshAccessToken();
        if (refreshed) token = refreshed.access_token;
      }
      var res = await globalThis.fetch(API_ME, {
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

  /** whoami-v2 for a token: the user, or an error that says what went wrong. */
  async function whoami(accessTokenValue, fetchImpl) {
    var doFetch = fetchImpl || globalThis.fetch;
    var res = await doFetch(API_ME, { headers: { Authorization: 'Bearer ' + accessTokenValue } });
    if (res.status === 401) throw new Error('Hugging Face refused the token it just issued. Sign in again.');
    if (!res.ok) throw new Error('Hugging Face did not answer (' + res.status + '). Try again in a moment.');
    return res.json();
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
    SCOPE: SCOPE,
    TOKEN_PAGE: TOKEN_PAGE,
    REDIRECT_URI: REDIRECT_URI,
    LOOPBACK_PORT: LOOPBACK_PORT,
    DEFAULT_TIMEOUT_SECS: DEFAULT_TIMEOUT_SECS,
    CLIENT_ID_KEY: CLIENT_ID_KEY,
    DOCS_URL: DOCS_URL,
    useToken: useToken,
    signedIn: signedIn,
    accessToken: accessToken,
    authHeaders: authHeaders,
    validClientId: validClientId,
    clientIdOverride: clientIdOverride,
    setClientIdOverride: setClientIdOverride,
    resolveClientId: resolveClientId,
    pkcePair: pkcePair,
    authorizeUrl: authorizeUrl,
    beginOAuth: beginOAuth,
    configureRefresh: configureRefresh,
    refreshAccessToken: refreshAccessToken,
    fetchUser: fetchUser,
    cachedUser: cachedUser,
    signOut: signOut,
    saveToken: saveToken,
    loadToken: loadToken,
    clearToken: clearToken,
  };
});
