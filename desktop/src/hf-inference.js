// HuggingFace Inference API as a chat provider.
//
// When the user picks "Hugging Face" in the model picker, chat turns go
// through api.huggingface.co (the Inference API) instead of the engine. The
// HF token from hf-auth.js is sent as a Bearer token. This keeps the
// engine's free pool untouched and the user's HF models private.
//
// The Inference API speaks the OpenAI chat completions shape at
// https://api.huggingface.co/models/<model>/v1/chat/completions, so the
// streaming code is almost identical to streamChat in api.ts — the only
// differences are the base URL and the auth header.
//
// UMD like the repo's other shared modules.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UHfInference = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // --- the models we offer on the HF provider row -------------------------
  // These are popular models available through the free Inference API. The
  // list is curated, not exhaustive — the user can type any model id in the
  // filter box and it will work if the model supports chat completions.
  var FREE_MODELS = [
    { id: 'Qwen/Qwen2.5-72B-Instruct', free: 'HF Inference' },
    { id: 'meta-llama/Llama-3.3-70B-Instruct', free: 'HF Inference' },
    { id: 'microsoft/Phi-4', free: 'HF Inference' },
    { id: 'google/gemma-2-27b-it', free: 'HF Inference' },
    { id: 'mistralai/Mistral-7B-Instruct-v0.3', free: 'HF Inference' },
    { id: 'deepseek-ai/DeepSeek-R1', free: 'HF Inference' },
    { id: 'Qwen/Qwen3-235B-A22B', free: 'HF Inference' },
  ];

  var API_BASE = 'https://api.huggingface.co/models';

  // --- provider row --------------------------------------------------------

  /**
   * providerRow(token)
   *
   * Returns a provider-row-shaped object for the ModelPicker, or null when
   * there is no HF token (the user must sign in first).
   */
  function providerRow(token) {
    if (!token) return null;
    return {
      id: 'hf',
      label: 'Hugging Face',
      freeTier: { text: 'HF Inference — free with token' },
    };
  }

  // --- models --------------------------------------------------------------

  /**
   * models(token)
   *
   * Returns the curated model list. In the future this could fetch the user's
   * own models or search the Hub; for now it is a static list plus any model
   * the user types into the filter.
   */
  function models(token) {
    if (!token) return [];
    return FREE_MODELS;
  }

  // --- streaming chat ------------------------------------------------------

  /**
   * streamChat(model, messages, onFrame, signal, token)
   *
   * Sends a chat completion request to the HF Inference API and streams the
   * response. The API speaks the OpenAI shape, so the SSE parsing is identical
   * to the engine's streamChat.
   */
  async function streamChat(model, messages, onFrame, signal, token) {
    if (!token) throw new Error('HuggingFace Inference requires a signed-in HF account.');
    var url = API_BASE + '/' + encodeURIComponent(model) + '/v1/chat/completions';
    var res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({ model: model, messages: messages, stream: true }),
        signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new Error('Could not reach the HuggingFace Inference API: ' + (err?.message || err));
    }
    if (!res.ok) {
      var body = '';
      try { body = await res.text(); } catch {}
      throw new Error('HuggingFace Inference API answered ' + res.status + ': ' + body.slice(0, 200));
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
      throw new Error('HuggingFace Inference returned an unexpected response.');
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
          if (text) onFrame({ content: text, model: frame.model });
        } catch (e) {
          if (e && e.message && e.message.includes('HF Inference')) throw e;
          // Ignore unparseable frames.
        }
      }
    }
  }

  // --- one-shot chat (for tools) -------------------------------------------

  /**
   * chat(model, messages, token)
   *
   * Non-streaming chat completion, used by tools that want a complete answer.
   */
  async function chat(model, messages, token) {
    if (!token) throw new Error('HuggingFace Inference requires a signed-in HF account.');
    var url = API_BASE + '/' + encodeURIComponent(model) + '/v1/chat/completions';
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ model: model, messages: messages, stream: false }),
    });
    if (!res.ok) {
      var body = '';
      try { body = await res.text(); } catch {}
      throw new Error('HuggingFace Inference API answered ' + res.status + ': ' + body.slice(0, 200));
    }
    return res.json();
  }

  return {
    FREE_MODELS: FREE_MODELS,
    API_BASE: API_BASE,
    providerRow: providerRow,
    models: models,
    streamChat: streamChat,
    chat: chat,
  };
});
