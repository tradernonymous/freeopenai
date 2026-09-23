// HuggingFace Model Browser for the desktop app.
//
// Search api.huggingface.co/models, show GGUF quants/sizes/license, download
// with progress + resume + sha256 verify, and feed files to the local
// llama-server (Phase 2 local models).
//
// This module is pure transport and data shaping: the UI is in
// LocalModelsCard.tsx (the Settings card) and the shell's download machinery
// is in bridge.ts (remote_download). This module is testable without a
// browser or a Tauri shell because it only builds URLs and shapes responses.
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UHfModels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var HF_API = 'https://huggingface.co/api';

  /**
   * Percent-encode a repo id or a file path SEGMENT BY SEGMENT.
   *
   * encodeURIComponent on the whole thing turns the separator into %2F, and a
   * repo id is two segments: Hugging Face answers 400 "repo name includes an
   * url-encoded slash" and the lookup never happens. The same is true of a
   * file that lives in a subfolder of the repo. Each segment still needs
   * encoding -- a filename may contain spaces, '#' or '?'.
   */
  function encodePath(path) {
    return String(path || '')
      .split('/')
      .map(function (part) { return encodeURIComponent(part); })
      .join('/');
  }

  // --- search -------------------------------------------------------------

  /**
   * searchModels(query, { limit, sort, filter })
   *
   * Returns an array of model cards from the Hub. The query is free-text;
   * we append GGUF to narrow the results to what llama.cpp can load.
   *
   * Each card carries the fields the UI needs: id, author, downloads,
   * likes, tags, and siblings (the file list — where GGUF filenames live).
   */
  async function searchModels(query, opts) {
    var options = opts || {};
    var q = (query || '').trim();
    if (!q) q = 'GGUF';
    if (!/\bGGUF\b/i.test(q)) q += ' GGUF';

    var params = new URLSearchParams({
      search: q,
      limit: String(options.limit || 20),
      sort: options.sort || 'downloads',
      direction: options.direction || '-1',
    });
    if (options.filter) params.set('filter', options.filter);

    var authHeaders = options.authHeaders || {};
    var res = await fetch(HF_API + '/models?' + params.toString(), {
      headers: {
        Accept: 'application/json',
        ...authHeaders,
      },
    });
    if (!res.ok) {
      var body = await res.text();
      throw new Error('HF search failed (' + res.status + '): ' + body);
    }
    return res.json();
  }

  // --- model details ------------------------------------------------------

  /**
   * getModel(modelId, { authHeaders })
   *
   * Full model card including siblings (file list). The UI uses siblings to
   * show available quants and sizes without downloading anything.
   */
  async function getModel(modelId, opts) {
    var options = opts || {};
    // ?blobs=true: without it the Hub lists the files but not their sizes,
    // and every quant read "0.0 GB" with a made-up memory estimate under it.
    var res = await fetch(HF_API + '/models/' + encodePath(modelId) + '?blobs=true', {
      headers: {
        Accept: 'application/json',
        ...(options.authHeaders || {}),
      },
    });
    if (!res.ok) {
      var body = await res.text();
      throw new Error('HF model fetch failed (' + res.status + '): ' + body);
    }
    return res.json();
  }

  // --- GGUF file extraction -----------------------------------------------

  /**
   * Extract the GGUF files from a model card's siblings, with parsed metadata.
   *
   * Returns an array of { name, size, quant, fitsRam, url } sorted by size.
   * `fitsRam` is a rough heuristic: Q4 quants up to ~5 GB fit 8 GB RAM,
   * Q5/Q8 up to ~10 GB fit 16 GB RAM.
   */
  function ggufFiles(card) {
    var siblings = Array.isArray(card?.siblings) ? card.siblings : [];
    var files = [];
    for (var i = 0; i < siblings.length; i++) {
      var s = siblings[i];
      var name = s.rfilename || s.name || '';
      if (!/\.gguf$/i.test(name)) continue;
      // Older API shapes carry the size on the LFS pointer instead.
      var size = Number(s.size || (s.lfs && s.lfs.size) || 0);
      var quant = parseQuant(name);
      var fitsRam = estimateFitsRam(size, quant);
      var url = 'https://huggingface.co/' + encodePath(card.id || '') + '/resolve/main/' + encodePath(name);
      files.push({ name: name, size: size, quant: quant, fitsRam: fitsRam, url: url });
    }
    files.sort(function (a, b) { return a.size - b.size; });
    return files;
  }

  /**
   * Parse the quantization tag from a GGUF filename.
   * Common patterns: Q4_K_M, Q5_K_S, Q8_0, F16, IQ4_XS, etc.
   */
  function parseQuant(filename) {
    var base = (filename || '').replace(/\.gguf$/i, '');
    // Look for the quant pattern: Q[0-9]_[A-Z_]+ or IQ[0-9]_[A-Z_]+ or F16/F32/BF16
    var match = base.match(/(IQ[0-9]+_[A-Z0-9_]+|Q[0-9]+_[A-Z0-9_]+|F16|F32|BF16|IQ[0-9]+X[ST])/i);
    return match ? match[1].toUpperCase() : '';
  }

  /**
   * Rough heuristic: does this file fit in N GB of RAM?
   * A GGUF file uses roughly its file size in RAM (some overhead for the
   * KV cache, but the quantized weights dominate).
   */
  function estimateFitsRam(sizeBytes, quant) {
    var gb = sizeBytes / (1024 * 1024 * 1024);
    // Q4 fits in 8 GB with room for the OS and KV cache.
    if (/^Q4/.test(quant) && gb <= 4.5) return '8gb';
    // Q4, Q5 and small Q8 fit in 16 GB.
    if (/^(Q[4568]|IQ[34])/.test(quant) && gb <= 9) return '16gb';
    // Everything else: check if it fits 32 GB.
    if (gb <= 28) return '32gb';
    return '';
  }

  // --- download URL -------------------------------------------------------

  /**
   * The direct-download URL for a file in a repo.
   * When the user has a token, gated repos unlock automatically.
   */
  function fileUrl(modelId, filename) {
    // No token in the URL, ever: a URL is logged by proxies, kept in history
    // and pasted into bug reports, and HF has deprecated ?token= anyway. A
    // gated repo is unlocked with an Authorization header at download time
    // (the shell adds it -- net.rs), which is where the token already lives.
    return 'https://huggingface.co/' + encodePath(modelId) + '/resolve/main/' + encodePath(filename);
  }

  // --- format helpers for the UI ------------------------------------------

  function formatSize(bytes) {
    var n = Number(bytes || 0);
    if (!isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function licenseShort(card) {
    var tags = Array.isArray(card?.tags) ? card.tags : [];
    for (var i = 0; i < tags.length; i++) {
      if (/^license:/i.test(tags[i])) return tags[i].slice(8);
    }
    var lic = card?.cardData?.license || card?.license || '';
    return typeof lic === 'string' ? lic : '';
  }

  function isGated(card) {
    // HF marks gated models with a tag or a flag.
    var tags = Array.isArray(card?.tags) ? card.tags : [];
    return tags.indexOf('gated') >= 0 || tags.indexOf('requires-approval') >= 0 || !!card?.gated;
  }

  // --- images and dictation ---------------------------------------------
  //
  // The same downloader feeds three tools, and each loads different files
  // from a different folder. The shell holds the same table (models.rs
  // Kind) and refuses on its own; this copy is here so a row the shell would
  // refuse is never offered in the first place.

  var KINDS = {
    text: { extensions: ['gguf'], folder: 'models' },
    image: { extensions: ['safetensors', 'gguf'], folder: 'sd-models' },
    voice: { extensions: ['bin'], folder: 'whisper-models' },
  };

  var PICKLE_REASON = 'is a pickled checkpoint, and loading one can run arbitrary code on this PC. ' +
    'Pick the .safetensors or .gguf file of the same model.';

  function baseOf(name) {
    var parts = String(name || '').split('/');
    return parts[parts.length - 1];
  }

  /**
   * Why a kind will not fetch a file, or '' when it will. Mirrors
   * Kind::check_file in models.rs, words included.
   */
  function kindRefusal(kind, name) {
    var file = String(name || '');
    var lower = file.toLowerCase();
    if (!KINDS[kind] || kind === 'text') {
      return /\.gguf$/.test(lower) ? '' : file + ' is not a .gguf file';
    }
    var base = baseOf(lower);
    // .ckpt is what sd.cpp would read and what this app will not fetch: a
    // pickle from a stranger's repo can run code the moment it is loaded.
    if (/\.(ckpt|pt|pth|pkl|pickle)$/.test(lower) || /^(pytorch_model|training_args)/.test(base)) {
      return file + ' ' + PICKLE_REASON;
    }
    var ok = KINDS[kind].extensions.some(function (ext) { return lower.endsWith('.' + ext); });
    if (ok) return '';
    return kind === 'image'
      ? file + ' is not a .safetensors or .gguf file, the formats sd-server loads'
      : file + ' is not a ggml .bin file, the format whisper.cpp loads';
  }

  /** Every file of a repo listing with its real size (from ?blobs=true). */
  function repoFiles(card) {
    var siblings = Array.isArray(card && card.siblings) ? card.siblings : [];
    return siblings.map(function (s) {
      return { name: String(s.rfilename || s.name || ''), size: Number(s.size || (s.lfs && s.lfs.size) || 0) };
    }).filter(function (f) { return !!f.name; });
  }

  // Which part of a model a folder holds, by the folder names split repos
  // use. Read off the folder, never the repo name, so a new repo with the
  // same layout is recognised without a list to keep up to date.
  var ROLE_FOLDERS = {
    diffusion: /^(diffusion_models?|unet|transformer|dit)$/,
    vae: /^vae$/,
    encoder: /^(text_encoders?|text_encoder_\d|clip|t5|llm)$/,
  };

  function roleOf(name) {
    var folders = String(name || '').toLowerCase().split('/').slice(0, -1);
    for (var i = folders.length - 1; i >= 0; i--) {
      for (var role in ROLE_FOLDERS) {
        if (ROLE_FOLDERS[role].test(folders[i])) return role;
      }
    }
    return '';
  }

  /** A root file that is a part, not a model: a VAE, an encoder, a LoRA. */
  function looksLikeComponent(name) {
    return /(^|[-_.])(vae|ae|clip|clip_[lg]|t5|t5xxl|text_encoder|lora|mmproj)([-_.]|$)/i.test(baseOf(name));
  }

  /** The name with its format, quant and precision taken off: two files with
   *  the same stem are alternatives (Q4 or Q8 of one encoder), two with
   *  different stems are both needed (clip_l and t5xxl). */
  function stemOf(name) {
    return baseOf(name)
      .replace(/\.[^.]+$/, '')
      .replace(/[-_.]?(IQ\d+_[A-Z0-9_]+|Q\d+_[A-Z0-9_]+|Q\d+|BF16|FP16|FP32|F16|F32|FP8(_E4M3FN|_E5M2)?(_SCALED)?)$/i, '')
      .toLowerCase();
  }

  function folderName(name) {
    return baseOf(name).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+|\.+$/g, '') || 'set';
  }

  /**
   * What an image repo offers sd-server: single-file checkpoints, and
   * component sets (one diffusion model with the VAE and text encoders it
   * needs, fetched as one unit). A diffusers-layout repo offers only a
   * merged checkpoint at its root, and says so plainly when it has none.
   *
   * Returns { rows: [{ key, label, note, files: [{name,size}], size, set }],
   *           diffusers, message }.
   */
  function imageOffer(card) {
    var repo = String((card && card.id) || 'This repo');
    var all = repoFiles(card);
    var usable = all.filter(function (f) { return !kindRefusal('image', f.name); });
    var pickles = all.filter(function (f) { return /\.ckpt$/i.test(f.name); });
    var diffusers = all.some(function (f) { return f.name === 'model_index.json'; });
    var rows = [];

    var single = function (f) {
      return { key: f.name, label: baseOf(f.name), note: 'single file', files: [f], size: f.size, set: '' };
    };

    if (diffusers) {
      // unet/, vae/, text_encoder/ are diffusers' own format, which
      // stable-diffusion.cpp does not read. Only a merged file at the root is.
      usable.filter(function (f) { return f.name.indexOf('/') < 0 && !looksLikeComponent(f.name); })
        .forEach(function (f) { rows.push(single(f)); });
      rows.sort(function (a, b) { return a.size - b.size; });
      return {
        rows: rows,
        diffusers: true,
        message: rows.length ? '' : repo + ' is in the diffusers layout, which stable-diffusion.cpp cannot load, and it has no single-file checkpoint at its root.',
      };
    }

    var byRole = { diffusion: [], vae: [], encoder: [] };
    usable.forEach(function (f) {
      var role = roleOf(f.name);
      if (role) byRole[role].push(f);
    });

    if (byRole.diffusion.length && byRole.vae.length + byRole.encoder.length > 0) {
      // Group the other parts by stem; each group needs exactly one file.
      var groups = {};
      byRole.vae.concat(byRole.encoder).forEach(function (f) {
        var key = roleOf(f.name) + ':' + stemOf(f.name);
        (groups[key] = groups[key] || []).push(f);
      });
      byRole.diffusion.forEach(function (d) {
        var quant = parseQuant(d.name);
        var files = [d];
        Object.keys(groups).sort().forEach(function (key) {
          var options = groups[key].slice().sort(function (a, b) { return a.size - b.size; });
          // The part whose quant matches the model's, else the smallest:
          // the first person this is for has a 4 GB card.
          var match = quant ? options.filter(function (o) { return parseQuant(o.name) === quant; })[0] : null;
          files.push(match || options[0]);
        });
        rows.push({
          key: d.name,
          label: baseOf(d.name),
          note: 'diffusion model with ' + files.slice(1).map(function (f) { return baseOf(f.name); }).join(', '),
          files: files,
          size: files.reduce(function (sum, f) { return sum + f.size; }, 0),
          set: folderName(d.name),
        });
      });
    }

    usable.filter(function (f) { return !roleOf(f.name) && !looksLikeComponent(f.name); })
      .forEach(function (f) { rows.push(single(f)); });

    rows.sort(function (a, b) { return a.size - b.size; });
    var message = '';
    if (!rows.length) {
      message = pickles.length
        ? repo + ' only has .ckpt checkpoints, which can run code when loaded, so this app does not fetch them.'
        : repo + ' has no .safetensors or .gguf weights sd-server can load.';
    }
    return { rows: rows, diffusers: false, message: message };
  }

  /** What a repo offers whisper.cpp: its ggml .bin files. */
  function voiceOffer(card) {
    var repo = String((card && card.id) || 'This repo');
    var all = repoFiles(card);
    var rows = all.filter(function (f) { return !kindRefusal('voice', f.name); })
      .map(function (f) { return { key: f.name, label: baseOf(f.name), note: 'ggml model', files: [f], size: f.size, set: '' }; })
      .sort(function (a, b) { return a.size - b.size; });
    var message = '';
    if (!rows.length) {
      var transformers = all.some(function (f) { return /^(pytorch_model.*\.bin|model\.safetensors)$/i.test(baseOf(f.name)); });
      message = transformers
        ? repo + ' is a transformers checkpoint; whisper.cpp needs ggml .bin files, like those in ggerganov/whisper.cpp.'
        : repo + ' has no ggml .bin model for whisper.cpp.';
    }
    return { rows: rows, diffusers: false, message: message };
  }

  /**
   * An honest note on whether a download fits THIS machine. `spec` is
   * { ramGb, vramGb } as the app already reads them: the memory the webview
   * reports, and the GPU size typed in Run settings (a window cannot measure
   * VRAM). A model too big for the GPU is not hidden; it is said to run from
   * RAM, slowly.
   */
  function fitNote(bytes, kind, spec) {
    var s = spec || {};
    var ram = Number(s.ramGb) > 0 ? Number(s.ramGb) : 4;
    var vram = Number(s.vramGb) > 0 ? Number(s.vramGb) : 0;
    // Weights plus working room: the latent and the VAE decode for a
    // picture, the audio buffers and decoder state for a dictation.
    var overhead = kind === 'voice' ? 0.5 : 1;
    var needed = Number(bytes || 0) / (1024 * 1024 * 1024) + overhead;
    var fitsRam = needed <= ram * 0.8;
    var fitsVram = vram > 0 && needed <= vram;
    var text;
    if (!fitsRam) {
      text = 'Needs about ' + needed.toFixed(1) + ' GB; this PC reports ' + ram + ' GB of memory, so it may not load at all.';
    } else if (fitsVram) {
      text = 'Fits your ' + vram + ' GB GPU.';
    } else if (vram > 0) {
      text = 'Larger than your ' + vram + ' GB GPU: it will run from RAM, and slowly.';
    } else {
      text = 'Fits in memory. Set your GPU memory in Run settings to see whether it fits the GPU.';
    }
    return { neededGb: needed, fitsRam: fitsRam, fitsVram: fitsVram, text: text };
  }

  /** The file a pasted blob or resolve link points at, or ''. */
  function pastedFile(input) {
    var m = String(input || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/[^\/?#\s]+\/[^\/?#\s]+\/(?:blob|resolve)\/[^\/?#\s]+\/([^?#\s]+)/i);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  return {
    KINDS: KINDS,
    kindRefusal: kindRefusal,
    repoFiles: repoFiles,
    imageOffer: imageOffer,
    voiceOffer: voiceOffer,
    fitNote: fitNote,
    pastedFile: pastedFile,
    HF_API: HF_API,
    searchModels: searchModels,
    getModel: getModel,
    ggufFiles: ggufFiles,
    parseQuant: parseQuant,
    estimateFitsRam: estimateFitsRam,
    fileUrl: fileUrl,
    formatSize: formatSize,
    licenseShort: licenseShort,
    isGated: isGated,
  };
});
