// Why a turn failed, and what to do about it.
//
// The engine reports the upstream provider's own words, which is right -- that
// text is the evidence -- but it arrives as a wall: "Rate limit reached for
// model meta-llama/llama-4-scout in organization org_01m3... on tokens per
// minute (TPM): Limit 30000, Used 23082...". What went wrong, WHICH MODEL it
// was about, and what the user can do are three different things, and the app
// used to show only the first, in the provider's vocabulary.
//
// So: the label above the message names what was ASKED (provider · model), the
// provider's detail is quoted as the provider's, and the advice is this file's.
// test/desktop-failure.test.js pins the classification, because a wrong guess
// here sends someone to fix the wrong thing.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UFailure = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Most specific first: a single message often contains several of these
  // ("rate limit ... 429 ... retry"), and the first match is the one worth
  // acting on.
  var RULES = [
    {
      kind: 'credits',
      label: 'No credit',
      test: /insufficient|out of credit|no credit|billing|payment required|402|never purchased/i,
      advice: 'That model needs credit this key does not have. Pick a free one.',
      retryable: false,
    },
    {
      kind: 'rate-limit',
      label: 'Rate-limited',
      test: /rate.?limit|too many requests|429|tpm|rpm\b|quota exceeded|retry after/i,
      advice: 'That model is rate-limited right now — wait a moment, or try another one.',
      retryable: true,
    },
    {
      kind: 'auth',
      label: 'Not authorised',
      test: /\b401\b|\b403\b|unauthor|forbidden|invalid api key|api key not|no api key/i,
      advice: 'The key for that provider was refused. Check the engine’s key, or sign in again.',
      retryable: false,
    },
    {
      kind: 'model-missing',
      label: 'Model unavailable',
      test: /not found|\b404\b|does not exist|unknown model|no access|not available to your key|deprecat/i,
      advice: 'This key cannot reach that model. Pick another one.',
      retryable: false,
    },
    {
      kind: 'context',
      label: 'Context too long',
      test: /context length|too many tokens|maximum context|token limit|context window/i,
      advice: 'The conversation is past that model’s context. Start a new chat, or pick a bigger model.',
      retryable: false,
    },
    {
      kind: 'refused',
      label: 'Refused',
      test: /refus|content policy|moderation|safety|flagged/i,
      advice: 'The model refused this prompt. Rephrase it and retry.',
      retryable: true,
    },
    {
      kind: 'timeout',
      label: 'Timed out',
      // "It ran out of time after 60s" is the engine's own wording for this,
      // and it used to fall through to "something failed" because the rule only
      // knew the word "timeout".
      test: /timed out|timeout|took too long|stall|did not finish|ran out of time|did not answer within/i,
      advice: 'It timed out. Retry, or switch to a smaller, faster model.',
      retryable: true,
    },
    {
      kind: 'overloaded',
      label: 'Overloaded',
      test: /overload|temporarily unavailable|service unavailable|\b503\b|capacity|upstream error|try again later/i,
      advice: 'That provider is overloaded — not your prompt. Retry, or try another model.',
      retryable: true,
    },
    {
      kind: 'network',
      label: 'Unreachable',
      test: /fetch failed|econnrefused|enotfound|eai_again|etimedout|network|did not resolve|socket/i,
      advice: 'The engine could not reach that provider. Retry, or try another model.',
      retryable: true,
    },
  ];

  var MAX_UPSTREAM = 400;

  function tidy(text) {
    var value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (value.length <= MAX_UPSTREAM) return value;
    return value.slice(0, MAX_UPSTREAM).trim() + '…';
  }

  // "Kilo Code · kilo-auto/free", or whichever half is known.
  function askedName(input) {
    var opts = input || {};
    var label = String(opts.providerLabel || opts.provider || '').trim();
    var model = String(opts.model || '').trim();
    if (label && model) return label + ' · ' + model;
    return model || label;
  }

  function classify(message) {
    var text = String(message == null ? '' : message);
    for (var i = 0; i < RULES.length; i += 1) {
      if (RULES[i].test.test(text)) return RULES[i];
    }
    return {
      kind: 'unknown',
      label: 'Failed',
      advice: 'Retry, or pick another model from the list above.',
      retryable: true,
    };
  }

  /**
   * What to show for a failed turn.
   *
   * asked   — the provider and model the request was made with, never the one
   *           that happened to answer the error (they can differ, and showing
   *           the wrong one is the whole complaint this fixes)
   * summary — one sentence naming what was asked
   * upstream— the provider's own words, trimmed, for when they add something
   * advice  — one sentence of what to do
   */
  function attribute(input) {
    var opts = input || {};
    var message = String(opts.message == null ? '' : opts.message);
    var rule = classify(message);
    var asked = askedName(opts);
    var upstream = tidy(message);
    // A message that says nothing is not worth quoting back.
    if (upstream && asked && upstream.toLowerCase().indexOf(asked.toLowerCase()) === 0) {
      upstream = upstream.slice(asked.length).replace(/^[\s:—-]+/, '');
    }
    return {
      kind: rule.kind,
      label: rule.label,
      asked: asked,
      summary: asked ? asked + ' did not answer' : 'No model answered',
      upstream: upstream,
      advice: rule.advice,
      retryable: rule.retryable,
    };
  }

  /**
   * The same shape for a failed image draw.
   *
   * The engine already walks its services and reports which it tried
   * (`tried`), so the useful line there is the walk rather than one provider's
   * message: "Tried: Free FLUX (did not answer within 20s); OpenRouter (key has
   * no image model)".
   */
  function attributeImage(input) {
    var opts = input || {};
    var tried = Array.isArray(opts.tried) ? opts.tried.filter(Boolean) : [];
    var rule = classify(opts.message || opts.error || '');
    var walked = tried.length ? 'Tried ' + tried.join(', ') + '.' : '';
    var upstream = tidy(opts.error || opts.message || '');
    return {
      kind: rule.kind,
      label: rule.label,
      summary: opts.asked
        ? 'Drawing with ' + opts.asked + ' did not work'
        : 'The engine could not draw that',
      upstream: upstream,
      tried: tried,
      walk: walked,
      advice: rule.advice,
      retryable: rule.retryable,
    };
  }

  /**
   * The next model to try when the current one failed.
   *
   * Deliberately not random and not "the first": the picker order is the
   * operator's, and moving one step along it is the smallest change that gives
   * the retry a different chance.
   */
  function nextModel(current, list) {
    var ids = (Array.isArray(list) ? list : [])
      .map(function (row) { return String((row && row.id) || row || '').trim(); })
      .filter(Boolean);
    if (!ids.length) return '';
    var at = ids.indexOf(String(current == null ? '' : current).trim());
    if (at < 0) return ids[0];
    return ids[(at + 1) % ids.length];
  }

  return {
    RULES: RULES,
    classify: classify,
    attribute: attribute,
    attributeImage: attributeImage,
    askedName: askedName,
    nextModel: nextModel,
  };
});
