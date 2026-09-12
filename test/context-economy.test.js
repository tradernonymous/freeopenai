// Staying affordable is mostly about not paying for the same thing twice. The
// helpers here decide what travels in a request, what is remembered so it is not
// asked for again, and what a provider's cache actually saved. Each rule is
// worth pinning, because the failure mode is silent: a bigger bill, not a
// broken answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  estimateTokens,
  HISTORY_TOKEN_BUDGET,
  budgetChatHistory,
  buildChatHistory,
  MAX_HISTORY_MESSAGES,
  clipToolResult,
  MAX_TOOL_RESULT_CHARS,
  toolCallKey,
  cachedTokensFromUsage,
  REPEATED_TOOL_CALL_NOTICE,
  MAX_REPEATED_TOOL_CALLS,
  toolMemoFromConversation,
  pendingTurnStepCount,
  hasToolWork,
  RESUME_CONTINUATION_PROMPT,
  MAX_PENDING_TURN_CHARS,
  serializePendingTurn,
  parsePendingTurn,
  retryTargetFor,
} = require('../chatlib.js');

test('tokens are estimated from the text, and nothing costs nothing', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  // A number or object is read as text rather than throwing a turn away.
  assert.equal(estimateTokens(1234), 1);
});

test('the newest turns are the ones that survive a small budget', () => {
  const turns = [
    { role: 'user', content: 'a'.repeat(400) },
    { role: 'assistant', content: 'b'.repeat(400) },
    { role: 'user', content: 'c'.repeat(400) },
  ];
  assert.deepEqual(budgetChatHistory(turns, 250).map((t) => t.role), ['assistant', 'user']);
  assert.equal(budgetChatHistory(turns, 1000).length, 3);
  // A nonsense budget must not silently drop the conversation.
  assert.equal(budgetChatHistory(turns, 0).length, 3);
  assert.ok(HISTORY_TOKEN_BUDGET > 1000);
});

test('the newest turn always travels, however large it is', () => {
  // Dropping it would answer a different question than the one asked, and a
  // provider's "context length exceeded" is a failed turn, not a cheaper one.
  const huge = [{ role: 'user', content: 'x'.repeat(400000) }];
  assert.equal(budgetChatHistory(huge, 100).length, 1);
});

test('junk in place of a history yields an empty one rather than a crash', () => {
  assert.deepEqual(budgetChatHistory(null), []);
  assert.deepEqual(budgetChatHistory('nope'), []);
});

test('the count cap and the weight cap both bite', () => {
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ type: 'user', content: 'm' + i });
  assert.equal(buildChatHistory(many).length, MAX_HISTORY_MESSAGES);

  // One enormous assistant turn outweighs the earlier exchange, which is the
  // case a count-only cap could never catch.
  const heavy = [
    { type: 'user', content: 'old' },
    { type: 'bot', content: 'z'.repeat(200000) },
    { type: 'user', content: 'new' },
  ];
  const kept = buildChatHistory(heavy);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].content, 'new');
});

test('an oversized tool result is clipped, and says how much went missing', () => {
  const short = 'ok';
  assert.equal(clipToolResult(short), short);

  const long = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 250);
  const clipped = clipToolResult(long);
  assert.ok(clipped.length < long.length);
  assert.ok(clipped.startsWith('x'.repeat(MAX_TOOL_RESULT_CHARS)));
  assert.match(clipped, /250 more characters clipped/);

  // A chosen limit is honoured, and a nonsense one falls back rather than
  // clipping the result to nothing.
  assert.equal(clipToolResult('abcdef', 3).startsWith('abc'), true);
  assert.equal(clipToolResult('abcdef', 0).length, 6);
});

test('the same call written two ways is the same call', () => {
  const a = toolCallKey('github_read_file', { repo: 'o/r', path: 'a.md' });
  const b = toolCallKey('github_read_file', { path: 'a.md', repo: 'o/r' });
  assert.equal(a, b, "argument order is the model's, not a fact about the call");
  assert.notEqual(a, toolCallKey('github_read_file', { repo: 'o/r', path: 'b.md' }));
  assert.notEqual(a, toolCallKey('web_fetch', { repo: 'o/r', path: 'a.md' }));
  // Nested values are compared by meaning too.
  assert.equal(
    toolCallKey('t', { list: [1, { b: 2, a: 1 }] }),
    toolCallKey('t', { list: [1, { a: 1, b: 2 }] }),
  );
  // Without a name there is nothing to identify, so it can never be a repeat.
  assert.equal(toolCallKey('', { a: 1 }), '');
  assert.equal(toolCallKey(undefined, { a: 1 }), '');
});

test("a provider's cache report is read however it is spelled", () => {
  assert.equal(cachedTokensFromUsage({ prompt_tokens_details: { cached_tokens: 900 } }), 900);
  assert.equal(cachedTokensFromUsage({ input_tokens_details: { cached_tokens: 12 } }), 12);
  assert.equal(cachedTokensFromUsage({ cache_read_input_tokens: 40 }), 40);
  assert.equal(cachedTokensFromUsage({ prompt_cache_hit_tokens: 7 }), 7);
  // A miss, a missing field and junk all read as zero rather than NaN in the UI.
  assert.equal(cachedTokensFromUsage({}), 0);
  assert.equal(cachedTokensFromUsage(null), 0);
  assert.equal(cachedTokensFromUsage({ prompt_tokens_details: { cached_tokens: 0 } }), 0);
  assert.equal(cachedTokensFromUsage({ prompt_tokens_details: { cached_tokens: 'nope' } }), 0);
});

