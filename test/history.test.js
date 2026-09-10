const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_HISTORY_MESSAGES, buildChatHistory, SYSTEM_PROMPT } = require('../chatlib.js');

test('the exchange is rebuilt as alternating chat turns', () => {
  const history = buildChatHistory([
    { type: 'user', content: 'refine the readme for printezy247/macro-trader-bot' },
    { type: 'bot', content: 'Which repository?' },
    { type: 'user', content: 'the one I just named' },
  ]);
  assert.deepEqual(history.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.equal(history[0].content, 'refine the readme for printezy247/macro-trader-bot');
});

test('tool activity and error notices never go back to the model', () => {
  // Feeding these back invites the model to comment on the app's own narration.
  const history = buildChatHistory([
    { type: 'user', content: 'list my repos' },
    { type: 'system', content: 'Listing your GitHub repositories' },
    { type: 'system', content: 'Error: No usage left for request.' },
    { type: 'bot', content: 'You have three.' },
  ]);
  assert.equal(history.length, 2);
  assert.ok(!JSON.stringify(history).includes('Listing your GitHub'));
  assert.ok(!JSON.stringify(history).includes('No usage left'));
});

test('history is capped, keeping the most recent turns', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'bot',
    content: 'message ' + i,
  }));
  const history = buildChatHistory(many);
  assert.ok(history.length <= MAX_HISTORY_MESSAGES);
  assert.equal(history[history.length - 1].content, 'message 39');
});

test('history never opens on an assistant turn', () => {
  // Trimming can slice mid-exchange; a reply to nothing confuses the model
  // and some providers reject it outright.
  const history = buildChatHistory(
    [
      { type: 'user', content: 'first' },
      { type: 'bot', content: 'answer' },
      { type: 'user', content: 'second' },
    ],
    2
  );
  assert.equal(history[0].role, 'user');
  assert.equal(history[0].content, 'second');
});

test('blank and unknown message types are skipped', () => {
  const history = buildChatHistory([
    { type: 'user', content: '   ' },
    { type: 'weird', content: 'x' },
    null,
    { type: 'user', content: 'real' },
  ]);
  assert.deepEqual(history, [{ role: 'user', content: 'real' }]);
});

test('the cap leaves room for a real exchange', () => {
  assert.ok(MAX_HISTORY_MESSAGES >= 8, 'too short to remember a conversation');
  assert.ok(MAX_HISTORY_MESSAGES <= 30, 'every message is billed on every turn');
});

test('the system prompt forbids the behaviour that wasted the tokens', () => {
  assert.match(SYSTEM_PROMPT, /never ask for something the user already told you/i);
  assert.match(SYSTEM_PROMPT, /do not ask which repository/i);
  assert.match(SYSTEM_PROMPT, /never answer "say proceed/i);
  assert.match(SYSTEM_PROMPT, /never ask permission to read/i);
  assert.match(SYSTEM_PROMPT, /hope this helps/i);
});

const {
  PUTER_PROVIDER,
  normalizeProviderReply,
  usableChatModels,
  isFreeModelId,
  isCapableModelId,
  describeProviderModel,
} = require('../chatlib.js');

test('an OpenAI-shaped reply is unwrapped into the shape the app already uses', () => {
  const openai = { choices: [{ message: { role: 'assistant', content: 'hello' } }], usage: {} };
  const normalized = normalizeProviderReply(openai);
  assert.equal(normalized.message.content, 'hello');
});

test('a Puter-shaped reply passes through untouched', () => {
  const puter = { message: { content: [{ type: 'text', text: 'hi' }] } };
  assert.equal(normalizeProviderReply(puter), puter);
});

test('tool calls survive normalisation, so the loop still works', () => {
  const withTools = {
    choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'github_read_file', arguments: '{}' } }] } }],
  };
  assert.equal(normalizeProviderReply(withTools).message.tool_calls.length, 1);
});

test('normalizeProviderReply returns null rather than throwing on junk', () => {
  assert.equal(normalizeProviderReply(null), null);
  assert.equal(normalizeProviderReply({}), null);
  assert.equal(normalizeProviderReply({ choices: [] }), null);
  assert.equal(normalizeProviderReply('a string'), null);
});

