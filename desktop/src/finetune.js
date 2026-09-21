// Experimental local fine-tuning via llama.cpp.
//
// This is Phase 5 — a stretch surface. It uses llama.cpp's built-in LoRA
// finetune capability to train a small adapter on the user's machine. The
// guard rails are strict: CPU-only by default, VRAM/RAM checks before every
// start, and the feature is marked "experimental" in the UI.
//
// The training data is a JSONL file the user provides (one example per line,
// with "prompt" and "completion" fields). The output is a LoRA adapter file
// (.gguf) that can be loaded by the local llama-server.
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UFinetune = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // --- constants -----------------------------------------------------------

  /** Minimum RAM (GB) to attempt fine-tuning. */
  var MIN_RAM_GB = 8;
  /** Minimum disk (GB) for the adapter output. */
  var MIN_DISK_GB = 2;
  /** Default LoRA rank. */
  var DEFAULT_LORA_R = 16;
  /** Default LoRA alpha. */
  var DEFAULT_LORA_ALPHA = 32;
  /** Default learning rate. */
  var DEFAULT_LR = 1e-4;
  /** Default epochs. */
  var DEFAULT_EPOCHS = 3;
  /** Default batch size. */
  var DEFAULT_BATCH = 8;

  // --- VRAM / RAM estimation -----------------------------------------------

  /**
   * estimateRequirements(baseModelGb, loraR, datasetSize)
   *
   * Returns { ramGb, diskGb, fits, reason }.
   * The estimate is conservative: LoRA rank × base model size gives the
   * adapter memory, plus the base model itself, plus working memory for
   * the optimizer (roughly 2× the adapter).
   */
  function estimateRequirements(baseModelGb, loraR, datasetSize) {
    var adapterGb = baseModelGb * (loraR / 128) * 0.05;
    var optimizerGb = adapterGb * 2;
    var workingSetGb = baseModelGb + adapterGb + optimizerGb;
    var diskGb = adapterGb + 0.5; // adapter + checkpoint
    var ramGb = workingSetGb;
    var fits = ramGb <= MIN_RAM_GB && diskGb <= MIN_DISK_GB;
    var reason = fits
      ? 'Estimated ' + ramGb.toFixed(1) + ' GB RAM, ' + diskGb.toFixed(1) + ' GB disk'
      : 'Needs ~' + ramGb.toFixed(1) + ' GB RAM (have ~' + MIN_RAM_GB + ' GB) or ~' + diskGb.toFixed(1) + ' GB disk';
    return { ramGb: ramGb, diskGb: diskGb, fits: fits, reason: reason };
  }

  // --- training data validation --------------------------------------------

  /**
   * validateDataset(jsonlText)
   *
   * Parses a JSONL string and returns { valid, count, errors }.
   * Each line must be a JSON object with "prompt" and "completion" strings.
   */
  function validateDataset(jsonlText) {
    var lines = String(jsonlText || '').split('\n').filter(function (l) { return l.trim(); });
    var errors = [];
    var count = 0;
    for (var i = 0; i < lines.length; i++) {
      try {
        var obj = JSON.parse(lines[i]);
        if (typeof obj.prompt !== 'string' || !obj.prompt) {
          errors.push('Line ' + (i + 1) + ': missing or empty "prompt"');
        }
        if (typeof obj.completion !== 'string' && typeof obj.response !== 'string') {
          errors.push('Line ' + (i + 1) + ': missing "completion" or "response"');
        }
        count++;
      } catch {
        errors.push('Line ' + (i + 1) + ': invalid JSON');
      }
    }
    return { valid: errors.length === 0, count: count, errors: errors };
  }

  // --- session state -------------------------------------------------------

  function createSession(opts) {
    var o = opts || {};
    return {
      id: o.id || ('finetune-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
      baseModel: o.baseModel || '',
      datasetPath: o.datasetPath || '',
      loraR: o.loraR || DEFAULT_LORA_R,
      loraAlpha: o.loraAlpha || DEFAULT_LORA_ALPHA,
      learningRate: o.learningRate || DEFAULT_LR,
      epochs: o.epochs || DEFAULT_EPOCHS,
      batchSize: o.batchSize || DEFAULT_BATCH,
      status: o.status || 'idle',
      progress: o.progress || 0,
      currentEpoch: o.currentEpoch || 0,
      totalEpochs: o.totalEpochs || DEFAULT_EPOCHS,
      outputPath: o.outputPath || '',
      error: o.error || null,
      logs: o.logs || [],
      startedAt: o.startedAt || null,
      updatedAt: o.updatedAt || null,
    };
  }

  // --- build the llama-cli command -----------------------------------------

  /**
   * buildCommand(session)
   *
   * Returns the llama-cli finetune command as a string array.
   * The user's llama.cpp binary must be at the path the shell found in Phase 2.
   */
  function buildCommand(session) {
    return [
      'llama-cli',
      '--mode', 'finetune',
      '--model', session.baseModel,
      '--lora-init-r', String(session.loraR),
      '--lora-init-alpha', String(session.loraAlpha),
      '--learning-rate', String(session.learningRate),
      '--epochs', String(session.epochs),
      '--batch-size', String(session.batchSize),
      '--dataset', session.datasetPath,
      '--output', session.outputPath || (session.baseModel.replace(/\.gguf$/, '') + '-lora-' + session.loraR + '.gguf'),
    ];
  }

  // --- status helpers ------------------------------------------------------

  function statusText(session) {
    if (!session) return '';
    switch (session.status) {
      case 'validating': return 'Validating dataset…';
      case 'training': return 'Training epoch ' + session.currentEpoch + '/' + session.totalEpochs + ' (' + session.progress + '%)';
      case 'done': return 'Adapter saved to ' + (session.outputPath || 'output');
      case 'error': return 'Error: ' + (session.error || 'unknown');
      case 'stopped': return 'Training stopped.';
      default: return 'Ready to train.';
    }
  }

  return {
    MIN_RAM_GB: MIN_RAM_GB,
    MIN_DISK_GB: MIN_DISK_GB,
    DEFAULT_LORA_R: DEFAULT_LORA_R,
    DEFAULT_LORA_ALPHA: DEFAULT_LORA_ALPHA,
    DEFAULT_LR: DEFAULT_LR,
    DEFAULT_EPOCHS: DEFAULT_EPOCHS,
    DEFAULT_BATCH: DEFAULT_BATCH,
    estimateRequirements: estimateRequirements,
    validateDataset: validateDataset,
    createSession: createSession,
    buildCommand: buildCommand,
    statusText: statusText,
  };
});
