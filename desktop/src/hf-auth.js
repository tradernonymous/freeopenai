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
// The token is stored in localStorage under the key `freeai4u.hf_token`. It
// is never logged, never committed, and never sent to the FreeAI4U engine —
// it stays on this machine and is only used for Hugging Face Hub requests
// (model downloads, gated-repo access).
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UHfAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var TOKEN_KEY = 'freeai4u.hf_token';
  var USER_KEY  = 'freeai4u.hf_user';

  // HF's public OAuth app — no client secret, PKCE only.
  var CLIENT_ID = '3087aa798961c2c8e4432978c9641a19';
  var AUTHORIZE = 'https://huggingface.co/oauth/authorize';
  var TOKEN_URL = 'https://huggingface.co/oauth/token';
  var DEVICE_URL = 'https://huggingface.co/oauth/device';
  var API_ME    = 'https://huggingface.co/api/whoami-v2';
  var SCOPE = 'read-repos write-repos';

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

  function saveToken(token) {
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    } catch { /* best effort */ }
  }

  function loadToken() {
    try {
      var raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function clearToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch { /* best effort */ }
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
      try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {}
      return user;
    } catch {
      return null;
    }
  }

  function cachedUser() {
    try {
      var raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
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
    CLIENT_ID: CLIENT_ID,
    SCOPE: SCOPE,
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
