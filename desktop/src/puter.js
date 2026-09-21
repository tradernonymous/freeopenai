// Puter, in the app's own webview.
//
// Puter draws and chats on the visitor's own account, in the browser, which is
// why the engine has no route for it -- the same reason the Android app drives
// it through a bridge page (puter-bridge.html) rather than a server call. This
// is that bridge for the desktop, and it is deliberately small: load the SDK,
// report whether anybody is signed in, and run a draw or a chat.
//
// Two decisions worth knowing:
//
//   1. The script is injected ONLY when the user picks Puter. A third-party
//      script in the app's origin is a real thing to accept, so it is a choice
//      with a click behind it, not a startup cost -- and Settings says so.
//   2. Errors are translated. Puter answers a spent allowance with
//      `insufficient_funds`, which its SDK renders as an upgrade dialog; here
//      that becomes "Puter credits used up" and a sentence about what to do,
//      because that is what the person in front of the app needs.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UPuter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SRC = 'https://js.puter.com/v2/';
  var LOAD_TIMEOUT_MS = 20000;

  // The SDK installs itself as a global. In node (the tests) there is none, so
  // every call below reports "not loaded" rather than throwing.
  function sdk() {
    var scope = typeof globalThis !== 'undefined' ? globalThis : null;
    return scope && typeof scope.puter !== 'undefined' ? scope.puter : null;
  }

  function loaded() {
    return !!sdk();
  }

  /**
   * Inject the SDK once and resolve when it is usable.
   *
   * A script tag rather than a bundled dependency on purpose: the SDK is what
   * Puter's own auth flow expects, and it talks to its own origin.
   */
  function ensure() {
    if (loaded()) return Promise.resolve(sdk());
    if (typeof document === 'undefined') {
      return Promise.reject(new Error('Puter needs a browser window.'));
    }
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-freeai4u-puter]');
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('Puter did not load. Check the connection, then try again.'));
      }, LOAD_TIMEOUT_MS);

      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        var api = sdk();
        if (api) resolve(api);
        else reject(new Error('Puter loaded but did not start.'));
      }

      if (existing) {
        existing.addEventListener('load', done);
        existing.addEventListener('error', function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('Puter could not be loaded from ' + SRC));
        });
        // Already finished before this call.
        if (loaded()) done();
        return;
      }
      var script = document.createElement('script');
      script.src = SRC;
      script.async = true;
      script.setAttribute('data-freeai4u-puter', '1');
      script.addEventListener('load', done);
      script.addEventListener('error', function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Puter could not be loaded from ' + SRC));
      });
      document.head.appendChild(script);
    });
  }

  function isSignedIn() {
    var api = sdk();
    if (!api || !api.auth || typeof api.auth.isSignedIn !== 'function') return false;
    try {
      return !!api.auth.isSignedIn();
    } catch {
      // A broken SDK is "nobody is signed in", not a crash in the screen.
      return false;
    }
  }

  function user() {
    var api = sdk();
    if (!api || !api.auth || typeof api.auth.getUser !== 'function') return null;
    try {
      return api.auth.getUser() || null;
    } catch {
      return null;
    }
  }

  /** Somebody's own choice of click, never a side effect of a background draw. */
  // How long a sign-in may take before this gives up: the person has to find
  // the browser tab, type a password, maybe do 2FA.
  var SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;
  var SIGNIN_POLL_MS = 2000;

  function uuid() {
    var scope = typeof globalThis !== 'undefined' ? globalThis : {};
    var c = scope.crypto || null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var out = '';
    for (var i = 0; i < 32; i += 1) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }

  /** The sign-in page for a session, in the shape the SDK itself builds. */
  function signInUrl(api, session) {
    var origin = (api && api.defaultGUIOrigin) || 'https://puter.com';
    return origin + '/action/sign-in?embedded_in_popup=true&msg_id=1&cross_origin_isolated=true&signin_session=' + encodeURIComponent(session);
  }

  /** Where the SDK waits for that session's token. */
  function waitUrl(api) {
    return ((api && api.defaultAPIOrigin) || 'https://api.puter.com') + '/login/wait';
  }

  /**
   * signIn(options)
   *
   * The SDK's own `puter.auth.signIn()` opens a popup with window.open() and
   * waits for the popup to postMessage the token back. A Tauri webview sends
   * window.open() to the system browser, where there is no opener to post
   * to -- so the button "did nothing". The SDK also has a second path, used
   * when a page is cross-origin isolated: the sign-in URL carries a session
   * id and the SDK polls POST /login/wait for that session's token. That path
   * needs no popup, so this is that path, driven by hand:
   *
   *   1. open the sign-in page (in whatever the caller says: the system
   *      browser under the shell, a tab in a plain browser),
   *   2. poll /login/wait with the session until it answers with auth_token,
   *   3. hand the token to the SDK with setAuthToken, which is what its own
   *      flow does last.
   *
   * `options.open(url)` opens the page; `options.fetchImpl` and `options.sleep`
   * are for tests. Resolves true once the SDK says somebody is signed in.
   */
  function signIn(options) {
    var opts = options || {};
    return ensure().then(function (api) {
      if (!api.auth || typeof api.setAuthToken !== 'function') {
        throw new Error('This Puter build has no sign-in.');
      }
      if (isSignedIn()) return true;
      var open = typeof opts.open === 'function' ? opts.open : function (url) {
        var scope = typeof globalThis !== 'undefined' ? globalThis : {};
        if (typeof scope.open === 'function') scope.open(url, '_blank');
      };
      var doFetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
      if (!doFetch) throw new Error('Puter needs a browser window.');
      var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      var session = uuid();
      var deadline = Date.now() + (opts.timeoutMs || SIGNIN_TIMEOUT_MS);
      return Promise.resolve(open(signInUrl(api, session))).then(function poll() {
        if (Date.now() >= deadline) throw new Error('Puter sign-in timed out. Try again, and finish signing in within five minutes.');
        return doFetch(waitUrl(api), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: session }),
        }).then(function (res) {
          if (!res || !res.ok) return sleep(SIGNIN_POLL_MS).then(poll);
          return res.json().then(function (data) {
            var token = data && data.auth_token;
            if (!token) return sleep(SIGNIN_POLL_MS).then(poll);
            api.setAuthToken(token);
            return isSignedIn();
          });
        }, function () {
          return sleep(SIGNIN_POLL_MS).then(poll);
        });
      });
    });
  }
  function signOut() {
    var api = sdk();
    if (api && api.auth && typeof api.auth.signOut === 'function') return Promise.resolve(api.auth.signOut());
    return Promise.resolve();
  }
  function onAuthChange(handler) {
    var api = sdk();
    if (!api || !api.auth || typeof api.auth.onAuthStateChanged !== 'function') return function () {};
    try {
      api.auth.onAuthStateChanged(function (who) { handler(who || null); });
    } catch {
      return function () {};
    }
    return function () {};
  }

  /** txt2img answers with an <img> whose src may be a data:, blob: or http URL. */
  function toDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('could not read the picture')); };
      reader.readAsDataURL(blob);
    });
  }

  function imageToDataUrl(result) {
    var src = result && (result.src || (typeof result === 'string' ? result : ''));
    if (!src) return Promise.reject(new Error('Puter returned no picture'));
    if (String(src).indexOf('data:image/') === 0) return Promise.resolve(String(src));
    return fetch(src).then(function (response) {
      if (!response.ok) throw new Error('could not fetch the picture');
      return response.blob();
    }).then(toDataUrl);
  }

  function draw(prompt, options) {
    var opts = options || {};
    return ensure().then(function (api) {
      if (!isSignedIn()) throw new Error('sign in to Puter first');
      if (!api.ai || typeof api.ai.txt2img !== 'function') throw new Error('Puter has no image model');
      var args = { quality: opts.quality || 'high' };
      if (opts.model) args.model = String(opts.model);
      if (opts.ratio && opts.ratio.w && opts.ratio.h) args.ratio = { w: opts.ratio.w, h: opts.ratio.h };
      if (opts.source) args.input_images = [String(opts.source)];
      return Promise.resolve(api.ai.txt2img(String(prompt || '').slice(0, 2000), args)).then(imageToDataUrl);
    });
  }

  return {
    SRC: SRC,
    ensure: ensure,
    loaded: loaded,
    isSignedIn: isSignedIn,
    user: user,
    signIn: signIn,
    signInUrl: signInUrl,
    waitUrl: waitUrl,
    signOut: signOut,
    onAuthChange: onAuthChange,
    imageToDataUrl: imageToDataUrl,
    draw: draw,
  };
});
