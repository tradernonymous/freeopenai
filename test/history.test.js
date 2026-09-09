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

test('free and code-capable models are floated to the top of the list', () => {
  const sorted = usableChatModels([
    { id: 'some-tiny-chat-model' },
    { id: 'mistralai/mistral-7b' },
    { id: 'qwen/qwen3-coder:free' },
    { id: 'deepseek/deepseek-r1' },
    { id: 'meta/llama-guard' },
    { id: 'openai/gpt-oss-120b:free' },
  ]);
  // free + capable, then capable, then the rest; guard models dropped entirely.
  assert.deepEqual(sorted.map((m) => m.id), [
    'qwen/qwen3-coder:free',
    'openai/gpt-oss-120b:free',
    'deepseek/deepseek-r1',
    'some-tiny-chat-model',
    'mistralai/mistral-7b',
  ]);
});

test('the provider order is kept within a rank, so newest stays first', () => {
  const sorted = usableChatModels([{ id: 'qwen3-coder' }, { id: 'deepseek-r1' }]);
  assert.deepEqual(sorted.map((m) => m.id), ['qwen3-coder', 'deepseek-r1']);
});

test('a model description says what matters about it', () => {
  assert.equal(describeProviderModel({ free: true, capable: true }), 'free · code / research');
  assert.equal(describeProviderModel({ free: true, ownedBy: 'Meta' }), 'free · Meta');
  assert.equal(describeProviderModel({ ownedBy: 'Alibaba' }), 'Alibaba');
  assert.equal(describeProviderModel(null), '');
});

test('puter stays the default provider, since it needs no key', () => {
  assert.equal(PUTER_PROVIDER, 'puter');
});
