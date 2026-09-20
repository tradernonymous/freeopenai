// What the engine said, in the words the user sees.
//
// Before this, the same decision was made in three places with three different
// answers: api.ts built the ApiError text, App.tsx built the banner text, and
// Terminal.tsx prefixed whatever it was handed. A 401 on one screen and a dead
// network on another produced copy that could not be reconciled, and there was
// no single place that knew the difference between them.
//
// The rule now: classify an outcome ONCE, and read the copy off the result.
// `kind` is the decision; `message` is what an error carries; `banner` is what
// the shell shows (or null when the state needs no banner at all).
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FreeAI4UConnection = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The kinds, and what each one means:
  //   unreachable  the request never got an answer (offline, DNS, TLS, CORS)
  //   signed-out   the engine wants a login (401)
  //   refused      the engine understood and said no (403, e.g. WORKSPACE_RUN off)
  //   rejected     the engine rejected the request itself (other 4xx)
  //   engine-error the engine failed on its side (5xx)
  //   no-reply     a provider answered without anything readable in it
  var KINDS = ['unreachable', 'signed-out', 'refused', 'rejected', 'engine-error', 'no-reply'];

  function kindForStatus(status) {
    var code = Number(status) || 0;
    if (!code) return 'unreachable';
    if (code === 401) return 'signed-out';
    if (code === 403) return 'refused';
    if (code >= 500) return 'engine-error';
    return 'rejected';
  }

  /** The message an ApiError should carry for this outcome. */
  function messageFor(kind, options) {
    var opts = options || {};
    var status = Number(opts.status) || 0;
    switch (kind) {
      case 'unreachable':
        return 'Could not reach ' + (opts.origin || 'the engine') +
          ' — check your connection or the server address in Settings.';
      case 'signed-out':
        return 'Sign-in required';
      case 'no-reply':
        return 'The provider sent no readable reply.';
      default:
        // The engine's own words when it sent any -- they are more useful than
        // a status line ("WORKSPACE_RUN is not enabled on this server").
        if (opts.message) return String(opts.message);
        return status ? 'HTTP ' + status : 'The engine refused that.';
    }
  }

  /** The shell banner for this outcome, or null when it needs none. */
  function bannerFor(kind) {
    switch (kind) {
      case 'unreachable':
        return 'Cannot reach the engine right now — check the address in Settings.';
      case 'signed-out':
        return 'Signed out — sign in again from Settings.';
      default:
        return null;
    }
  }

  /**
   * One call, both answers.
   *   classify({ status, origin, message, error })
   * -> { kind, status, message, banner }
   */
  function classify(input) {
    var opts = input || {};
    if (opts.error && opts.status == null) {
      var code = Number(opts.error.status);
      if (Number.isFinite(code) && code > 0) opts = Object.assign({}, opts, { status: code });
    }
    var status = Number(opts.status) || 0;
    var kind = kindForStatus(status);
    return {
      kind: kind,
      status: status,
      message: messageFor(kind, opts),
      banner: bannerFor(kind),
    };
  }

  return {
    KINDS: KINDS,
    kindForStatus: kindForStatus,
    messageFor: messageFor,
    bannerFor: bannerFor,
    classify: classify,
  };
});
