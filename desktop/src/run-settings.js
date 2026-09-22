// Run settings: how a local model is loaded and how it is asked.
//
// Two kinds of setting, and the difference is the whole design:
//
//   * LOAD-TIME -- context length, GPU layers, threads. llama-server takes
//     them as flags, so changing one means a reload (the drawer's "Reload
//     model"). Ollama takes them per request (`options.num_ctx`), so there a
//     change simply applies to the next message.
//   * PER-REQUEST -- temperature, top-p, top-k, min-p, repeat penalty, and the
//     system prompt. They ride along with every message for both.
//
// Settings are remembered per model (the drawer's "Remember for this model"),
// and a named preset is a copy of them that can be applied to any model.
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4URunSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SETTINGS_KEY = 'freeai4u.run_settings';
  var PRESETS_KEY = 'freeai4u.run_presets';
  var GB = 1024 * 1024 * 1024;

  // ctx 0 means Auto: llama-server's own default / the model's trained length
  // capped by what fits; Ollama's default.
  var DEFAULTS = {
    ctx: 0,
    gpuLayers: -1,
    threads: 0,
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    minP: 0.05,
    repeatPenalty: 1.1,
    system: '',
  };

  var LIMITS = {
    ctx: [0, 262144],
    gpuLayers: [-1, 999],
    threads: [0, 256],
    temperature: [0, 2],
    topP: [0, 1],
    topK: [0, 1000],
    minP: [0, 1],
    repeatPenalty: [0.5, 2],
  };

  var LOAD_TIME = ['ctx', 'gpuLayers', 'threads'];

  function storage(given) {
    if (given) return given;
    try {
      var scope = typeof globalThis !== 'undefined' ? globalThis : {};
      return scope.localStorage || null;
    } catch {
      return null;
    }
  }

  function readMap(key, given) {
    var target = storage(given);
    if (!target) return {};
    try {
      var parsed = JSON.parse(target.getItem(key) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeMap(key, map, given) {
    var target = storage(given);
    if (!target) return false;
    try {
      target.setItem(key, JSON.stringify(map));
      return true;
    } catch {
      return false;
    }
  }

  /** Whatever was stored or typed, as numbers inside their limits. */
  function clean(values) {
    var v = values || {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      if (key === 'system') {
        out.system = typeof v.system === 'string' ? v.system.slice(0, 8000) : DEFAULTS.system;
        return;
      }
      var n = Number(v[key]);
      if (!isFinite(n)) n = DEFAULTS[key];
      var lim = LIMITS[key];
      n = Math.min(lim[1], Math.max(lim[0], n));
      if (key === 'ctx' || key === 'gpuLayers' || key === 'threads' || key === 'topK') n = Math.round(n);
      out[key] = n;
    });
    return out;
  }

  function get(modelId, given) {
    var map = readMap(SETTINGS_KEY, given);
    return clean(Object.assign({}, DEFAULTS, map[String(modelId || '')] || {}));
  }

  function set(modelId, values, given) {
    var id = String(modelId || '');
    if (!id) return false;
    var map = readMap(SETTINGS_KEY, given);
    map[id] = clean(values);
    return writeMap(SETTINGS_KEY, map, given);
  }

  function reset(modelId, given) {
    var map = readMap(SETTINGS_KEY, given);
    delete map[String(modelId || '')];
    return writeMap(SETTINGS_KEY, map, given);
  }

  function presets(given) {
    var map = readMap(PRESETS_KEY, given);
    var out = {};
    Object.keys(map).sort().forEach(function (name) { out[name] = clean(map[name]); });
    return out;
  }

  function savePreset(name, values, given) {
    var label = String(name || '').trim().slice(0, 40);
    if (!label) return false;
    var map = readMap(PRESETS_KEY, given);
    map[label] = clean(values);
    return writeMap(PRESETS_KEY, map, given);
  }

  function deletePreset(name, given) {
    var map = readMap(PRESETS_KEY, given);
    if (!(name in map)) return false;
    delete map[name];
    return writeMap(PRESETS_KEY, map, given);
  }

  /** Whether going from `before` to `after` needs llama-server to reload. */
  function needsReload(before, after) {
    var a = clean(before);
    var b = clean(after);
    return LOAD_TIME.some(function (key) { return a[key] !== b[key]; });
  }

  /**
   * estimate({ bytes, ctx, gpuLayers }, { ramGb, vramGb })
   *
   * Weights plus KV cache plus headroom, the same arithmetic as the memory
   * guard in local-models.js, split the way the drawer shows it. `vramGb` is
   * optional: a webview cannot measure VRAM, so it is whatever the person
   * typed, and with none the GPU line carries no verdict.
   */
  function estimate(model, machine) {
    var m = model || {};
    var spec = machine || {};
    var weights = Number(m.bytes || 0) / GB;
    var ctx = Number(m.ctx) > 0 ? Number(m.ctx) : 8192;
    // The model's own KV cost per token when it has been measured.
    var kv = ctx * (Number(m.kvBytesPerToken) > 0 ? Number(m.kvBytesPerToken) / GB : 0.000128);
    var total = weights + kv + 1.5;
    var onGpu = Number(m.gpuLayers) === 0 ? 0 : weights + kv;
    var ram = Number(spec.ramGb) > 0 ? Number(spec.ramGb) * 0.8 : 0;
    var vram = Number(spec.vramGb) > 0 ? Number(spec.vramGb) : 0;
    var warnings = [];
    if (ram && total > ram) {
      warnings.push('Needs about ' + total.toFixed(1) + ' GB; this machine has about ' + ram.toFixed(1) + ' GB to give. Lower the context or pick a smaller model.');
    }
    if (vram && onGpu > vram) {
      warnings.push('Exceeds GPU memory (' + onGpu.toFixed(1) + ' of ' + vram.toFixed(1) + ' GB). Use fewer GPU layers or a shorter context; the rest runs from system RAM.');
    }
    return {
      weightsGb: weights,
      kvGb: kv,
      gpuGb: onGpu,
      totalGb: total,
      warnings: warnings,
    };
  }

  /** Ollama's per-request `options`. Auto values are left for Ollama to pick. */
  function ollamaOptions(values) {
    var v = clean(values);
    var out = {
      temperature: v.temperature,
      top_p: v.topP,
      top_k: v.topK,
      min_p: v.minP,
      repeat_penalty: v.repeatPenalty,
    };
    if (v.ctx > 0) out.num_ctx = v.ctx;
    if (v.gpuLayers >= 0) out.num_gpu = v.gpuLayers;
    if (v.threads > 0) out.num_thread = v.threads;
    return out;
  }

  /** The sampling fields an OpenAI-shaped body (llama-server) takes. */
  function openaiParams(values) {
    var v = clean(values);
    return {
      temperature: v.temperature,
      top_p: v.topP,
      top_k: v.topK,
      min_p: v.minP,
      repeat_penalty: v.repeatPenalty,
    };
  }

  /** The load-time arguments for local_model_start. */
  function loadArgs(values, cores) {
    var v = clean(values);
    var out = {};
    if (v.ctx > 0) out.ctx = v.ctx;
    if (v.gpuLayers !== 0) out.gpuLayers = v.gpuLayers;
    var threads = v.threads > 0 ? v.threads : Number(cores) || 0;
    if (threads > 0) out.threads = threads;
    return out;
  }

  // ---- context window, per model ----------------------------------------------
  //
  // Every model has its own trained context (2k to 262k) and its own KV-cache
  // cost per token, so one "Auto" for all of them was wrong both ways: Ollama
  // left alone uses a small default and silently cuts long chats, and
  // llama-server left alone allocates the TRAINED context -- 262k tokens of
  // cache on a 4 GB card. What each model reports is kept here, and Auto
  // becomes "the largest step that fits this machine, never past what the
  // model was trained for". Callers send the result explicitly
  // ({ ...values, ctx: effectiveCtx(...) }) to both runtimes.

  var LIMITS_KEY = 'freeai4u.model_limits';
  var CTX_STEPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
  // Without a measured shape, a typical 7-8B GQA model: 32 layers, 8 KV heads
  // of 128 dims each for K and V, f16 -- 128 KiB per token.
  var DEFAULT_KV_BYTES = 32 * 8 * (128 + 128) * 2;
  // Auto never goes past this unless the person picks more: long contexts
  // are slow to fill on a laptop even when they fit.
  var AUTO_CAP = 32768;

  function readLimits(given) {
    var s = storage(given);
    if (!s) return {};
    try {
      var map = JSON.parse(s.getItem(LIMITS_KEY) || '{}');
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch {
      return {};
    }
  }

  function limitsFor(modelId, given) {
    return readLimits(given)[modelId] || null;
  }

  function setLimits(modelId, limits, given) {
    var s = storage(given);
    if (!s || !modelId || !limits) return false;
    var map = readLimits(s);
    map[modelId] = Object.assign({}, map[modelId] || {}, limits, { at: Date.now() });
    try {
      s.setItem(LIMITS_KEY, JSON.stringify(map));
      return true;
    } catch {
      return false;
    }
  }

  /** Ollama's /api/show answer -> { trainCtx, kvBytesPerToken, source }. */
  function parseOllamaShow(show) {
    var info = (show && show.model_info) || {};
    var pick = function (suffix) {
      for (var key in info) {
        if (Object.prototype.hasOwnProperty.call(info, key) && key.slice(-suffix.length) === suffix) {
          var n = Number(info[key]);
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
      return 0;
    };
    var trainCtx = pick('.context_length');
    var layers = pick('.block_count');
    var heads = pick('.attention.head_count');
    var kvHeads = pick('.attention.head_count_kv') || heads;
    var embed = pick('.embedding_length');
    var keyLen = pick('.attention.key_length') || (heads ? embed / heads : 0);
    var valLen = pick('.attention.value_length') || keyLen;
    var kvBytes = layers && kvHeads && keyLen ? Math.round(layers * kvHeads * (keyLen + valLen) * 2) : 0;
    var out = { source: 'ollama' };
    if (trainCtx) out.trainCtx = trainCtx;
    if (kvBytes) out.kvBytesPerToken = kvBytes;
    return out;
  }

  /**
   * A GGUF header (the shell's gguf_info) -> { trainCtx, kvBytesPerToken, source }
   * plus the facts the drawer shows. Read from the file before any load, so the
   * first load is sized exactly. KV per token = K and V, f16 (2 bytes), for
   * every layer and KV head: layers * kvHeads * (keyLen + valueLen) * 2 -- a
   * head's length is key_length/value_length when given, else embedding/heads.
   */
  function parseGgufInfo(info) {
    var h = info || {};
    var num = function (v) {
      var n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    var trainCtx = num(h.context_length);
    var layers = num(h.block_count);
    var heads = num(h.head_count);
    var kvHeads = num(h.head_count_kv) || heads;
    var embed = num(h.embedding_length);
    var keyLen = num(h.key_length) || (heads && embed ? embed / heads : 0);
    var valLen = num(h.value_length) || keyLen;
    var kvBytes = layers && kvHeads && keyLen ? Math.round(layers * kvHeads * (keyLen + valLen) * 2) : 0;
    var out = { source: 'gguf' };
    if (trainCtx) out.trainCtx = trainCtx;
    if (kvBytes) out.kvBytesPerToken = kvBytes;
    if (typeof h.architecture === 'string' && h.architecture) out.arch = h.architecture.slice(0, 64);
    if (layers) out.layers = layers;
    if (typeof h.size_label === 'string' && h.size_label) out.sizeLabel = h.size_label.slice(0, 32);
    if (num(h.sliding_window)) out.slidingWindow = num(h.sliding_window);
    return out;
  }

  /** llama-server's /v1/models answer -> { trainCtx, source }. */
  function parseLlamaModels(body) {
    var rows = (body && (body.data || body.models)) || [];
    var meta = rows[0] && rows[0].meta;
    var n = Number(meta && meta.n_ctx_train);
    return Number.isFinite(n) && n > 0 ? { trainCtx: n, source: 'llama-server' } : { source: 'llama-server' };
  }

  /**
   * The context Auto picks: the largest step that fits memory (weights + KV +
   * headroom within 80% of RAM, and within VRAM when the weights already fit a
   * GPU whose size was given), capped at the trained context and at AUTO_CAP.
   */
  function autoCtx(limits, model, machine) {
    var lim = limits || {};
    var m = model || {};
    var spec = machine || {};
    var kv = Number(lim.kvBytesPerToken) > 0 ? Number(lim.kvBytesPerToken) : DEFAULT_KV_BYTES;
    var weights = Number(m.bytes || 0);
    var ram = Number(spec.ramGb) > 0 ? Number(spec.ramGb) * 0.8 * GB : 0;
    var vram = Number(spec.vramGb) > 0 ? Number(spec.vramGb) * GB : 0;
    var train = Number(lim.trainCtx) > 0 ? Number(lim.trainCtx) : 0;
    var ceiling = Math.min(train || AUTO_CAP, AUTO_CAP);
    var best = 0;
    for (var i = 0; i < CTX_STEPS.length; i += 1) {
      var step = CTX_STEPS[i];
      if (step > ceiling) break;
      var need = weights + step * kv + 1.5 * GB;
      if (ram && need > ram) break;
      // A GPU run that spills to RAM still works, just slower: only a card the
      // weights already fit is held to its size.
      if (vram && Number(m.gpuLayers) !== 0 && weights < vram && weights + step * kv > vram) break;
      best = step;
    }
    if (!best) best = CTX_STEPS[0];
    return train ? Math.min(best, train) : best;
  }

  /** The context actually used: the person's pick (never past the model's) or Auto. */
  function effectiveCtx(values, limits, model, machine) {
    var v = clean(values);
    var train = limits && Number(limits.trainCtx) > 0 ? Number(limits.trainCtx) : 0;
    if (v.ctx > 0) return train ? Math.min(v.ctx, train) : v.ctx;
    return autoCtx(limits, model, machine);
  }

  /** The steps the slider offers for this model (0 = Auto), up to its trained context. */
  function ctxSteps(limits) {
    var train = limits && Number(limits.trainCtx) > 0 ? Number(limits.trainCtx) : 0;
    var steps = CTX_STEPS.filter(function (s) { return !train || s <= train; });
    if (train && steps.indexOf(train) < 0) steps.push(train);
    return [0].concat(steps);
  }

  /** The messages with the model's system prompt in front, when it has one. */
  function withSystem(messages, values) {
    var list = Array.isArray(messages) ? messages : [];
    var system = clean(values).system.trim();
    if (!system || (list[0] && list[0].role === 'system')) return list;
    return [{ role: 'system', content: system }].concat(list);
  }

  return {
    SETTINGS_KEY: SETTINGS_KEY,
    PRESETS_KEY: PRESETS_KEY,
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    LOAD_TIME: LOAD_TIME,
    clean: clean,
    get: get,
    set: set,
    reset: reset,
    presets: presets,
    savePreset: savePreset,
    deletePreset: deletePreset,
    needsReload: needsReload,
    estimate: estimate,
    ollamaOptions: ollamaOptions,
    openaiParams: openaiParams,
    loadArgs: loadArgs,
    withSystem: withSystem,
    LIMITS_KEY: LIMITS_KEY,
    CTX_STEPS: CTX_STEPS,
    DEFAULT_KV_BYTES: DEFAULT_KV_BYTES,
    AUTO_CAP: AUTO_CAP,
    limitsFor: limitsFor,
    setLimits: setLimits,
    parseOllamaShow: parseOllamaShow,
    parseLlamaModels: parseLlamaModels,
    parseGgufInfo: parseGgufInfo,
    autoCtx: autoCtx,
    effectiveCtx: effectiveCtx,
    ctxSteps: ctxSteps,
  };
});
