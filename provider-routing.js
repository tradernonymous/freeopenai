'use strict';

(function attachProviderRouting(root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FreeOpenAIProviderRouting = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function providerRoutingFactory() {
  const ROUTING_MODES = ['off', 'auto'];
  const PUTER_PROVIDER = 'puter';
  const LITE_MODEL_PATTERN = /(flash|mini|nano|lite|small|haiku|turbo|instant|0\.5b|1b|1\.5b|2b|3b|4b|7b|8b|9b)\b/i;

  function callStage({ round = 0, toolsOffered = false, toolResults = 0 } = {}) {
    if (!toolsOffered) return 'answer';
    if (round <= 0) return 'plan';
    if (toolResults > 0) return 'work';
    return 'answer';
  }

  function isLiteModelId(id) {
    return LITE_MODEL_PATTERN.test(String(id || ''));
  }

  function routeCost(model) {
    const pricing = (model && model.pricing) || {};
    const prompt = Number(pricing.prompt);
    const completion = Number(pricing.completion);
    if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
    return (Number.isFinite(prompt) ? prompt : 0) * 3 + (Number.isFinite(completion) ? completion : 0);
  }

  function routeRank(model, deps = {}) {
    if (!model) return null;
    const cost = routeCost(model);
    const free = deps.isFreeModelId || ((id) => /:free$/i.test(String(id || '')));
    if (free(model.id) || cost === 0) return { tier: 0, cost: 0, why: 'free' };
    if (cost !== null) return { tier: 1, cost, why: 'the cheapest price' };
    if (isLiteModelId(model.id)) return { tier: 2, cost: 0, why: 'the small model in this family' };
    return null;
  }

  function defaultUsableModelId(id) {
    const value = String(id || '').toLowerCase();
    return !!value && !/(embedding|moderation|rerank|whisper|tts|image|vision-only)/.test(value);
  }

  function defaultEmitsText(model) {
    const modalities = model && model.outputModalities;
    return !Array.isArray(modalities) || modalities.length === 0 || modalities.includes('text');
  }

  function defaultSupportsTools(model) {
    if (!model) return false;
    if (model.tools === false) return false;
    if (!Array.isArray(model.supportedParameters)) return model.tools === true;
    return model.supportedParameters.includes('tools');
  }

  function routeStep(options = {}) {
    const {
      stage,
      mode = 'auto',
      model,
      models = [],
      needsTools = false,
      refused = [],
    } = options;
    if (mode !== 'auto' || stage !== 'work' || !model) return null;
    const usable = options.isUsableChatModelId || defaultUsableModelId;
    const emits = options.emitsText || defaultEmitsText;
    const tools = options.supportsTools || defaultSupportsTools;
    const skip = new Set((refused || []).map((id) => String(id)));
    const ranked = (Array.isArray(models) ? models : [])
      .filter((candidate) => candidate && usable(candidate.id) && !skip.has(String(candidate.id)) && emits(candidate))
      .filter((candidate) => !needsTools || (tools(candidate) && candidate.tools !== false))
      .map((candidate) => ({ candidate, rank: routeRank(candidate, options) }))
      .filter((row) => row.rank)
      .sort((a, b) =>
        a.rank.tier - b.rank.tier || a.rank.cost - b.rank.cost || String(a.candidate.id).localeCompare(String(b.candidate.id)),
      );
    if (!ranked.length) return null;
    const picked = ranked[0];
    if (picked.candidate.id === model) return null;
    return {
      model: picked.candidate.id,
      from: model,
      free: picked.rank.tier === 0,
      why: picked.rank.why,
    };
  }

  // The cheapest model in a list that can see, or '' when none can. The ordering
  // is the one a tool-reading step goes through -- free, then price, then the
  // small model of a family -- for the same reason: a picture is reviewed by a
  // cheap eye, not by the flagship the conversation happens to be on. Two
  // differences, both deliberate: a model the caller has already named as its
  // cheap eye wins outright, and a model whose price is unknown comes last rather
  // than never, because a review by an unknown-cost model still beats no review.
  function cheapestVisionModel(models, deps = {}) {
    const accepts = deps.acceptsImages || ((model) => !!(model && model.vision === true));
    const preferred = String(deps.preferred || '');
    const ranked = (Array.isArray(models) ? models : [])
      .filter((model) => model && model.id && accepts(model))
      .map((model) => ({ id: model.id, rank: routeRank(model, deps) || { tier: 3, cost: 0 } }))
      .sort((a, b) => a.rank.tier - b.rank.tier || a.rank.cost - b.rank.cost || String(a.id).localeCompare(String(b.id)));
    if (preferred && ranked.some((row) => row.id === preferred)) return preferred;
    return ranked.length ? ranked[0].id : '';
  }

  function routedStepFailure({ errored = false, empty = false, badArguments = false, repeatedCall = false } = {}) {
    if (errored) return 'refused the step';
    if (empty) return 'came back with nothing';
    if (badArguments) return 'sent tool arguments that could not be used';
    if (repeatedCall) return 'asked again for something it already had';
    return '';
  }

  function describeRoute(route) {
    if (!route || !route.model) return '';
    return 'Reading tool results goes to ' + route.model + ' (' + route.why + '); ' +
      route.from + ' plans the turn and takes any step back that goes wrong.';
  }

  function failoverProviderOrder(providers, options = {}) {
    const ids = (Array.isArray(providers) ? providers : [])
      .filter((provider) => provider && typeof provider.id === 'string' && provider.id)
      .filter((provider) => provider.configured === true && (!provider.kind || provider.kind === 'chat'))
      .map((provider) => provider.id);
    const puter = options.puterProvider || PUTER_PROVIDER;
    if (options.puterUsable && !ids.includes(puter)) ids.push(puter);
    return ids;
  }

  function nextFailoverProvider(order, tried = [], blocked = new Set()) {
    const skip = new Set(Array.isArray(tried) ? tried : []);
    const refused = blocked instanceof Set ? blocked : new Set();
    for (const id of Array.isArray(order) ? order : []) {
      if (typeof id !== 'string' || !id || skip.has(id) || refused.has(id)) continue;
      return id;
    }
    return null;
  }

  function isFailoverWorthyFailure(message, statusCode, modelId, deps = {}) {
    const text = String(message || '');
    const status = Number(statusCode) || 0;
    if (!text && !status) return false;
    const outOfCredits = deps.isOutOfCreditsError || (() => false);
    const quota = deps.isQuotaExhausted || (() => false);
    const account = deps.isAccountLevelFailure || (() => false);
    if (outOfCredits(text) || quota(text)) return true;
    if (account(text, modelId)) return true;
    if (status === 429 || status >= 500) return true;
    return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|did not respond within|not reachable/i.test(text);
  }

  return {
    ROUTING_MODES,
    callStage,
    isLiteModelId,
    routeCost,
    routeRank,
    routeStep,
    cheapestVisionModel,
    routedStepFailure,
    describeRoute,
    failoverProviderOrder,
    nextFailoverProvider,
    isFailoverWorthyFailure,
  };
});
