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

  return {
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
