// What the Images screen decides, without the screen.
//
// Three things used to be guessed in the component and are rules here:
//
//   1. WHICH SERVICE draws. The engine's report lists the services it can draw
//      with and why each one cannot, and the browser answer (Puter, on the
//      visitor's own account) is a row in that same list -- it is not a
//      checkbox. The request then names the service it chose, because a model
//      id means different things on different services and sending a bare model
//      id was how a pick silently landed on someone else's model.
//   2. WHICH MODELS. Puter's chains are the app's curated ones -- see
//      chatlib.js, which the web app and this screen agree with
//      (test/desktop-images.test.js reads them out of that file and asserts
//      they match, so the two cannot drift).
//   3. WHAT SHAPE. A size is a preset with pixels for an OpenAI-shaped API and
//      a ratio for Puter's txt2img, so nothing downstream re-derives it.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UImages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Puter documents Flare for everyday generation and Sunburst for edits; a
  // generation-leaning model on an edit is how an edit drifts away from its
  // source. Each chain keeps a second and third choice, because a Puter account
  // can be refused one model without losing the rest.
  var PUTER_GENERATE_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5'];
  var PUTER_EDIT_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2'];
  // Puter draws at 'low' when nothing asks for better, at the same price.
  var QUALITY = 'high';

  var SIZE_PRESETS = [
    { id: 'square', label: '1:1', width: 1024, height: 1024, ratio: { w: 1, h: 1 } },
    { id: 'landscape', label: '3:2', width: 1536, height: 1024, ratio: { w: 3, h: 2 } },
    { id: 'portrait', label: '2:3', width: 1024, height: 1536, ratio: { w: 2, h: 3 } },
    { id: 'wide', label: '16:9', width: 1536, height: 864, ratio: { w: 16, h: 9 } },
    { id: 'tall', label: '9:16', width: 864, height: 1536, ratio: { w: 9, h: 16 } },
  ];

  var BROWSER_ID = 'puter';

  function preset(id) {
    for (var i = 0; i < SIZE_PRESETS.length; i += 1) {
      if (SIZE_PRESETS[i].id === id) return SIZE_PRESETS[i];
    }
    return SIZE_PRESETS[0];
  }

  function modelsFor(kind) {
    return (kind === 'edit' ? PUTER_EDIT_MODELS : PUTER_GENERATE_MODELS).slice();
  }

  /**
   * The services to offer, in the order to try them: what the engine can draw
   * with first (its own order), then the browser answer.
   *
   * A service that is not ready still appears -- with the reason it cannot --
   * because "no image service answered" is the least useful thing a picker can
   * say, and the reason is usually a missing environment variable somebody can
   * set.
   */
  function providerChoices(report) {
    var body = report || {};
    var rows = Array.isArray(body.providers) ? body.providers : [];
    var out = rows.map(function (row) {
      var r = row || {};
      return {
        id: String(r.id || ''),
        label: String(r.label || r.id || 'service'),
        kind: 'server',
        ready: !!r.ready,
        model: String(r.model || ''),
        // What the service can be asked for. An engine that reports one model
        // -- an older build, or a service that really serves one -- still
        // works: the list falls back to that single name.
        models: (Array.isArray(r.models) ? r.models : [])
          .map(function (m) { return String(m || '').trim(); })
          .filter(function (m, i, all) { return m && all.indexOf(m) === i; }),
        reason: String(r.reason || ''),
        note: String(r.note || ''),
        edits: String(r.edits || ''),
      };
    });
    // Puter runs in this webview, on the user's account, so whether it is
    // offered is not the engine's call: an engine that never mentions it (or
    // one this app cannot reach) still leaves the row in the list.
    var browser = body.browser && body.browser.id ? body.browser : { id: BROWSER_ID, label: 'Puter' };
    if (browser && browser.id) {
      out.push({
        id: String(browser.id),
        label: String(browser.label || 'Puter'),
        kind: 'browser',
        // Never "ready": it needs a sign-in, which is the screen's job to ask
        // for and the user's to give.
        ready: false,
        model: '',
        reason: '',
        note: String(browser.note || 'Requires a Puter sign-in.'),
        models: modelsFor('generate'),
        edits: 'references',
      });
    }
    return out;
  }

  /** The row to draw with: what was chosen, else the first ready one, else the browser. */
  function chosen(choiceId, choices) {
    var list = Array.isArray(choices) ? choices : [];
    var wanted = String(choiceId || '');
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === wanted) return list[i];
    }
    for (var j = 0; j < list.length; j += 1) {
      if (list[j].kind === 'server' && list[j].ready) return list[j];
    }
    for (var k = 0; k < list.length; k += 1) {
      if (list[k].kind === 'browser') return list[k];
    }
    return list[0] || null;
  }

  /** Every model this service can be asked for, best first, never empty. */
  function modelsForChoice(choice, kind) {
    var row = choice || {};
    if (row.kind === 'browser') return modelsFor(kind);
    var list = Array.isArray(row.models) ? row.models.slice() : [];
    if (row.model && list.indexOf(row.model) < 0) list.unshift(String(row.model));
    if (!list.length && row.model) list.push(String(row.model));
    return list.length ? list : ['service default'];
  }

  function modelFor(choice, kind) {
    var row = choice || {};
    if (row.kind === 'browser') {
      var chain = modelsFor(kind);
      return chain.indexOf(row.model) >= 0 ? row.model : chain[0];
    }
    // The service's own current model, unless the row already names a model the
    // list does not carry -- then the row's own name is the honest one.
    var list = modelsForChoice(row, kind);
    if (row.model && list.indexOf(String(row.model)) >= 0) return String(row.model);
    return list[0] === 'service default' ? '' : list[0];
  }

  /**
   * The body for the engine's images route. The service is named explicitly --
   * `provider` is what pins it -- and the model rides along because that is the
   * only way the engine knows which of the service's models means what.
   */
  function serverBody(choice, request) {
    var row = choice || {};
    var req = request || {};
    var shape = preset(req.size);
    var body = {
      prompt: String(req.prompt || ''),
      provider: String(row.id || ''),
      size: shape.width + 'x' + shape.height,
      quality: QUALITY,
    };
    // The model on screen wins over the service's own default: a picker whose
    // choice is ignored is a lie, and a service with several image models is
    // exactly where someone would notice.
    var model = String(req.model || '').trim() || modelFor(row, req.kind);
    if (model) body.model = model;
    return body;
  }

  /** The size a request ends up with, for the caption. */
  function sizeLabel(id) {
    var shape = preset(id);
    return shape.label + ' · ' + shape.width + '×' + shape.height;
  }

  /** Who drew it, from the engine's own attribution. */
  function attribution(data) {
    var body = data || {};
    var label = String(body.providerLabel || body.provider || '').trim();
    var model = String(body.model || '').trim();
    var who = label && model && label !== model ? label + ' · ' + model : (model || label);
    var notes = Array.isArray(body.notes) ? body.notes.filter(Boolean) : [];
    return { who: who, notes: notes };
  }

  // Puter rejects with {message, code, errorCode}. A spent allowance is
  // errorCode insufficient_funds (HTTP 402) and the SDK's own answer to that is
  // an upgrade dialog, which says the wrong thing to someone who simply wants
  // to know why no picture appeared.
  function describePuterError(error) {
    if (!error) return 'Puter failed';
    if (typeof error === 'string') return error;
    var code = error.errorCode || error.code || (error.error && error.error.code) || '';
    if (code === 'insufficient_funds' || code === 'subscription_required') return 'Puter credits used up';
    if (code === 'too_many_requests') return 'Puter rate limit';
    if (code === 'moderation_flagged') return 'Puter refused this prompt';
    if (code === 'permission_denied') return 'Puter refused: sign in again';
    return error.message || (error.error && (error.error.message || error.error)) || code || 'Puter failed';
  }

  /** Whether a Puter failure is worth trying again, and what to say. */
  function puterAdvice(message) {
    var text = String(message || '');
    if (/credits used up|subscription/i.test(text)) {
      return 'Your Puter allowance is spent — check puter.com/dashboard, or draw on the engine instead.';
    }
    if (/rate limit/i.test(text)) return 'Puter is rate-limiting this account. Wait a moment, or draw on the engine.';
    if (/sign in/i.test(text)) return 'Sign in to Puter, then draw again.';
    if (/refused this prompt/i.test(text)) return 'Rephrase the prompt, or draw on the engine.';
    return 'Try again, or pick a service from the engine instead.';
  }

  return {
    PUTER_GENERATE_MODELS: PUTER_GENERATE_MODELS,
    PUTER_EDIT_MODELS: PUTER_EDIT_MODELS,
    QUALITY: QUALITY,
    SIZE_PRESETS: SIZE_PRESETS,
    BROWSER_ID: BROWSER_ID,
    preset: preset,
    modelsFor: modelsFor,
    modelsForChoice: modelsForChoice,
    providerChoices: providerChoices,
    chosen: chosen,
    modelFor: modelFor,
    serverBody: serverBody,
    sizeLabel: sizeLabel,
    attribution: attribution,
    describePuterError: describePuterError,
    puterAdvice: puterAdvice,
  };
});
