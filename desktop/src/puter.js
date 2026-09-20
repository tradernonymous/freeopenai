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
  function signIn() {
    return ensure().then(function (api) {
      if (!api.auth || typeof api.auth.signIn !== 'function') {
        throw new Error('This Puter build has no sign-in.');
      }
      if (api.auth.isSignedIn()) return true;
      return Promise.resolve(api.auth.signIn()).then(function () {
        return isSignedIn();
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
    signOut: signOut,
    onAuthChange: onAuthChange,
    imageToDataUrl: imageToDataUrl,
    draw: draw,
  };
});
