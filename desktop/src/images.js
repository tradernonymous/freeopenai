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
  // The third answer to "who draws": this PC, through the user's own
  // sd-server (stable-diffusion.cpp). No account, no network -- and no
  // pretending: the row is ready only when the binary AND a model are chosen.
  var LOCAL_ID = 'local';
  // sd.cpp draws in multiples of 64, so a preset that is not one is snapped
  // here rather than refused by the server after the user pressed Draw.
  var LOCAL_STEP_PX = 64;
  var LOCAL_MAX_PX = 2048;
  // Enough steps for a recognisable picture without a ten-minute wait. The
  // number is on screen: nothing here invents a "quality" for somebody.
  var LOCAL_STEPS = 20;

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

  /**
   * The same list with "This PC" on the front, when the shell reported an
   * sd-server at all. It goes first because it is the one service that needs
   * no account and no network; it is never auto-selected (see `chosen`),
   * because generation here costs minutes of the user's own CPU and that is
   * not a thing to start for somebody without being asked.
   */
  function withLocal(choices, facts) {
    var list = Array.isArray(choices) ? choices.slice() : [];
    if (!facts) return list;
    list.unshift(localRow(facts));
    return list;
  }

  /**
   * The "This PC" row, from what the shell found (sd.rs `sd_find`).
   *
   * Ready means BOTH halves are in place. A row that says ready without a
   * model is a Draw button that fails after the user pressed it.
   */
  function localRow(facts) {
    var f = facts || {};
    var binary = String(f.binary || '');
    var model = String(f.model || '');
    var reason = '';
    if (!f.found || !binary) reason = 'Choose ' + String(f.expected_name || 'sd-server') + ' below.';
    else if (!model) reason = 'Choose a model file below.';
    return {
      id: LOCAL_ID,
      label: 'This PC',
      kind: 'local',
      ready: !!(f.found && binary && model),
      model: modelName(model),
      models: model ? [modelName(model)] : [],
      reason: reason,
      note: 'stable-diffusion.cpp on this machine: no account, no network.',
      edits: '',
      binary: binary,
      modelPath: model,
    };
  }

  /** The file name of a path, for a caption that fits on one line. */
  function modelName(path) {
    var text = String(path || '');
    var cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return cut >= 0 ? text.slice(cut + 1) : text;
  }

  /** Is this the row that draws on this machine? */
  function isLocal(choice) {
    return !!choice && choice.kind === 'local';
  }

  /** A side sd.cpp accepts: a multiple of 64, never bigger than LOCAL_MAX_PX. */
  function localSide(px) {
    var value = Math.round(Number(px) / LOCAL_STEP_PX) * LOCAL_STEP_PX;
    if (!isFinite(value) || value < LOCAL_STEP_PX) value = LOCAL_STEP_PX;
    return Math.min(value, LOCAL_MAX_PX);
  }

  /** The shape a preset becomes on this machine. */
  function localSize(sizeId) {
    var shape = preset(sizeId);
    return { width: localSide(shape.width), height: localSide(shape.height) };
  }

  /**
   * The arguments for the shell's `sd_generate`. The shell turns these into
   * sd-server's documented `POST /sdcpp/v1/img_gen` body; nothing here names a
   * host, because there is no host to name -- it is always this machine.
   */
  function localRequest(request) {
    var req = request || {};
    var shape = localSize(req.size);
    return {
      prompt: String(req.prompt || '').trim(),
      negativePrompt: String(req.negativePrompt || '').trim(),
      width: shape.width,
      height: shape.height,
      steps: Number(req.steps) > 0 ? Math.round(Number(req.steps)) : LOCAL_STEPS,
    };
  }

  /**
   * What one poll of a job means, for a progress line and for the gallery.
   *
   * The only way this returns a url is a completed job that actually carried
   * an image. "completed" with an empty result is an error, not a picture:
   * the screen must never show a frame it did not get bytes for.
   */
  function localJobView(job) {
    var body = job || {};
    var status = String(body.status || '').toLowerCase();
    var result = body.result || {};
    var first = Array.isArray(result.images) ? result.images[0] : null;
    var b64 = first && typeof first.b64_json === 'string' ? first.b64_json : '';
    var format = String(result.output_format || 'png').toLowerCase();
    if (status === 'completed') {
      if (!b64) {
        return { state: 'failed', done: true, url: '', label: 'Finished', error: 'The local server finished without an image.' };
      }
      return {
        state: 'completed',
        done: true,
        url: 'data:image/' + (format === 'jpeg' || format === 'webp' ? format : 'png') + ';base64,' + b64,
        label: 'Done',
        error: '',
      };
    }
    if (status === 'failed') {
      return {
        state: 'failed',
        done: true,
        url: '',
        label: 'Failed',
        error: String(body.error || body.detail || 'The local server could not draw that.'),
      };
    }
    if (status === 'cancelled') {
      return { state: 'cancelled', done: true, url: '', label: 'Cancelled', error: '' };
    }
    if (status === 'queued') {
      var place = Number(body.queue_position);
      return {
        state: 'queued',
        done: false,
        url: '',
        label: isFinite(place) && place > 0 ? 'Queued, ' + place + ' ahead' : 'Queued',
        error: '',
      };
    }
    // "generating", and anything this build of sd-server calls it: the honest
    // line is that it is working, not a percentage nobody measured.
    return { state: 'generating', done: false, url: '', label: 'Drawing on this PC…', error: '' };
  }

  /** How long a job has been going, for the same progress line. */
  function localElapsed(ms) {
    var seconds = Math.max(0, Math.round(Number(ms) / 1000) || 0);
    if (seconds < 60) return seconds + 's';
    return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
  }

  /** Whether a local failure is worth doing something about, and what. */
  function localAdvice(message) {
    var text = String(message || '');
    if (/not set up|is not running|Choose /i.test(text)) {
      return 'Choose sd-server and a model file below, then draw again.';
    }
    if (/No model chosen/i.test(text)) return 'Pick a model file below — sd-server needs weights to load.';
    if (/did not become ready/i.test(text)) return 'The model may be too big for this machine, or the file may not be one sd.cpp loads.';
    if (/without an image/i.test(text)) return 'Try again with fewer pixels, or check the server log in Diagnostics.';
    return 'Try again, or pick a service above instead.';
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

  // ---- editing an existing picture ---------------------------------------
  //
  // The same three services, asked to change a picture instead of invent one.
  // The rules that differ from a draw are all here rather than in the screen:
  //
  //   * not every service can. The engine's report says what each one takes --
  //     'mask' for the ones that accept file parts, 'reference' for the ones
  //     that take the picture as an input beside the words, 'none' for a
  //     service that would draw a NEW picture from the words alone and have it
  //     presented as the change that was asked for.
  //   * the model comes from modelsFor('edit'), not the generate chain: a
  //     generation-leaning model on an edit is how an edit drifts away from its
  //     source (see the chains at the top of this file).
  //   * a mask is a file part or it is nothing, which is the engine's own rule
  //     (server.js drops one it cannot send and says so). Rather than let the
  //     user watch a region they supplied be ignored, it is dropped here with
  //     the same sentence.

  // What each service does with the picture, from the engine's report
  // vocabulary ('mask' | 'reference' | 'none'), plus the two spellings this
  // file uses for its own rows.
  var EDIT_WITH_MASK = ['mask', 'multipart'];
  var EDIT_WHOLE = ['reference', 'references', 'parts'];

  /**
   * How much of the source survives a local edit. sd.cpp documents 0.75; this
   * asks for less, because the request here is "change this picture", not
   * "start from this picture" -- a higher number walks away from the original.
   */
  var LOCAL_EDIT_STRENGTH = 0.6;

  /** Can this service be handed a picture to change? */
  function canEdit(choice) {
    var row = choice || {};
    if (row.kind === 'local') return true;
    var mode = String(row.edits || '');
    return EDIT_WITH_MASK.indexOf(mode) >= 0 || EDIT_WHOLE.indexOf(mode) >= 0;
  }

  /** Can this service be handed a mask as well, or only the whole picture? */
  function canMask(choice) {
    var row = choice || {};
    return EDIT_WITH_MASK.indexOf(String(row.edits || '')) >= 0;
  }

  /** Empty when it can edit; otherwise the sentence saying why it cannot. */
  function editReason(choice) {
    var row = choice || {};
    if (!row.id && !row.kind) return 'Pick a service that can change a picture.';
    if (canEdit(row)) return '';
    return (row.label || 'That service') + ' can only draw a new picture, not change one. Pick another service.';
  }

  /** A source the engine will accept: its own rule, applied before the send. */
  function usableSource(value) {
    var text = String(value || '').trim();
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(text)) return text;
    if (/^https?:\/\//i.test(text)) return text;
    return '';
  }

  /**
   * The one request an edit becomes, for whichever of the three services is
   * doing it. PURE: it reads a choice and a request and returns what to send,
   * or the reason nothing should be sent. Nothing here touches the network, so
   * a source picture cannot leave this machine by calling it.
   *
   *   { route: 'server', body }  -> the engine's POST /api/llm/images/edits
   *   { route: 'browser', body } -> puter.draw(prompt, body)
   *   { route: 'local', body }   -> the shell's sd_generate, with an init image
   *   { error }                  -> say this instead, and send nothing
   */
  function editRequest(choice, request) {
    var row = choice || {};
    var req = request || {};
    var refused = editReason(row);
    if (refused) return { error: refused };
    var prompt = String(req.prompt || '').trim();
    if (!prompt) return { error: 'Say what to change about the picture.' };
    var source = usableSource(req.source);
    if (!source) {
      return { error: req.source
        ? 'That source is not a picture this can read — choose an image file, or a link to one.'
        : 'Choose a picture to change first.' };
    }
    var notes = [];
    var mask = usableSource(req.mask);
    if (req.mask && !mask) return { error: 'That mask is not a picture this can read — choose an image file, or a link to one.' };
    if (mask && !canMask(row)) {
      // The engine drops a mask it cannot send and says so; a mask for sd.cpp
      // would have to be one channel, which nothing in this app paints. Either
      // way the user hears it rather than watching their mask be ignored.
      notes.push(row.kind === 'local'
        ? 'the mask was left out — sd.cpp wants a one-channel mask, which this app does not paint'
        : 'the mask was left out — ' + (row.label || 'this service') + ' changes the whole picture only');
      mask = '';
    }
    var model = String(req.model || '').trim() || modelFor(row, 'edit');

    if (row.kind === 'local') {
      // This machine fetches nothing. The engine can go and read a link
      // (server.js imageBytesFor); sd-server here is handed bytes or nothing,
      // because a link would mean this app reaching out on a page's say-so.
      if (source.indexOf('data:') !== 0) {
        return { error: 'This PC needs the picture itself — choose an image file rather than a link.' };
      }
      // sd.cpp has no edit endpoint: an edit is the same img_gen job with an
      // init image and a strength (examples/server/api.md). The shape follows
      // the source rather than the preset, because resizing a picture the user
      // asked to CHANGE is a change nobody asked for.
      var width = localSide(Number(req.sourceWidth) > 0 ? req.sourceWidth : preset(req.size).width);
      var height = localSide(Number(req.sourceHeight) > 0 ? req.sourceHeight : preset(req.size).height);
      return {
        route: 'local',
        model: row.model || '',
        notes: notes,
        body: {
          prompt: prompt,
          negativePrompt: String(req.negativePrompt || '').trim(),
          width: width,
          height: height,
          steps: Number(req.steps) > 0 ? Math.round(Number(req.steps)) : LOCAL_STEPS,
          initImage: source,
          strength: LOCAL_EDIT_STRENGTH,
        },
      };
    }

    if (row.kind === 'browser') {
      // Puter takes the picture beside the words (txt2img's input_images), so
      // there is no mask path here at all -- only a whole-picture change.
      var shape = preset(req.size);
      return {
        route: 'browser',
        model: model,
        notes: notes,
        body: {
          prompt: prompt,
          model: model,
          ratio: shape.ratio,
          quality: QUALITY,
          source: source,
        },
      };
    }

    // The engine's edits route reads `image` and `mask` beside the same fields
    // a draw sends (server.js llmImage): prompt, provider, model, size,
    // quality. The service is named for the same reason it is on a draw.
    var body = serverBody(row, { prompt: prompt, size: req.size, kind: 'edit', model: model });
    body.image = source;
    if (mask) body.mask = mask;
    return { route: 'server', model: body.model || '', notes: notes, body: body };
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
    LOCAL_ID: LOCAL_ID,
    LOCAL_STEPS: LOCAL_STEPS,
    LOCAL_STEP_PX: LOCAL_STEP_PX,
    LOCAL_MAX_PX: LOCAL_MAX_PX,
    localRow: localRow,
    withLocal: withLocal,
    isLocal: isLocal,
    localSide: localSide,
    localSize: localSize,
    localRequest: localRequest,
    localJobView: localJobView,
    localElapsed: localElapsed,
    localAdvice: localAdvice,
    preset: preset,
    modelsFor: modelsFor,
    modelsForChoice: modelsForChoice,
    providerChoices: providerChoices,
    chosen: chosen,
    modelFor: modelFor,
    serverBody: serverBody,
    LOCAL_EDIT_STRENGTH: LOCAL_EDIT_STRENGTH,
    canEdit: canEdit,
    canMask: canMask,
    editReason: editReason,
    editRequest: editRequest,
    sizeLabel: sizeLabel,
    attribution: attribution,
    describePuterError: describePuterError,
    puterAdvice: puterAdvice,
  };
});
