// Which surface the shell shows, and why.
//
// The old rule was a single boolean: `loginRequired && !signedIn` hid every
// screen, including Settings -- the only place that could sign you in. A fresh
// install against a login-gated engine was therefore a locked door, and the
// banner blamed the network for an authentication state.
//
// The rule now: the connect surface appears exactly when the USER can do
// something about it (a wrong address, a missing sign-in), it always contains
// the way to fix it, and the shell never claims "cannot reach" for an engine
// that answered. Everything here is a pure decision, so it is tested directly.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UOnboarding = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Reasons, and what each one means:
  //   checking     the first health probe is still in flight -- show the app,
  //                never flash a connect screen at someone who is fine
  //   first-run    nothing has been chosen or saved yet
  //   unreachable  the engine never answered (offline, wrong address, blocked)
  //   signed-out   the engine answered and wants a login
  //   ready        usable
  //   degraded     the engine answered with a server-side failure (5xx)
  var REASONS = ['checking', 'first-run', 'unreachable', 'signed-out', 'ready', 'degraded'];

  // Kinds from connection.js that mean "the address is wrong or unusable".
  var ADDRESS_KINDS = ['unreachable', 'refused', 'rejected'];

  function shellState(input) {
    var s = input || {};
    var outcome = s.outcome || null;
    var kind = (outcome && outcome.kind) || null;
    var health = s.health || null;
    var signedIn = !!s.signedIn;
    var firstRun = !s.serverSaved;

    function state(surface, reason, bannerKind) {
      return {
        surface: surface,
        reason: reason,
        kind: kind,
        firstRun: firstRun,
        bannerKind: bannerKind || null,
      };
    }

    // Nothing has been learned yet: keep the app on screen rather than flashing
    // a connect card at a working install.
    if (!outcome && !health) return state('app', 'checking');

    // The engine never answered, or answered in a way that means this address is
    // not usable: the only useful surface is the one that can change it.
    if (kind && ADDRESS_KINDS.indexOf(kind) !== -1) return state('connect', 'unreachable');

    // It answered but failed on its side: the app still works (each screen
    // reports its own error), so say so in a banner instead of hiding it.
    if (kind === 'engine-error') return state('app', 'degraded', 'engine-error');

    // It answered and wants a login we do not have: connect, with the form in it.
    if (health && health.loginRequired && !signedIn) return state('connect', 'signed-out');

    // It answered, and (if it gates anything) we hold a session.
    if (health && health.ok !== false) return state('app', 'ready');

    return state('connect', firstRun ? 'first-run' : 'unreachable');
  }

  /** The headline for the connect surface: what is wrong, in one line. */
  function connectTitle(reason) {
    switch (reason) {
      case 'signed-out':
        return 'Sign in to this engine';
      case 'unreachable':
        return 'Connect to an engine';
      case 'first-run':
        return 'Welcome to FreeAI4U';
      default:
        return 'Connect to an engine';
    }
  }

  /** The sentence under it: what the user should do about it. */
  function connectAdvice(reason) {
    switch (reason) {
      case 'signed-out':
        return 'This engine asks for a login. Sign in below and the app picks up where it should.';
      case 'unreachable':
        return 'That address did not answer. Check it below, or go back to the default engine.';
      case 'first-run':
        return 'Point this app at a FreeAI4U engine — the default one works out of the box.';
      default:
        return 'Check the engine address below.';
    }
  }

  return {
    REASONS: REASONS,
    ADDRESS_KINDS: ADDRESS_KINDS,
    shellState: shellState,
    connectTitle: connectTitle,
    connectAdvice: connectAdvice,
  };
});
