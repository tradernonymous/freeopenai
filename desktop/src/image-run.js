// Carrying out a picture request: the one place a plan from images.js becomes
// a real call, shared by the Images screen and Chat's /image, /edit and /redo.
//
// images.js decides WHAT to send (pure, no network: editRequest, serverBody,
// localRequest). This file is the other half -- HOW each route is sent -- and
// it exists so the two screens cannot drift: a fix to how a local job is
// polled, or to who is credited with a picture, lands in both at once.
//
//   * server  -> the engine's images route (api.imageGenerate / imageEdit)
//   * browser -> puter.draw, on the signed-in Puter account
//   * local   -> the shell's sd_generate, then sd_job until it has bytes
//
// The network pieces are handed in (`deps`) rather than imported: this stays a
// UMD module like images.js, node can drive it with fakes, and nothing here can
// reach the network unless the caller gave it the means to -- which the screens
// do only when somebody runs a command or presses a button.
//
// Two small things ride along because both screens need exactly one of them:
//   * the Images screen's choice (service, model, shape), kept under ONE key,
//     so /image in Chat draws with what Images shows rather than a second set
//     of settings;
//   * the "Open in Images" hand-off: a one-shot slot in memory, never storage,
//     so a picture handed to Images is not left lying around after it arrives.
(function (root, factory) {
  // Real CommonJS only (see evals.js): in a bundle `module` can exist without
  // `require`, and there images.js and failure.js are read off their globals.
  var isCjs = typeof module === 'object' && module.exports && typeof require === 'function';
  var images = isCjs ? require('./images.js') : null;
  var failure = isCjs ? require('./failure.js') : null;
  var api = factory(
    function () { return images || (root && root.FreeAI4UImages) || null; },
    function () { return failure || (root && root.FreeAI4UFailure) || null; },
    root,
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UImageRun = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (imagesLib, failureLib, root) {
  /** Where the Images screen keeps its service, model and shape. */
  var CHOICE_KEY = 'freeai4u.images.choice';
  /** Heard by a mounted Images screen when a picture is handed to it. */
  var HANDOFF_EVENT = 'freeai4u:images-handoff';

  function storageOf(given) {
    if (given) return given;
    try { return root && root.localStorage ? root.localStorage : null; } catch { return null; }
  }

  // ---- the Images screen's choice ---------------------------------------

  /** { choiceId, size, model, editModel } -- blanks when nothing was kept. */
  function readChoice(storage) {
    var empty = { choiceId: '', size: '', model: '', editModel: '' };
    var store = storageOf(storage);
    if (!store) return empty;
    try {
      var parsed = JSON.parse(store.getItem(CHOICE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return empty;
      return {
        choiceId: String(parsed.choiceId || ''),
        size: String(parsed.size || ''),
        model: String(parsed.model || ''),
        editModel: String(parsed.editModel || ''),
      };
    } catch {
      return empty;
    }
  }

  /** Merge a change into the kept choice; a full or private store just forgets. */
  function writeChoice(patch, storage) {
    var next = Object.assign(readChoice(storage), patch || {});
    var store = storageOf(storage);
    if (store) {
      try { store.setItem(CHOICE_KEY, JSON.stringify(next)); } catch { /* not kept is not a failure */ }
    }
    return next;
  }

  /**
   * The model to use for this service and task: the one kept for it when the
   * service still offers it, else the service's own. A model kept for another
   * service means nothing here, which is how a draw lands on the wrong model.
   */
  function modelFor(choice, kind, kept) {
    var images = imagesLib();
    var saved = kept || {};
    var wanted = kind === 'edit' ? saved.editModel : saved.model;
    if (choice && saved.choiceId === choice.id && wanted) {
      var list = images.modelsForChoice(choice, kind);
      if (list.indexOf(wanted) >= 0) return wanted;
    }
    return images.modelFor(choice || {}, kind);
  }

  // ---- what a draw sends --------------------------------------------------

  /**
   * The draw counterpart of images.editRequest, in the same shape
   * ({ route, model, notes, body } or { error }), so one runner carries both.
   * Pure: it names what to send and sends nothing.
   */
  function drawPlan(choice, request) {
    var images = imagesLib();
    var row = choice || null;
    var req = request || {};
    if (!row) return { error: 'No image service is available. Open Images to set one up.' };
    // Puter is never "ready" in the report: it needs a sign-in, which is
    // checked when it is asked, not here.
    if (row.kind !== 'browser' && !row.ready) {
      return { error: (row.label || 'That service') + ' is not ready: ' + (row.reason || 'pick another service in Images.') };
    }
    var prompt = String(req.prompt || '').trim();
    if (!prompt) return { error: 'Say what to draw.' };
    if (row.kind === 'local') {
      return { route: 'local', model: row.model || '', notes: [], body: images.localRequest({ prompt: prompt, size: req.size }) };
    }
    if (row.kind === 'browser') {
      var model = String(req.model || '').trim() || images.modelFor(row, 'generate');
      return {
        route: 'browser',
        model: model,
        notes: [],
        body: { prompt: prompt, model: model, ratio: images.preset(req.size).ratio, quality: images.QUALITY },
      };
    }
    var body = images.serverBody(row, { prompt: prompt, size: req.size, kind: 'generate', model: req.model });
    return { route: 'server', model: body.model || '', notes: [], body: body };
  }

  /**
   * The same plan asked again with a new seed. Only this PC takes one
   * (sd-server's `seed`); the engine's services and Puter pick their own on
   * every request, so for them asking again IS a new seed -- said as a note
   * rather than a seed field nothing reads.
   */
  function withSeed(plan, seed) {
    if (!plan || !plan.route) return plan;
    var value = Number(seed) > 0 ? Math.floor(Number(seed)) : Math.floor(Math.random() * 2147483646) + 1;
    if (plan.route === 'local') {
      return Object.assign({}, plan, {
        body: Object.assign({}, plan.body, { seed: value }),
        notes: plan.notes.concat(['seed ' + value]),
      });
    }
    return Object.assign({}, plan, { notes: plan.notes.concat(['asked again: this service picks a new seed each time']) });
  }

  // ---- carrying it out ----------------------------------------------------

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * One job on this machine, whether it draws or changes a picture: make sure
   * sd-server is up, submit, then poll. Every step is awaited in small pieces
   * so the window keeps painting through the minutes an image takes, and
   * every step reports what the server itself said.
   *
   * Resolves to the data: URL, or '' when the person cancelled.
   */
  function runLocal(body, deps) {
    var images = imagesLib();
    var call = deps.call;
    var stopped = deps.stopped || function () { return false; };
    var onJob = deps.onJob || function () {};
    var onServer = deps.onServer || function () {};
    var pause = deps.wait || wait;
    var id = '';
    return Promise.resolve(call('sd_status'))
      .then(function (status) {
        if (status && status.state === 'ready') return status;
        onJob({ id: '', label: 'Loading the model…', since: Date.now() });
        return Promise.resolve(call('sd_start', { port: null, threads: null })).then(function (started) {
          onServer(started);
          return started;
        });
      })
      .then(function () {
        if (stopped()) { onJob(null); return ''; }
        return Promise.resolve(call('sd_generate', body)).then(function (submitted) {
          id = String((submitted && submitted.id) || '');
          if (!id) throw new Error('The local server accepted the job without an id.');
          onJob({ id: id, label: 'Queued', since: Date.now() });
          var poll = function () {
            if (stopped()) return Promise.resolve('');
            return pause(900).then(function () {
              if (stopped()) return '';
              return Promise.resolve(call('sd_job', { id: id })).then(function (job) {
                var view = images.localJobView(job);
                onJob({ id: id, label: view.label });
                if (view.state === 'cancelled') return '';
                if (view.error) throw new Error(view.error);
                if (view.done) return view.url;
                return poll();
              });
            });
          };
          // Whatever happened, the progress line goes and the card hears the
          // server's own state -- a failed job must not leave "Queued" up.
          var settle = function () {
            onJob(null);
            return Promise.resolve()
              .then(function () { return call('sd_status'); })
              .then(onServer, function () { onServer(null); });
          };
          return poll().then(
            function (url) { return settle().then(function () { return url; }); },
            function (err) { return settle().then(function () { throw err; }); },
          );
        });
      });
  }

  /**
   * Carry out a plan from drawPlan or images.editRequest. Resolves to
   * { url, who, notes }, or null when the person cancelled a local job.
   *
   * deps: { api: { imageGenerate, imageEdit }, imageUrlFrom, puter, call,
   *         stopped?, onJob?, onServer?, wait? }
   */
  function runImage(kind, choice, plan, deps) {
    var images = imagesLib();
    var row = choice || {};
    var d = deps || {};
    if (!plan || !plan.route) return Promise.reject(new Error((plan && plan.error) || 'Nothing to send.'));
    var notes = (plan.notes || []).slice();
    if (plan.route === 'local') {
      return runLocal(plan.body, d).then(function (url) {
        return url ? { url: url, who: 'This PC · ' + (row.model || 'sd-server'), notes: notes } : null;
      });
    }
    if (plan.route === 'browser') {
      if (!d.puter.isSignedIn()) return Promise.reject(new Error('Sign in to Puter first.'));
      return Promise.resolve(d.puter.draw(plan.body.prompt, plan.body)).then(function (url) {
        return { url: url, who: row.label + ' · ' + plan.body.model, notes: notes };
      });
    }
    var send = kind === 'edit' ? d.api.imageEdit : d.api.imageGenerate;
    return Promise.resolve(send(plan.body)).then(function (data) {
      var url = d.imageUrlFrom(data) || '';
      if (!url) {
        throw new Error((data && data.error) || (kind === 'edit'
          ? 'The service answered without a changed picture.'
          : 'The service answered without a picture.'));
      }
      var told = images.attribution(data);
      return { url: url, who: told.who || row.label, notes: notes.concat(told.notes) };
    });
  }

  /** What went wrong, in the words each route's own advice uses. */
  function failureView(kind, route, choice, error) {
    var images = imagesLib();
    var e = error || {};
    var message = images.describePuterError(e) || (e && e.message) || String(e);
    var what = kind === 'edit' ? 'change that picture' : 'draw that';
    if (route === 'local') {
      return { summary: 'This PC could not ' + what, upstream: message, walk: '', advice: images.localAdvice(message), message: message };
    }
    if (route === 'browser') {
      return { summary: 'Puter could not ' + what, upstream: message, walk: '', advice: images.puterAdvice(message), message: message };
    }
    var failure = failureLib();
    var told = failure.attributeImage({
      error: message,
      tried: Array.isArray(e.tried) ? e.tried : [],
      asked: (choice && choice.label) || '',
    });
    return { summary: told.summary, upstream: told.upstream, walk: told.walk, advice: told.advice, message: message };
  }

  /**
   * Who pays, said before the first picture rather than after the bill. Empty
   * for this PC: it costs minutes of the person's own machine and no account.
   */
  function costNote(choice) {
    var row = choice || {};
    if (row.kind === 'local') return '';
    if (row.kind === 'browser') return 'Pictures from Puter are billed to the Puter account that is signed in — each one uses its credits.';
    return 'Pictures from ' + (row.label || 'this service') + ' run on the engine’s key for it — if that key is a paid one, each picture is billed to it.';
  }

  /** A picture's own pixels, so a change on this PC can keep its shape. */
  function measurePicture(url, ImageCtor) {
    var Ctor = ImageCtor || (root && root.Image);
    return new Promise(function (resolve, reject) {
      if (!Ctor) { reject(new Error('This window cannot open pictures.')); return; }
      var probe = new Ctor();
      probe.onload = function () { resolve({ width: probe.naturalWidth, height: probe.naturalHeight }); };
      probe.onerror = function () { reject(new Error('That is not a picture this window can open.')); };
      probe.src = url;
    });
  }

  /**
   * Save a picture to disk. Opening a data: URL in a new tab is blocked; an
   * anchor download is not. The one Save both screens' pictures use.
   */
  function savePicture(url, doc) {
    var d = doc || (root && root.document);
    if (!d || !url) return false;
    var a = d.createElement('a');
    a.href = url;
    a.download = 'freeai4u-' + Date.now() + '.png';
    d.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  // ---- "Open in Images" ---------------------------------------------------
  //
  // One slot in memory: the picture waits here only between the click in Chat
  // and the Images screen arriving, and taking it empties the slot. It never
  // touches storage, so a picture is not left behind in the profile.
  var pending = null;

  /** Hand a picture to the Images screen. `announce` fires the app's events. */
  function handOff(url, announce) {
    pending = url ? String(url) : null;
    if (typeof announce === 'function') announce(HANDOFF_EVENT);
    return !!pending;
  }

  /** The handed picture, once: a second take gets nothing. */
  function takeHandoff() {
    var url = pending;
    pending = null;
    return url;
  }

  return {
    CHOICE_KEY: CHOICE_KEY,
    HANDOFF_EVENT: HANDOFF_EVENT,
    readChoice: readChoice,
    writeChoice: writeChoice,
    modelFor: modelFor,
    drawPlan: drawPlan,
    withSeed: withSeed,
    runLocal: runLocal,
    runImage: runImage,
    failureView: failureView,
    costNote: costNote,
    savePicture: savePicture,
    measurePicture: measurePicture,
    handOff: handOff,
    takeHandoff: takeHandoff,
  };
});
