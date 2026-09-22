// NEURA-051: what a local runtime is actually doing, asked rather than assumed.
//
// The status bar already says "connected". For a model running on this machine
// that word is nearly empty: the port answers long before the weights are in
// memory, it keeps answering after the model is ejected, and it says nothing
// about whether the one slot the server has is already busy with somebody
// else's turn. So the chip is built out of facts the runtime states about
// itself, polled:
//
//   * llama-server `GET /health` -- 200 {"status":"ok"} once the weights are
//     loaded, 503 while they are still loading (models.rs leans on the same
//     difference). It is the only endpoint that distinguishes "up" from
//     "ready", and older builds also put slots_idle / slots_processing here.
//   * llama-server `GET /slots` -- the per-slot truth: n_ctx (the window each
//     slot gets, which is --ctx-size divided by --parallel, not the flag the
//     user typed) and is_processing. Since b4327 the endpoint is off unless
//     the server was started with `--slots`, and then it answers 501; that is
//     a missing endpoint, not a broken runtime, so it degrades rather than
//     fails.
//   * Ollama `GET /api/ps` -- Ollama has no /health and no /slots at all, so
//     what it does expose (which model is resident, and on recent builds the
//     context length it was loaded with) stands in, and the chip says plainly
//     that slots are not reported instead of inventing 0/1.
//
// Nothing here fetches on its own and nothing here holds a timer: `fetch` is
// an argument, so a test drives the whole thing with a stub, and the caller
// owns the schedule (StatusBar stops polling when the window is hidden). What
// this module contributes to the schedule is `nextDelay`, the back-off -- a
// chip that retries a dead port every two seconds forever is a busy loop with
// a pretty face.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global (published unconditionally -- see chats.js).
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4ULocalStatus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Slow enough that a laptop on battery does not notice it, fast enough that
  // "busy" is still true by the time it is read.
  var POLL_MS = 5000;
  // A port that is not answering is asked about less and less, up to once a
  // minute: the runtime is not coming back on its own, and the user is the one
  // who will start it.
  var MAX_POLL_MS = 60000;
  // Loopback answers in microseconds or not at all. A longer wait here would
  // only stack probes behind a hung socket.
  var TIMEOUT_MS = 2500;

  var KINDS = ['llama.cpp', 'ollama'];

  /** The zero status: no runtime named, so nothing to say. */
  function empty() {
    return {
      kind: '',
      base: '',
      announce: false,
      reachable: false,
      loading: false,
      model: '',
      contextSize: 0,
      slotsBusy: -1,
      slotsTotal: 0,
      slotsKnown: false,
      degraded: false,
      detail: '',
      at: 0,
    };
  }

  function trimBase(base) {
    return String(base || '').replace(/\/+$/, '');
  }

  /**
   * The runtime to poll, from what the shell reports about the model IT
   * started (local_model_status) -- null while nothing is running, so the chip
   * has nothing to render.
   *
   * `announce` is true here because the app started this process itself: if it
   * stops answering, that is news worth showing. A runtime the app merely
   * knows the address of (Ollama, below) does not get that.
   */
  function targetFromShell(status) {
    var value = status || {};
    var state = String(value.state || '');
    var base = trimBase(value.base_url);
    if (!base || (state !== 'ready' && state !== 'starting')) return null;
    return {
      kind: 'llama.cpp',
      base: base,
      apiKey: String(value.api_key || ''),
      name: nameOf(value),
      announce: true,
    };
  }

  /**
   * The Ollama runtime, from the address My models remembers.
   *
   * `announce` is the caller's: Ollama is a program the user may simply not
   * have running, and a status bar that says "not answering" about something
   * nobody asked for is noise. StatusBar passes true only once Ollama has
   * answered at least one probe, so silence stays silence and a runtime that
   * drops out mid-session is still reported.
   */
  function targetForOllama(base, announce) {
    var where = trimBase(base);
    if (!where) return null;
    return { kind: 'ollama', base: where, apiKey: '', name: '', announce: !!announce };
  }

  /** What to call the model the shell is running: the repo's name, or the file's. */
  function nameOf(value) {
    var v = value || {};
    if (v.repo) return String(v.repo).split('/').pop();
    if (v.file) return String(v.file).split(/[\\/]/).pop().replace(/\.gguf$/i, '');
    return '';
  }

  // ---- one request -----------------------------------------------------------

  /**
   * GET a loopback URL and come back with { ok, status, body, error } whatever
   * happens. Nothing here throws: every branch below wants the same four
   * fields, and a rejected promise in a polling loop is how a status bar ends
   * up with an unhandled rejection instead of a message.
   */
  async function getJson(url, options) {
    var opts = options || {};
    var scope = typeof globalThis !== 'undefined' ? globalThis : {};
    var call = opts.fetch || scope.fetch;
    if (typeof call !== 'function') return { ok: false, status: 0, body: null, error: 'no fetch here' };
    var headers = {};
    if (opts.apiKey) headers.Authorization = 'Bearer ' + opts.apiKey;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller && typeof setTimeout === 'function'
      ? setTimeout(function () { controller.abort(); }, Number(opts.timeoutMs || TIMEOUT_MS))
      : null;
    try {
      var res = await call(url, controller ? { headers: headers, signal: controller.signal } : { headers: headers });
      var status = Number(res && res.status) || 0;
      var text = '';
      try { text = await res.text(); } catch { text = ''; }
      var body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { ok: status >= 200 && status < 300, status: status, body: body, error: '' };
    } catch (err) {
      // An abort is a timeout here, and a timeout on loopback means the same
      // thing as a refused connection: nothing is serving.
      var message = String((err && err.message) || err || 'no answer');
      return { ok: false, status: 0, body: null, error: /abort/i.test(message) ? 'no answer in time' : message };
    } finally {
      if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
    }
  }

  // ---- reading the payloads --------------------------------------------------

  /**
   * `GET /health`, as facts.
   *
   * 200 is "the weights are in memory"; 503 is llama.cpp's own "still
   * loading", which is the one case where a number on screen would be a lie
   * rather than a delay. Old builds (before /slots existed) count the slots
   * here, so those fields are read when they are present.
   */
  function parseHealth(reply) {
    var r = reply || {};
    var body = r.body || {};
    var out = { reachable: !!r.ok, loading: false, slotsBusy: -1, slotsTotal: 0, detail: '' };
    if (r.status === 503) {
      out.reachable = true;
      out.loading = true;
      out.detail = messageOf(body) || 'loading the model';
      return out;
    }
    if (!r.ok) {
      out.detail = r.error || messageOf(body) || (r.status ? 'answered ' + r.status : 'no answer');
      return out;
    }
    var idle = Number(body.slots_idle);
    var busy = Number(body.slots_processing);
    if (isFinite(idle) && isFinite(busy) && idle + busy > 0) {
      out.slotsBusy = busy;
      out.slotsTotal = idle + busy;
    }
    return out;
  }

  /** The message an OpenAI-shaped error body carries, if it is one. */
  function messageOf(body) {
    var b = body || {};
    if (b.error && typeof b.error === 'object') return String(b.error.message || '');
    if (typeof b.error === 'string') return b.error;
    return '';
  }

  /**
   * `GET /slots`, as facts.
   *
   * The endpoint answers an array (some builds wrap it in { slots: [...] }).
   * `n_ctx` is per slot, which is the number that matters to whoever is about
   * to send a long prompt. A 501 or 404 is the server saying it was started
   * without `--slots`: known-missing, not broken, so it comes back as
   * { supported: false } and the chip falls back to /health.
   */
  function parseSlots(reply) {
    var r = reply || {};
    var out = { supported: true, busy: -1, total: 0, contextSize: 0, model: '', detail: '' };
    if (!r.ok) {
      out.supported = r.status !== 501 && r.status !== 404 && r.status !== 405;
      out.detail = messageOf(r.body) || r.error || (r.status ? 'answered ' + r.status : 'no answer');
      return out;
    }
    var rows = Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.slots) ? r.body.slots : null);
    if (!rows) {
      out.supported = false;
      out.detail = 'the slots endpoint answered something else';
      return out;
    }
    out.total = rows.length;
    out.busy = rows.filter(function (slot) { return !!(slot && slot.is_processing); }).length;
    rows.some(function (slot) {
      var s = slot || {};
      var ctx = Number(s.n_ctx);
      if (isFinite(ctx) && ctx > 0) out.contextSize = ctx;
      var model = String(s.model || s.model_path || (s.params && s.params.model) || '');
      if (model) out.model = modelLabel(model);
      return !!(out.contextSize && out.model);
    });
    return out;
  }

  /**
   * `GET /api/ps`, as facts.
   *
   * Ollama's answer to "what is loaded": a models array, empty when nothing
   * is resident. Recent builds report `context_length` per model; older ones
   * report nothing of the sort, and a context this app never chose is not one
   * it should guess at.
   */
  function parseOllamaPs(reply) {
    var r = reply || {};
    var out = { reachable: !!r.ok, model: '', contextSize: 0, detail: '' };
    if (!r.ok) {
      out.detail = r.error || messageOf(r.body) || (r.status ? 'answered ' + r.status : 'no answer');
      return out;
    }
    var rows = (r.body && Array.isArray(r.body.models)) ? r.body.models : [];
    var first = rows[0] || null;
    if (!first) return out;
    out.model = modelLabel(String(first.name || first.model || ''));
    var ctx = Number(first.context_length || (first.details && first.details.context_length) || 0);
    if (isFinite(ctx) && ctx > 0) out.contextSize = ctx;
    return out;
  }

  /** A model as a person names it: no folder, no .gguf. */
  function modelLabel(value) {
    var base = String(value || '').split(/[\\/]/).pop() || '';
    return base.replace(/\.gguf$/i, '');
  }

  // ---- one poll --------------------------------------------------------------

  /**
   * probe(target, options)
   *
   * One round of questions to one runtime, answered as a status object. Never
   * rejects, never throws, and never carries a number over from a previous
   * poll: an unreachable runtime reports no model, no context and no slots, so
   * a caller that renders the result cannot show yesterday's facts.
   *
   * options: { fetch, timeoutMs, now }.
   */
  async function probe(target, options) {
    var t = target || {};
    var opts = options || {};
    var status = empty();
    if (!t.base || KINDS.indexOf(t.kind) < 0) return status;
    status.kind = t.kind;
    status.base = trimBase(t.base);
    status.announce = !!t.announce;
    status.model = String(t.name || '');
    status.at = Number(opts.now || 0) || Date.now();
    var ask = { fetch: opts.fetch, timeoutMs: opts.timeoutMs, apiKey: t.apiKey };

    if (t.kind === 'ollama') {
      var ps = parseOllamaPs(await getJson(status.base + '/api/ps', ask));
      status.reachable = ps.reachable;
      if (!ps.reachable) {
        status.model = '';
        status.detail = ps.detail;
        return status;
      }
      status.model = ps.model;
      status.contextSize = ps.contextSize;
      // Not a failure and not a fallback that went wrong: Ollama has no such
      // endpoint, and saying so is more use than a blank.
      status.degraded = true;
      status.detail = 'Ollama does not report slots';
      return status;
    }

    var health = parseHealth(await getJson(status.base + '/health', ask));
    status.reachable = health.reachable;
    if (!health.reachable) {
      status.model = '';
      status.detail = health.detail;
      return status;
    }
    if (health.loading) {
      // The weights are not in memory yet, so every number except "loading"
      // would be about the last model rather than this one.
      status.loading = true;
      status.detail = health.detail;
      return status;
    }
    var slots = parseSlots(await getJson(status.base + '/slots', ask));
    if (slots.supported && slots.total > 0) {
      status.slotsKnown = true;
      status.slotsBusy = slots.busy;
      status.slotsTotal = slots.total;
      status.contextSize = slots.contextSize;
      if (slots.model) status.model = slots.model;
      return status;
    }
    // No /slots: the server was started without it, or it answered something
    // this code does not understand. /health's own counters are the fallback,
    // and when it has none the chip says the model is up and stops there.
    status.degraded = true;
    status.detail = slots.detail || 'this server was started without --slots';
    if (health.slotsTotal > 0) {
      status.slotsKnown = true;
      status.slotsBusy = health.slotsBusy;
      status.slotsTotal = health.slotsTotal;
    }
    return status;
  }

  // ---- what the chip says ----------------------------------------------------

  /** "8k ctx" for the round numbers a context actually is; '' when unknown. */
  function contextLabel(size) {
    var n = Number(size || 0);
    if (!isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' ctx';
    var k = n / 1024;
    return (k % 1 === 0 ? k : Math.round(k * 10) / 10) + 'k ctx';
  }

  /**
   * chip(status)
   *
   * The status bar's line, as { show, tone, label, title }. `show` false means
   * render nothing at all -- a machine with no local runtime should not carry
   * a chip explaining that it has no local runtime.
   *
   * Tones are the status bar's existing classes (ok / warn / error / muted).
   */
  function chip(status) {
    var s = status || empty();
    if (!s.kind || !s.base) return { show: false, tone: 'muted', label: '', title: '' };
    var where = s.kind === 'ollama' ? 'Ollama' : 'llama.cpp';
    var at = where + ' at ' + s.base;
    if (!s.reachable) {
      // Only for a runtime worth missing: see targetForOllama.
      if (!s.announce) return { show: false, tone: 'muted', label: '', title: '' };
      return {
        show: true,
        tone: 'error',
        label: 'local model not answering',
        title: at + (s.detail ? ' — ' + s.detail : ''),
      };
    }
    if (s.loading) {
      return {
        show: true,
        tone: 'warn',
        label: s.model ? 'loading ' + s.model + '…' : 'loading a local model…',
        title: at + (s.detail ? ' — ' + s.detail : ''),
      };
    }
    if (!s.model) {
      return { show: true, tone: 'warn', label: 'local runtime up · no model loaded', title: at };
    }
    var parts = [s.model];
    var ctx = contextLabel(s.contextSize);
    if (ctx) parts.push(ctx);
    if (s.slotsKnown && s.slotsTotal > 0) parts.push(s.slotsBusy + '/' + s.slotsTotal + ' slots busy');
    else if (s.degraded) parts.push('slots not reported');
    return {
      show: true,
      tone: 'ok',
      label: parts.join(' · '),
      title: at + (s.detail ? ' — ' + s.detail : ''),
    };
  }

  /**
   * How long to wait before asking again.
   *
   * An answer resets to the steady interval; anything else doubles the last
   * wait up to a minute. The status bar is not the place to hammer a socket
   * that is not there, and a runtime that has stopped is usually stopped for
   * as long as it takes a person to notice.
   */
  function nextDelay(status, previous) {
    var s = status || empty();
    var last = Number(previous || 0);
    if (s.reachable) return POLL_MS;
    var next = last > 0 ? last * 2 : POLL_MS;
    return Math.min(MAX_POLL_MS, Math.max(POLL_MS, next));
  }

  return {
    POLL_MS: POLL_MS,
    MAX_POLL_MS: MAX_POLL_MS,
    TIMEOUT_MS: TIMEOUT_MS,
    KINDS: KINDS,
    empty: empty,
    targetFromShell: targetFromShell,
    targetForOllama: targetForOllama,
    parseHealth: parseHealth,
    parseSlots: parseSlots,
    parseOllamaPs: parseOllamaPs,
    contextLabel: contextLabel,
    probe: probe,
    chip: chip,
    nextDelay: nextDelay,
  };
});