test('non-chat models are filtered out of a provider catalogue', () => {
  // Providers return everything they host; an embedding model in a chat
  // dropdown is a request that can only fail.
  const models = usableChatModels([
    { id: 'llama-3.3-70b' },
    { id: 'text-embedding-3-large' },
    { id: 'whisper-large-v3' },
    { id: 'nvidia/rerank-qa' },
    { id: 'black-forest-labs/flux-1' },
    { id: 'qwen-3-32b' },
  ]);
  assert.deepEqual(models.map((m) => m.id), ['llama-3.3-70b', 'qwen-3-32b']);
});

test('a very long catalogue is capped, and junk entries dropped', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ id: 'model-' + i }));
  assert.equal(usableChatModels(many).length, 60);
  assert.deepEqual(usableChatModels([null, { id: 5 }, {}]), []);
  assert.deepEqual(usableChatModels(null), []);
});

test('OpenRouter free variants are recognised by their suffix', () => {
  assert.ok(isFreeModelId('deepseek/deepseek-r1:free'));
  assert.ok(!isFreeModelId('deepseek/deepseek-r1'));
  assert.ok(!isFreeModelId('llama-3.3-70b'));
  assert.ok(!isFreeModelId(null));
});

test('coding and reasoning families are recognised', () => {
  for (const id of ['qwen3-coder-480b', 'deepseek/deepseek-r1', 'kimi-k2', 'gpt-oss-120b', 'nvidia/nemotron-4']) {
    assert.ok(isCapableModelId(id), `${id} should count as capable`);
  }
  assert.ok(!isCapableModelId('gpt-3.5-turbo'));
  assert.ok(!isCapableModelId(''));
});

test('on a provider with no pricing, ranking falls to capability', () => {
  // Cerebras and NVIDIA return the bare OpenAI shape, so every model is free
  // within the account allowance and cost can't separate them.
  const sorted = usableChatModels([
    { id: 'some-tiny-chat-model' },
    { id: 'mistralai/mistral-7b' },
    { id: 'qwen3-coder-480b' },
    { id: 'deepseek-r1' },
    { id: 'meta/llama-guard' },
  ]);
  assert.deepEqual(sorted.map((m) => m.id), [
    'qwen3-coder-480b',
    'deepseek-r1',
    'some-tiny-chat-model',
    'mistralai/mistral-7b',
  ]);
  assert.ok(!sorted.some((m) => m.id.includes('guard')), 'a guard model is not a chat model');
});

test('the provider order is kept within a rank, so newest stays first', () => {
  const sorted = usableChatModels([{ id: 'qwen3-coder' }, { id: 'deepseek-r1' }]);
  assert.deepEqual(sorted.map((m) => m.id), ['qwen3-coder', 'deepseek-r1']);
});

test('a model description leads with what matters, not who made it', () => {
  assert.equal(describeProviderModel({ free: true, capable: true }), 'free · code / research');
  // The vendor is a fallback: it only appears when nothing more useful applies.
  assert.equal(describeProviderModel({ free: true, ownedBy: 'Meta' }), 'free');
  assert.equal(describeProviderModel({ ownedBy: 'Alibaba' }), 'Alibaba');
  assert.equal(describeProviderModel(null), '');
});

test('puter stays the default provider, since it needs no key', () => {
  assert.equal(PUTER_PROVIDER, 'puter');
});

const { isFreeModel, supportsTools, emitsText } = require('../chatlib.js');

test('cost is read from published pricing, not guessed from the name', () => {
  // OpenRouter lists ~430 models and only ~21 are actually free, so the name
  // alone was never a reliable signal.
  assert.ok(isFreeModel({ id: 'x/y:free', pricing: { prompt: '0', completion: '0' } }));
  assert.ok(!isFreeModel({ id: 'x/y:free', pricing: { prompt: '0.0000004', completion: '0' } }));
  assert.ok(!isFreeModel({ id: 'anthropic/claude', pricing: { prompt: '0.000003', completion: '0.000015' } }));
});

