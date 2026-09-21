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
    var kv = ctx * 0.000128;
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
  };
});
