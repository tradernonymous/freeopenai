// Hugging Face Inference Providers as a chat provider.
//
// When the user picks "Hugging Face" in the model picker, chat turns go through
// the HF router (https://router.huggingface.co/v1) instead of the engine. The
// HF token from hf-auth.js is sent as a Bearer token. This keeps the engine's
// free pool untouched and the user's HF usage on their own account.
//
// The router is the ONE documented OpenAI-compatible base for every provider
// behind Hugging Face (Novita, Together, Fireworks, ...). The old
// `api.<hub>/models/<model>/v1/chat/completions` host this module used to
// build was never a documented endpoint, so every HF turn failed before a
// token was even checked. test/desktop-hf.test.js keeps that host out.
//
// Two things the router does that the old path did not:
//   * `GET /v1/models` lists every model that has a provider right now, so the
//     picker can be live rather than a list that rots.
//   * a `:cheapest` or `:fastest` suffix on the model id lets the router pick
//     the provider; without one it picks by the user's provider order.
//
// The token must be allowed to "Make calls to Inference Providers" (the OAuth
// scope is `inference-api`). A 401/403 here almost always means that box was
// not ticked, so the error says so instead of "unauthorized".
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UHfInference = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var API_BASE = 'https://router.huggingface.co/v1';
  var DEFAULT_SUFFIX = 'cheapest';

  // --- the models we offer before /v1/models has answered --------------------
  // Popular models with at least one provider on the router at the time of
  // writing. The user can type any router model id in the filter box, and the
  // live list from fetchModels() replaces this one when it arrives.
  var FREE_MODELS = [
    { id: 'Qwen/Qwen3.8-27B', free: 'HF router' },
    { id: 'zai-org/GLM-5.3-Flash', free: 'HF router' },
    { id: 'deepseek-ai/DeepSeek-V4.1-Flash', free: 'HF router' },
    { id: 'google/gemma-4-31B-it', free: 'HF router' },
    { id: 'meta-llama/Llama-3.1-8B-Instruct', free: 'HF router' },
    { id: 'moonshotai/Kimi-K3', free: 'HF router' },
  ];

  // --- provider row --------------------------------------------------------

  /**
   * providerRow(token)
   *
   * Returns a provider-row-shaped object for the ModelPicker, or null when
   * there is no HF token (the user must sign in first).
   */
  function providerRow(token) {
    // Always offered. It used to appear only after a sign-in made on another
    // screen (Library), so nobody could find it; signed out, the row is still
    // there and Chat shows the sign-in right under the header.
    if (!token) {
      return {
        id: 'hf',
        label: 'Hugging Face',
        configured: false,
        freeTier: { text: 'Sign in with your Hugging Face account to use it' },
      };
    }
    return {
      id: 'hf',
      label: 'Hugging Face',
      configured: true,
      // Honest about the money: the free monthly credit is small and the rest
      // is billed to the user's HF account.
      freeTier: { text: 'Inference Providers — monthly free credits, then your HF billing' },
    };
  }

  // --- models --------------------------------------------------------------

  /** The curated list, synchronously. */
  function models(token) {
    if (!token) return [];
    return FREE_MODELS;
  }

  /**
   * fetchModels(token, fetchImpl)
   *
   * The live list from `GET /v1/models`: every model with at least one
   * provider. Falls back to the curated list when the router cannot be
   * reached, so the picker is never empty for a signed-in user.
   */
  async function fetchModels(token, fetchImpl) {
    if (!token) return [];
    var doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) return FREE_MODELS;
    try {
      var res = await doFetch(API_BASE + '/models', {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
      });
      if (!res.ok) return FREE_MODELS;
      var data = await res.json();
      var rows = Array.isArray(data && data.data) ? data.data : [];
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var id = rows[i] && rows[i].id;
        if (typeof id !== 'string' || !id) continue;
        var providers = Array.isArray(rows[i].providers) ? rows[i].providers : [];
        var names = providers.map(function (p) { return p && p.provider; }).filter(Boolean);
        out.push({ id: id, free: names.length ? names.length + ' provider' + (names.length === 1 ? '' : 's') : 'HF router' });
      }
      return out.length ? out : FREE_MODELS;
    } catch {
      return FREE_MODELS;
    }
  }

  // --- request shape ---------------------------------------------------------

  /** The one URL every chat turn goes to. */
  function chatUrl() {
    return API_BASE + '/chat/completions';
  }

  /**
   * The model id the router wants: `owner/name:policy`. A suffix the user
   * already typed (`:fastest`, `:novita`) is kept; otherwise `:cheapest`, so
   * the free credits go as far as they can.
   */
  function modelId(model) {
    var id = String(model || '').trim();
    if (!id) return id;
    var slash = id.lastIndexOf('/');
    var colon = id.indexOf(':', slash < 0 ? 0 : slash);
    if (colon >= 0) return id;
    return id + ':' + DEFAULT_SUFFIX;
  }

  /** What a non-2xx answer means, in words worth acting on. */
  function explain(status, body) {
    var text = String(body || '').slice(0, 200);
    if (status === 401 || status === 403) {
      return 'Hugging Face refused the token (' + status + '). The token must be allowed to ' +
        '"Make calls to Inference Providers" — sign out and in again, or create a fine-grained token with that permission.';
    }
    if (status === 402) {
      return 'Hugging Face says the monthly credits are used up (402). Add billing on huggingface.co or switch provider.';
    }
    if (status === 404) {
      return 'No provider serves that model right now (404). Pick one from the list.';
    }
    return 'Hugging Face Inference Providers answered ' + status + ': ' + text;
  }

  // --- streaming chat ------------------------------------------------------

  /**
   * streamChat(model, messages, onFrame, signal, token)
   *
   * Sends a chat completion request to the HF router and streams the response.
   * The router speaks the OpenAI shape, so the SSE parsing is identical to the
   * engine's streamChat.
   */
  async function streamChat(model, messages, onFrame, signal, token, tools) {
    if (!token) throw new Error('Hugging Face Inference requires a signed-in HF account.');
    var res;
    try {
      res = await fetch(chatUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(Object.assign({ model: modelId(model), messages: messages, stream: true }, tools && tools.length ? { tools: tools } : {})),
        signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new Error('Could not reach the Hugging Face router: ' + (err?.message || err));
    }
    if (!res.ok) {
      var body = '';
      try { body = await res.text(); } catch {}
      throw new Error(explain(res.status, body));
    }
    // The response is SSE, same shape as the engine.
    var contentType = String(res.headers.get('content-type') || '');
    if (!contentType.includes('text/event-stream') || !res.body) {
      // Non-streaming fallback.
      var data = await res.json().catch(function () { return null; });
      var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof content === 'string' && content) {
        onFrame({ content: content, done: true });
        return;
      }
      throw new Error('Hugging Face Inference returned an unexpected response.');
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        var payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          onFrame({ done: true });
          continue;
        }
        try {
          var frame = JSON.parse(payload);
          if (frame && frame.error) {
            throw new Error(typeof frame.error === 'string' ? frame.error : (frame.error.message || 'HF Inference stream failed'));
          }
          var delta = frame.choices && frame.choices[0] && frame.choices[0].delta;
          var text = delta && typeof delta.content === 'string' ? delta.content : undefined;
          var called = delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length ? delta.tool_calls : undefined;
          if (text || called) {
            var out = { content: text, model: frame.model };
            if (called) out.toolCalls = called;
            onFrame(out);
          }
        } catch (e) {
          if (e && e.message && e.message.includes('HF Inference')) throw e;
          // Ignore unparseable frames.
        }
      }
    }
  }

  return {
    API_BASE: API_BASE,
    DEFAULT_SUFFIX: DEFAULT_SUFFIX,
    FREE_MODELS: FREE_MODELS,
    providerRow: providerRow,
    models: models,
    fetchModels: fetchModels,
    chatUrl: chatUrl,
    modelId: modelId,
    explain: explain,
    streamChat: streamChat,
  };
});
