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

  // Unsloth's Dynamic 2.0 GGUFs, one file each, sizes read from the Hub API
  // on 2026-09-22 and rounded up; they are what the fit check uses. The
  // UD-Q4_K_XL quant is Unsloth's own recommended default, and every entry
  // here keeps tool calling intact (their guide: 1-bit quants do not).
  // Smallest first so a 4 GB machine sees something it can run at the top.
  var CATALOGUE = [
    {
      id: 'unsloth/Qwen3.5-4B-GGUF',
      file: 'Qwen3.5-4B-UD-Q4_K_XL.gguf',
      label: 'Qwen3.5 4B',
      note: 'Small and quick: drafts, summaries, short coding help. Runs on a CPU.',
      quant: 'UD-Q4_K_XL',
      sizeGb: 2.8,
      context: 16384,
      quality: 'light',
    },
    {
      id: 'unsloth/gemma-4-E2B-it-GGUF',
      file: 'gemma-4-E2B-it-UD-Q4_K_XL.gguf',
      label: 'Gemma 4 E2B',
      note: 'Chat and writing on laptops with no GPU or 4 GB of VRAM.',
      quant: 'UD-Q4_K_XL',
      sizeGb: 3.0,
      context: 16384,
      quality: 'light',
    },
    {
      id: 'unsloth/gemma-4-E4B-it-GGUF',
      file: 'gemma-4-E4B-it-UD-Q4_K_XL.gguf',
      label: 'Gemma 4 E4B',
      note: 'The everyday model for an 8 GB machine: good answers, tool calls that work.',
      quant: 'UD-Q4_K_XL',
      sizeGb: 4.8,
      context: 32768,
      quality: 'good',
    },
    {
      id: 'unsloth/Qwen3.5-9B-GGUF',
      file: 'Qwen3.5-9B-UD-Q4_K_XL.gguf',
      label: 'Qwen3.5 9B',
      note: 'Better reasoning and coding; wants 8 GB of VRAM or 16 GB of RAM.',
      quant: 'UD-Q4_K_XL',
      sizeGb: 5.6,
      context: 32768,
      quality: 'good',
    },
    {
      id: 'unsloth/gemma-4-12b-it-GGUF',
      file: 'gemma-4-12b-it-UD-Q4_K_XL.gguf',
      label: 'Gemma 4 12B',
      note: 'A strong general model for a 16 GB machine.',
      quant: 'UD-Q4_K_XL',
      sizeGb: 6.9,
      context: 32768,
      quality: 'good',
    },
    {
      id: 'unsloth/gpt-oss-20b-GGUF',
      file: 'gpt-oss-20b-UD-Q4_K_XL.gguf',
      label: 'gpt-oss 20B',
      note: 'OpenAI’s open model: agent and tool-heavy work on 12–16 GB.',
      quant: 'UD-Q4_K_XL',
      sizeGb: 11.1,
      context: 32768,
      quality: 'best',
    },
    {
      id: 'unsloth/Qwen3.8-27B-GGUF',
      file: 'Qwen3.8-27B-UD-Q4_K_XL.gguf',
      label: 'Qwen3.8 27B',
      note: 'Frontier-class open model for a 24 GB GPU or 32 GB of RAM.',
      quant: 'UD-Q4_K_XL',
      sizeGb: 16.4,
      context: 32768,
      quality: 'best',
    },
    {
      id: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
      file: 'Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf',
      label: 'Qwen3 Coder 30B (MoE)',
      note: 'The strongest free coder here; a mixture-of-experts, so fast for its size.',
      quant: 'UD-Q4_K_XL',
      sizeGb: 16.5,
      context: 32768,
      quality: 'best',
    },
  ];

  // ---- what the user pasted -------------------------------------------------

  /**
   * parseHfRef(input)
   *
   * Everything a person might paste to name a model, reduced to
   * { repo, file, quant }: a repo id, a Hub URL (the repo page, a folder, a
   * file under blob/ or resolve/), a `repo:QUANT` spec, an hf.co short link,
   * or a neuraos://model?repo=&file= deep link. null when it is none of those.
   */
  function parseHfRef(input) {
    var text = String(input || '').trim();
    if (!text) return null;
    var repo = '';
    var file = '';
    var quant = '';
    var m;
    if (/^neuraos:\/\//i.test(text)) {
      try {
        var u = new URL(text);
        repo = u.searchParams.get('repo') || u.searchParams.get('model') || '';
        file = u.searchParams.get('file') || '';
        quant = u.searchParams.get('quant') || '';
      } catch {
        return null;
      }
    } else if ((m = text.match(/^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/([^\/?#\s]+)\/([^\/?#\s]+)(?:\/(?:tree|blob|resolve)\/[^\/?#\s]+(?:\/([^?#\s]+))?)?\/?(?:[?#].*)?$/i))) {
      repo = m[1] + '/' + m[2];
      var rest = m[3] ? decodeURIComponent(m[3]) : '';
      if (/\.gguf$/i.test(rest)) file = rest;
      else if (rest && parseQuant(rest)) quant = parseQuant(rest);
    } else if ((m = text.match(/^([\w.-]+)\/([\w.-]+)(?::([\w.-]+))?$/))) {
      repo = m[1] + '/' + m[2];
      quant = m[3] || '';
    } else {
      return null;
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(function (p) { return p.startsWith('.'); })) return null;
    if (!quant && file) quant = parseQuant(file);
    return { repo: repo, file: file, quant: quant.toUpperCase() };
  }

  /** The quant tag in a file name: UD-Q4_K_XL, Q4_K_M, IQ2_XXS, BF16... */
  function parseQuant(name) {
    var base = String(name || '').replace(/\.gguf$/i, '');
    var m = base.match(/((?:UD-)?(?:IQ[0-9]+_[A-Z0-9_]+|Q[0-9]+_[A-Z0-9_]+)|BF16|F16|F32)/i);
    return m ? m[1].toUpperCase() : '';
  }

  // ---- multi-part (split) GGUFs ---------------------------------------------
  //
  // A big quant is published as …-00001-of-00003.gguf, …-00002-of-00003.gguf,
  // and so on. llama.cpp loads the whole set when it is handed part 1 with the
  // others beside it, so the app treats a set as ONE model: every part is
  // downloaded (one after another, each with the shell's own resume), the
  // saved model points at part 1, the size is the sum, and delete takes all.

  var SPLIT_RE = /-(\d{5})-of-(\d{5})(\.gguf)$/i;

  /** { index, count, stem } for one part of a set, else null. The stem is
   *  everything before the part suffix, folder included. */
  function splitInfo(name) {
    var text = String(name || '');
    var m = text.match(SPLIT_RE);
    if (!m) return null;
    var index = Number(m[1]);
    var count = Number(m[2]);
    if (index < 1 || count < 1 || index > count) return null;
    return { index: index, count: count, stem: text.slice(0, m.index) };
  }

  /** Multi-part files (…-00001-of-00003.gguf): one part of a set. */
  function isSplit(name) {
    return !!splitInfo(name);
  }

  /**
   * Every part name of the set `name` belongs to, part 1 first, from any one
   * part (the folder and the digit widths are kept). A single file is a set of
   * one.
   */
  function splitParts(name) {
    var text = String(name || '');
    var info = splitInfo(text);
    if (!info) return [text];
    var m = text.match(SPLIT_RE);
    var width = m[1].length;
    var parts = [];
    for (var i = 1; i <= info.count; i++) {
      var digits = String(i);
      while (digits.length < width) digits = '0' + digits;
      parts.push(info.stem + '-' + digits + '-of-' + m[2] + m[3]);
    }
    return parts;
  }

  /** What to call a model file: the base name without .gguf or a part suffix. */
  function modelName(fileOrPath) {
    var base = String(fileOrPath || '').split(/[\\/]/).pop() || '';
    var info = splitInfo(base);
    return (info ? info.stem : base).replace(/\.gguf$/i, '');
  }

  /**
   * groupHubFiles(files)
   *
   * A repo's file list ({ name, size, ... }) with each split set folded into
   * one row: `name` is part 1, `size` the sum, `parts` / `partSizes` every
   * part in order, and `complete` false when the listing is missing a part
   * (such a set is shown, never offered). A single file is a set of one. Rows
   * that were already grouped pass through, so grouping twice is harmless.
   */
  function groupHubFiles(files) {
    var out = [];
    var sets = {};
    (Array.isArray(files) ? files : []).forEach(function (f) {
      if (!f) return;
      if (Array.isArray(f.parts)) {
        out.push(f);
        return;
      }
      var info = splitInfo(f.name);
      if (!info) {
        out.push(Object.assign({}, f, { parts: [f.name], partSizes: [Number(f.size || 0)], complete: true }));
        return;
      }
      var parts = splitParts(f.name);
      var key = parts[0].toLowerCase();
      var row = sets[key];
      if (!row) {
        row = Object.assign({}, f, { name: parts[0], size: 0, parts: parts, partSizes: parts.map(function () { return 0; }), complete: false, seen: {} });
        sets[key] = row;
        out.push(row);
      }
      if (info.index === 1) Object.assign(row, f, { name: parts[0], parts: parts, partSizes: row.partSizes, seen: row.seen });
      row.partSizes[info.index - 1] = Number(f.size || 0);
      row.seen[info.index] = true;
    });
    return out.map(function (row) {
      if (!row.seen) return row;
      var done = Object.assign({}, row);
      done.size = row.partSizes.reduce(function (a, b) { return a + b; }, 0);
      done.complete = row.parts.every(function (_, i) { return row.seen[i + 1]; });
      delete done.seen;
      return done;
    });
  }

  /**
   * groupLocalFiles(files)
   *
   * The shell's file rows ({ file, path, bytes, partial }) with each split set
   * in one folder folded into one row: `file` and `path` name part 1, `bytes`
   * is the sum, `parts` every part's file name, `missing` the parts not there,
   * and `partial` true when any part is a .part or missing (resumable, not
   * runnable). A single file keeps its own fields plus parts: [file].
   */
  function groupLocalFiles(files) {
    var out = [];
    var sets = {};
    (Array.isArray(files) ? files : []).forEach(function (f) {
      if (!f) return;
      var info = splitInfo(f.file);
      if (!info) {
        out.push(Object.assign({}, f, { parts: [f.file], missing: [], complete: true }));
        return;
      }
      var dir = String(f.path || '').replace(/[^\\/]*$/, '');
      var parts = splitParts(f.file);
      var key = (dir + parts[0]).toLowerCase();
      var row = sets[key];
      if (!row) {
        row = { file: parts[0], path: dir + parts[0], bytes: 0, partial: false, parts: parts, have: {} };
        sets[key] = row;
        out.push(row);
      }
      row.bytes += Number(f.bytes || 0);
      if (f.partial) row.partial = true;
      else row.have[info.index] = true;
    });
    return out.map(function (row) {
      if (!row.have) return row;
      var missing = row.parts.filter(function (_, i) { return !row.have[i + 1]; });
      return {
        file: row.file,
        path: row.path,
        bytes: row.bytes,
        partial: row.partial || missing.length > 0,
        parts: row.parts,
        missing: missing,
        complete: missing.length === 0,
      };
    });
  }

  /**
   * setProgress(set, progress)
   *
   * One part's `local-download` event restated as progress through the whole
   * set. `set` is { file, index, count, before, total }: part 1's name, the
   * 0-based part in flight, how many parts, the bytes the earlier parts
   * already have, and the set's size from the listing (0 when unknown, in
   * which case the part's own total stands in). Done only when the last part
   * is.
   */
  function setProgress(set, progress) {
    var s = set || {};
    var p = progress || {};
    var before = Number(s.before || 0);
    var count = Number(s.count || 1);
    var index = Number(s.index || 0);
    var partTotal = Number(p.total || 0);
    return {
      repo: String(p.repo || ''),
      file: String(s.file || p.file || ''),
      received: before + Number(p.received || 0),
      total: Number(s.total || 0) > 0 ? Number(s.total) : (partTotal ? before + partTotal : 0),
      done: !!p.done && index === count - 1,
      cancelled: !!p.cancelled,
      error: String(p.error || ''),
      path: String(p.path || ''),
      part: index + 1,
      parts: count,
    };
  }

  /**
   * What a quant does to tool calling, in words. Unsloth's own tool-calling
   * guide: 1-bit quants break it; 2-bit is the smallest that still works.
   */
  function toolRisk(quant) {
    var q = String(quant || '').toUpperCase();
    if (/(^|-)(IQ1|Q1)/.test(q)) return 'breaks tool calling (1-bit)';
    if (/(^|-)(IQ2|Q2)/.test(q)) return 'weaker tool calling (2-bit)';
    return '';
  }

  /**
   * quantRank(quant)
   *
   * The order the app prefers quants in when the user has not named one: the
   * file with the LOWEST rank that also fits the machine is the default. A
   * rank of Infinity means "never pick this on the user's behalf" (it can
   * still be chosen by hand).
   *
   * The order (the user's decision, 2026-09-22): Unsloth's UD-Q4_K_XL first,
   * plain Q4_K_M as the fallback, then the Q5/Q6 middle, other Q4s, and
   * UD-Q2_K_XL / IQ2 only when nothing bigger fits. Q8_0, BF16, F16 and F32
   * are never auto-picked: they are for people with memory to spare and are
   * rarely the right default. 1-bit is refused before this is consulted.
   */
  function quantRank(quant) {
    var q = String(quant || '').toUpperCase();
    if (!q) return Infinity;
    if (q === 'UD-Q4_K_XL') return 0;
    if (q === 'Q4_K_M') return 1;
    if (/^(UD-)?Q[56]_/.test(q)) return 2;
    if (/^(UD-)?(Q4|IQ4|IQ3|Q3)_/.test(q)) return 3;
    if (/^(UD-)?(Q2|IQ2)_/.test(q)) return 4;
    if (/^(UD-)?(Q8|BF16|F16|F32)/.test(q)) return Infinity;
    return 5;
  }

  /**
   * The file to offer first from a repo's GGUF list: a split set counts as
   * one file the size of all its parts (named by part 1), and a set the
   * listing is missing a part of is skipped, as are tool-breaking quants; then
   * the best-ranked quant that fits this machine, then the best-ranked quant
   * at all.
   */
  function pickDefaultFile(files, machineInfo) {
    var spec = machineInfo || machine();
    var rows = groupHubFiles(files)
      .filter(function (f) { return f && /\.gguf$/i.test(f.name || '') && f.complete !== false; })
      .map(function (f) {
        var quant = parseQuant(f.name);
        return {
          file: f,
          quant: quant,
          rank: quantRank(quant),
          fits: fit({ sizeGb: Number(f.size || 0) / GB, context: 16384 }, spec).fits,
        };
      })
      .filter(function (r) { return isFinite(r.rank) && !/1-bit/.test(toolRisk(r.quant)); })
      .sort(function (a, b) { return a.rank - b.rank || Number(a.file.size || 0) - Number(b.file.size || 0); });
    if (!rows.length) return null;
    var fitting = rows.filter(function (r) { return r.fits; });
    return (fitting[0] || rows[0]).file;
  }

  /** "1.2 of 4.8 GB · 25%" for a download in flight; a split set adds
   *  "· part 2 of 3" while it is still going. */
  function downloadLabel(progress) {
    var p = progress || {};
    var got = Number(p.received || 0) / GB;
    var total = Number(p.total || 0) / GB;
    var part = Number(p.parts || 0) > 1 ? ' · part ' + p.part + ' of ' + p.parts : '';
    if (p.error) return 'Stopped: ' + p.error;
    if (p.cancelled) return 'Paused at ' + got.toFixed(1) + ' GB' + part;
    if (p.done) return total.toFixed(1) + ' GB, done';
    if (!total) return got.toFixed(2) + ' GB so far' + part;
    return got.toFixed(1) + ' of ' + total.toFixed(1) + ' GB · ' + Math.floor((got / total) * 100) + '%' + part;
  }

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

  // How long the shell waits for the server to answer /health before it kills
  // it and says so (models.rs). The loading ring reports against this number
  // rather than against a guess at how far a file read has got: a bar that
  // pretends to measure something is worse than no bar.
  var WARMUP_MS = 180000;

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

  /** What to call a running model: the repo's name, or the file's. */
  function shortName(value) {
    var v = value || {};
    if (v.repo) return String(v.repo).split('/').pop();
    if (v.file) return String(v.file).split(/[\\/]/).pop().replace(/\.gguf$/i, '');
    return 'model';
  }

  /** The one-line chip: what is loaded, on which port, for how long. */
  function statusLine(status) {
    var value = status || {};
    var state = stateOf(value);
    if (state === 'stopped') return 'No local model running';
    if (state === 'error') return 'Local model failed: ' + (value.detail || 'no reason reported');
    var name = shortName(value);
    var where = value.base_url || ('http://127.0.0.1:' + (value.port || ''));
    if (state === 'starting') return 'Loading ' + name + '…';
    var seconds = Math.max(0, Math.round(Number(value.uptime_ms || 0) / 1000));
    return name + ' ready · ' + where + ' · up ' + seconds + 's';
  }

  /** The provider row Chat shows for a model running here. */
  function providerRow(status) {
    var value = status || {};
    if (stateOf(value) !== 'ready') return null;
    var name = shortName(value);
    return {
      id: 'local',
      label: 'Local · ' + name,
      configured: true,
      kind: 'chat',
      baseUrl: value.base_url,
      local: true,
      model: value.repo || name,
      // The key the shell started the server with; api.ts sends it.
      apiKey: String(value.api_key || ''),
      file: String(value.file || ''),
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

  /**
   * Progress through the shell's warm-up wait, or null when nothing is loading.
   *
   * The numbers are the shell's own: elapsed time against the same deadline it
   * will give up at, so "42s of 180s" is a fact about this machine rather than
   * a decoration that fills at a pleasing speed.
   */
  function warmup(status) {
    var value = status || {};
    if (stateOf(value) !== 'starting') return null;
    var elapsed = Math.max(0, Number(value.uptime_ms || 0));
    var seconds = Math.round(elapsed / 1000);
    var deadline = Math.round(WARMUP_MS / 1000);
    return {
      elapsedSeconds: seconds,
      deadlineSeconds: deadline,
      fraction: Math.min(1, elapsed / WARMUP_MS),
      label: seconds + 's of ' + deadline + 's',
    };
  }

  return {
    CATALOGUE: CATALOGUE,
    parseHfRef: parseHfRef,
    parseQuant: parseQuant,
    isSplit: isSplit,
    splitInfo: splitInfo,
    splitParts: splitParts,
    modelName: modelName,
    groupHubFiles: groupHubFiles,
    groupLocalFiles: groupLocalFiles,
    setProgress: setProgress,
    toolRisk: toolRisk,
    quantRank: quantRank,
    pickDefaultFile: pickDefaultFile,
    downloadLabel: downloadLabel,
    STATES: STATES,
    WARMUP_MS: WARMUP_MS,
    warmup: warmup,
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