test('the repeat notice exists, and only bites after a genuine repeat', () => {
  // One repeat is plausibly the model checking something; the notice is for the
  // pattern, which is why the threshold is not one.
  assert.ok(MAX_REPEATED_TOOL_CALLS >= 2);
  assert.match(REPEATED_TOOL_CALL_NOTICE, /already called that tool/i);
});

// A turn stored part-way through its tool loop, in the shape the page writes.
function stoppedTurn() {
  return [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'read my readme and fix the typos' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'github_read_file', arguments: '{"repo":"o/r","path":"README.md"}' } },
        { id: 'call_2', type: 'function', function: { name: 'web_search', arguments: '{"query":"typo"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'the readme' },
    { role: 'tool', tool_call_id: 'call_2', content: 'search results' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'github_list_files', arguments: '{"repo":"o/r"}' } }] },
    { role: 'tool', tool_call_id: 'call_3', content: 'file list' },
  ];
}

test('a stopped turn can be turned back into the answers it already paid for', () => {
  const memo = toolMemoFromConversation(stoppedTurn());
  assert.equal(memo.size, 3);
  assert.equal(memo.get(toolCallKey('github_read_file', { repo: 'o/r', path: 'README.md' })), 'the readme');
  assert.equal(memo.get(toolCallKey('web_search', { query: 'typo' })), 'search results');
  assert.equal(memo.get(toolCallKey('github_list_files', { repo: 'o/r' })), 'file list');
  // A batch boundary matters: a result must not be attributed to a call from a
  // different round just because the ids happen to look alike.
  assert.equal(memo.get(toolCallKey('github_read_file', { repo: 'o/r', path: 'other.md' })), undefined);
});

test('junk in place of a conversation yields no answers rather than a crash', () => {
  assert.equal(toolMemoFromConversation(null).size, 0);
  assert.equal(toolMemoFromConversation('nope').size, 0);
  // A tool result with no matching call is dropped, not stored under nothing.
  assert.equal(toolMemoFromConversation([{ role: 'tool', tool_call_id: 'ghost', content: 'x' }]).size, 0);
});

test('how much of a stopped turn is done is counted in tool steps', () => {
  assert.equal(pendingTurnStepCount(stoppedTurn()), 3);
  assert.equal(pendingTurnStepCount(null), 0);
  // Nothing worth keeping until something has actually been looked up.
  assert.equal(hasToolWork([{ role: 'user', content: 'hi' }]), false);
  assert.equal(hasToolWork(stoppedTurn()), true);
});

test('a stored turn survives the round trip, and only a plausible one does', () => {
  const turn = { question: 'fix the typos', convo: stoppedTurn(), steps: 3, at: 1700000000000 };
  const json = serializePendingTurn(turn);
  assert.ok(json);
  const back = parsePendingTurn(json);
  assert.equal(back.question, 'fix the typos');
  assert.equal(back.steps, 3);
  assert.equal(back.at, 1700000000000);
  assert.deepEqual(back.convo, turn.convo);

  // Anything that is not a turn this app wrote is treated as nothing at all,
  // rather than trusted into a request.
  assert.equal(parsePendingTurn(''), null);
  assert.equal(parsePendingTurn('not json'), null);
  assert.equal(parsePendingTurn('{"question":"q"}'), null, 'no conversation');
  assert.equal(parsePendingTurn('{"convo":[]}'), null, 'no question, no messages');
  assert.equal(parsePendingTurn('[1,2,3]'), null);
});

test('a turn too large to store is dropped whole rather than half-written', () => {
  const turn = { question: 'q', convo: [{ role: 'tool', content: 'x'.repeat(500) }] };
  assert.equal(serializePendingTurn(turn, 100), null);
  assert.ok(serializePendingTurn(turn, 10000));
  assert.ok(MAX_PENDING_TURN_CHARS > 10000);
  // Nothing worth storing, and un-storable input, are both null rather than
  // a JSON blob that would be replayed as a broken request.
  assert.equal(serializePendingTurn({ question: 'q', convo: [] }), null);
  assert.equal(serializePendingTurn({ convo: stoppedTurn() }), null);
  assert.equal(serializePendingTurn(null), null);
});

test('the continuation line tells the model not to repeat what is done', () => {
  assert.match(RESUME_CONTINUATION_PROMPT, /interrupted/i);
  assert.match(RESUME_CONTINUATION_PROMPT, /do not repeat/i);
});

test('a notice with no reply under it still gets a Retry that knows what to send', () => {
  // The ordinary case: a bot reply retries the user turn above it.
  assert.equal(retryTargetFor({ type: 'bot', content: 'hi' }, { type: 'user', content: 'ask' }), 'ask');
  // A bot reply with nothing above it has nothing to send.
  assert.equal(retryTargetFor({ type: 'bot' }, undefined), undefined);
  assert.equal(retryTargetFor({ type: 'bot' }, { type: 'system', content: 'x' }), undefined);
  // The case this exists for: the kept-steps notice carries its own target,
  // because there is no reply of its own to look above for one.
  assert.equal(
    retryTargetFor({ type: 'system', content: 'Kept 3 completed tool step(s)', retryText: 'fix the typos' }, { type: 'user', content: 'something else' }),
    'fix the typos',
  );
  // An error notice carries none, so it shows no button rather than a wrong one.
  assert.equal(retryTargetFor({ type: 'system', content: 'Error (x): boom' }, { type: 'user', content: 'ask' }), undefined);
  // Junk is not trusted into a request.
  assert.equal(retryTargetFor(null, undefined), undefined);
  assert.equal(retryTargetFor({ type: 'bot', retryText: '' }, { type: 'user', content: 'ask' }), 'ask');
});
