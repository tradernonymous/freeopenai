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
