// Running a model on this machine: what to offer, whether it fits, and what the
// state is.
//
// Three decisions, all of them rules rather than screen code:
//
//   1. THE CATALOGUE. A short list of GGUF repos with the quant and the file
//      size, so the app can say "4.7 GB" before a byte moves and can pick a
//      default quant per size class.
//   2. THE FIT CHECK. Starting a model the machine cannot hold is the one way
//      this feature can freeze someone's computer, so it is a guard rather
//      than a warning: the app knows the RAM (`navigator.deviceMemory` is
//      capped and rounded, so it is a floor, not a measurement) and refuses to
//      start something that cannot load, with the numbers said out loud.
//   3. THE STATE MACHINE. stopped -> starting -> ready -> error, with the
//      transitions the shell actually reports (`/health` answers 200 only once
//      the weights are in memory; the process exiting is the error).
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4ULocalModels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var GB = 1024 * 1024 * 1024;

  // Sizes are the published Q4_K_M file sizes, rounded up, and they are what
  // the fit check uses. A repo with no listed quant lets llama.cpp choose.
  var CATALOGUE = [
    {
      id: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
      label: 'Qwen3 Coder 30B (MoE)',
      note: 'The strongest free coder here, and a mixture-of-experts, so it is fast for its size.',
      quant: 'Q4_K_M',
      sizeGb: 18.6,
      context: 32768,
      quality: 'best',
    },
    {
      id: 'unsloth/Qwen2.5-Coder-7B-Instruct-GGUF',
      label: 'Qwen2.5 Coder 7B',
      note: 'The everyday coding model: good edits, quick on a laptop CPU.',
      quant: 'Q4_K_M',
      sizeGb: 4.7,
      context: 32768,
      quality: 'good',
    },
    {
      id: 'unsloth/gemma-3-4b-it-GGUF',
      label: 'Gemma 3 4B',
      note: 'General chat and writing. Small enough to leave running.',
      quant: 'Q4_K_M',
      sizeGb: 3.1,
      context: 32768,
      quality: 'good',
    },
    {
      id: 'unsloth/Llama-3.2-3B-Instruct-GGUF',
      label: 'Llama 3.2 3B',
      note: 'Fast, light, and honest about being small. Good first local model.',
      quant: 'Q4_K_M',
      sizeGb: 2.0,
      context: 16384,
      quality: 'light',
    },
    {
      id: 'unsloth/Llama-3.2-1B-Instruct-GGUF',
      label: 'Llama 3.2 1B',
      note: 'The smallest useful thing here: drafts, summaries, autocomplete.',
      quant: 'Q4_K_M',
      sizeGb: 0.8,
      context: 8192,
      quality: 'light',
    },
  ];

  /** What the machine can hold. `deviceMemory` is in GB, rounded down by the
   *  browser and capped at 8, so this is a floor and the guard is generous. */
  function machine() {
    var scope = typeof globalThis !== 'undefined' ? globalThis : {};
    var memory = Number(scope.navigator && scope.navigator.deviceMemory);
    var cores = Number(scope.navigator && scope.navigator.hardwareConcurrency);
    return {
      ramGb: isFinite(memory) && memory > 0 ? memory : 4,
      ramKnown: isFinite(memory) && memory > 0,
      cores: isFinite(cores) && cores > 0 ? cores : 4,
    };
  }

  /**
   * Whether a model can be started here.
   *
   * The weights are not the whole cost: llama.cpp needs room for the KV cache
   * at the context I ask for, plus what the OS and this app are already using.
   * The estimate is deliberately rough and deliberately conservative -- an
   * over-estimate refuses a model that would have worked, an under-estimate
   * freezes a computer.
   */
  function fit(entry, machineInfo) {
    var model = entry || {};
    var spec = machineInfo || machine();
    var weights = Number(model.sizeGb || 0) * GB;
    // ~128 KB per token of KV cache, per 1000 tokens of context, is the order
    // of magnitude for these quants; the context is halved for headroom.
    var context = Number(model.context || 8192);
    var kv = (context / 2) * 0.000128 * GB;
    var overhead = 1.5 * GB;
    var needed = weights + kv + overhead;
    var available = spec.ramGb * GB * 0.8;
    return {
      weightsGb: weights / GB,
      kvGb: kv / GB,
      neededGb: needed / GB,
      availableGb: spec.ramGb * 0.8,
      fits: needed <= available,
      // "Tight" is the honest middle: it should work, and it will make the
      // rest of the machine feel it.
      tight: needed > available * 0.75 && needed <= available,
      ramKnown: !!spec.ramKnown,
      reason: needed <= available
        ? ''
        : 'Needs about ' + (needed / GB).toFixed(1) + ' GB of memory; this machine reports ' +
          spec.ramGb + ' GB. Pick a smaller model.',
    };
  }

  /** The default context for a model: smaller models get a smaller window, so a
   *  4 GB laptop is not asked for a cache it cannot hold. */
  function contextFor(entry) {
    var model = entry || {};
    return Number(model.context || 8192);
  }

  /** The quant to ask for, if the caller did not name one. */
  function quantFor(entry) {
    return String((entry && entry.quant) || '');
  }

  var STATES = ['stopped', 'starting', 'ready', 'error'];

  /**
   * What the shell last reported, reduced to one state.
   *
   * `status` is the shape local_model_status returns: { state, detail, ... }.
   * A running process that is not answering yet is 'starting' -- never 'ready',
   * because a model that has not loaded cannot answer and saying it is ready is
   * how a first message disappears into a void.
   */
  function stateOf(status) {
    var value = status || {};
    var state = String(value.state || 'stopped');
    if (STATES.indexOf(state) < 0) return 'error';
    return state;
  }

  /** The one-line chip: what is loaded, on which port, for how long. */
  function statusLine(status) {
    var value = status || {};
    var state = stateOf(value);
    if (state === 'stopped') return 'No local model running';
    if (state === 'error') return 'Local model failed: ' + (value.detail || 'no reason reported');
    var name = value.repo ? String(value.repo).split('/').pop() : 'model';
    var where = value.base_url || ('http://127.0.0.1:' + (value.port || ''));
    if (state === 'starting') return 'Loading ' + name + '…';
    var seconds = Math.max(0, Math.round(Number(value.uptime_ms || 0) / 1000));
    return name + ' ready · ' + where + ' · up ' + seconds + 's';
  }

  /** The provider row Chat shows for a model running here. */
  function providerRow(status) {
    var value = status || {};
    if (stateOf(value) !== 'ready') return null;
    return {
      id: 'local',
      label: 'Local · ' + (value.repo ? String(value.repo).split('/').pop() : 'model'),
      configured: true,
      kind: 'chat',
      baseUrl: value.base_url,
      local: true,
      model: value.repo,
    };
  }

  /** The openai-shaped request a local server takes. */
  function chatBody(model, messages) {
    return {
      model: String(model || 'local'),
      messages: (Array.isArray(messages) ? messages : []).map(function (m) {
        return { role: m.role, content: m.content };
      }),
      stream: true,
    };
  }

  /** What a start failure means, in words worth acting on. */
  function startAdvice(message) {
    var text = String(message || '');
    if (/is not here yet/i.test(text)) return 'Install llama-server, or point the app at the file you downloaded.';
    if (/not become ready within/i.test(text)) {
      return 'It never became healthy — the model may be too large for this machine, or the quant may not exist in that repo.';
    }
    if (/exited with/i.test(text)) return 'The server stopped on its own; the log tail above is its own explanation.';
    if (/repository|repo|401|403|404/i.test(text)) return 'Check the repository path and whether that quant exists.';
    return 'Change the model or the settings, then start again.';
  }

  return {
    CATALOGUE: CATALOGUE,
    STATES: STATES,
    machine: machine,
    fit: fit,
    contextFor: contextFor,
    quantFor: quantFor,
    stateOf: stateOf,
    statusLine: statusLine,
    providerRow: providerRow,
    chatBody: chatBody,
    startAdvice: startAdvice,
  };
});