test('a provider that publishes no pricing falls back to the id', () => {
  // Cerebras and NVIDIA return the bare OpenAI shape; their free tier is an
  // account allowance, so an absent price is not a paid model.
  assert.ok(isFreeModel({ id: 'llama-3.3-70b' }));
  assert.ok(isFreeModel({ id: 'qwen-3-32b', pricing: undefined }));
  assert.ok(!isFreeModel(null));
});

test('tool support is honoured when the provider reports it', () => {
  assert.ok(supportsTools({ supportedParameters: ['tools', 'temperature'] }));
  assert.ok(!supportsTools({ supportedParameters: ['temperature'] }));
  // No report is the benefit of the doubt, not a withheld capability.
  assert.ok(supportsTools({ id: 'x' }));
  assert.ok(supportsTools(null) === true || supportsTools(null) === false);
});

test('models that cannot emit text are not chat models', () => {
  assert.ok(emitsText({ outputModalities: ['text'] }));
  assert.ok(!emitsText({ outputModalities: ['audio'] }));
  assert.ok(!emitsText({ outputModalities: ['image'] }));
  assert.ok(emitsText({ id: 'x' }));
});

test('the real free OpenRouter catalogue ranks and filters correctly', () => {
  // Taken from a live /v1/models response.
  const live = [
    { id: 'anthropic/claude-opus', pricing: { prompt: '0.000015', completion: '0.000075' }, supportedParameters: ['tools'], architecture: {}, outputModalities: ['text'] },
    { id: 'google/lyria-3-pro-preview', pricing: { prompt: '0', completion: '0' }, outputModalities: ['audio'] },
    { id: 'nvidia/nemotron-3.5-content-safety:free', pricing: { prompt: '0', completion: '0' }, supportedParameters: [], outputModalities: ['text'] },
    { id: 'cohere/north-mini-code:free', pricing: { prompt: '0', completion: '0' }, supportedParameters: ['tools'], outputModalities: ['text'], contextLength: 256000 },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', pricing: { prompt: '0', completion: '0' }, supportedParameters: ['tools'], outputModalities: ['text'], contextLength: 1000000 },
  ];
  const ranked = usableChatModels(live);
  const ids = ranked.map((m) => m.id);

  assert.ok(!ids.includes('google/lyria-3-pro-preview'), 'a music model is not a chat model');
  assert.ok(!ids.some((id) => id.includes('content-safety')), 'a safety classifier is not a chat model');
  // Free and tool-capable come first; the paid model comes last.
  assert.equal(ids[0], 'cohere/north-mini-code:free');
  assert.equal(ids[ids.length - 1], 'anthropic/claude-opus');
  assert.equal(describeProviderModel(ranked[0]), 'free \u00b7 code / research \u00b7 256k ctx');
});

test('a model without tool support is labelled so, not silently broken', () => {
  const model = usableChatModels([
    { id: 'some/chat-model', pricing: { prompt: '0', completion: '0' }, supportedParameters: ['temperature'], outputModalities: ['text'] },
  ])[0];
  assert.equal(model.tools, false);
  assert.match(describeProviderModel(model), /no tools/);
});

const { explainEmptyReply } = require('../chatlib.js');

test('finish_reason turns an empty answer into an explanation', () => {
  // Reported as a bare "(no reply)", which told the user nothing about why.
  assert.match(explainEmptyReply({}, 'length'), /output limit/);
  assert.match(explainEmptyReply({}, 'content_filter'), /filtered/);
});

test('an empty answer alongside tool calls says so', () => {
  const message = { content: '', tool_calls: [{ id: 'c1', function: { name: 'github_read_file' } }] };
  assert.match(explainEmptyReply(message, 'tool_calls'), /another tool step/);
});

test('an unexplained empty answer suggests what to do', () => {
  const advice = explainEmptyReply({ content: '' }, 'stop');
  assert.match(advice, /empty response/);
  assert.match(advice, /retry|another model/);
});

test('finish_reason is carried out of an OpenAI-shaped reply', () => {
  const normalized = normalizeProviderReply({
    choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
  });
  assert.equal(normalized.finishReason, 'length');
  assert.match(explainEmptyReply(normalized.message, normalized.finishReason), /output limit/);
});
