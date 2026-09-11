const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GITHUB_TOOLS,
  GITHUB_TOOL_NAMES,
  WEB_TOOLS,
  WEB_TOOL_NAMES,
  MAX_TOOL_ROUNDS,
  TOOL_ROUNDS_EXHAUSTED_PROMPT,
  isGithubTool,
  isWebTool,
  parseToolArgs,
  describeToolCall,
} = require('../chatlib.js');

test('every GitHub tool is a well-formed OpenAI function spec', () => {
  assert.ok(GITHUB_TOOLS.length >= 4);
  for (const tool of GITHUB_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.equal(typeof tool.function.name, 'string');
    assert.ok(tool.function.description.length > 20, `${tool.function.name} needs a real description`);
    assert.equal(tool.function.parameters.type, 'object');
    for (const required of tool.function.parameters.required) {
      assert.ok(
        required in tool.function.parameters.properties,
        `${tool.function.name} requires "${required}" but never defines it`
      );
    }
  }
});

test('tool names are unique and recognised by isGithubTool', () => {
  assert.equal(new Set(GITHUB_TOOL_NAMES).size, GITHUB_TOOL_NAMES.length);
  assert.ok(isGithubTool('github_read_file'));
  assert.ok(!isGithubTool('rm_rf_everything'));
  assert.ok(!isGithubTool(undefined));
});

test('web research tools are well-formed, unique, and recognised', () => {
  assert.deepEqual(WEB_TOOL_NAMES, ['web_search', 'web_fetch']);
  for (const tool of WEB_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.ok(tool.function.description.length > 20, `${tool.function.name} needs a real description`);
    for (const required of tool.function.parameters.required) {
      assert.ok(required in tool.function.parameters.properties);
    }
  }
  assert.ok(isWebTool('web_search'));
  assert.ok(isWebTool('web_fetch'));
  assert.ok(!isWebTool('github_read_file'));
  assert.ok(!isWebTool(undefined));
  const all = [...GITHUB_TOOL_NAMES, ...WEB_TOOL_NAMES];
  assert.equal(new Set(all).size, all.length, 'no name may exist on both lists');
});

test('describeToolCall narrates web calls for the transcript', () => {
  assert.match(describeToolCall('web_search', { query: 'deno 2' }), /deno 2/);
  assert.match(describeToolCall('web_fetch', { url: 'https://example.com/x' }), /example\.com\/x/);
  assert.match(describeToolCall('web_search', {}), /\?/);
});

test('the tool loop is bounded, with room for real multi-file work', () => {
  // Find a repo, list a folder, read two files, commit one: five rounds before
  // anything unusual happens. Six used to cut ordinary requests short.
  assert.ok(MAX_TOOL_ROUNDS >= 10, 'too low for ordinary requests');
  assert.ok(MAX_TOOL_ROUNDS <= 20, 'every round is a billed call');
});

test('hitting the ceiling asks for a summary rather than giving up', () => {
  assert.match(TOOL_ROUNDS_EXHAUSTED_PROMPT, /stop using tools/i);
  assert.match(TOOL_ROUNDS_EXHAUSTED_PROMPT, /still left to do/i);
  // Without file paths the follow-up request can't resume anywhere useful.
  assert.match(TOOL_ROUNDS_EXHAUSTED_PROMPT, /file paths/i);
});

test('parseToolArgs handles the shapes a model actually emits', () => {
  assert.deepEqual(parseToolArgs('{"repo":"a/b"}'), { repo: 'a/b' });
  assert.deepEqual(parseToolArgs({ repo: 'a/b' }), { repo: 'a/b' });
  assert.deepEqual(parseToolArgs('not json'), {});
  assert.deepEqual(parseToolArgs(''), {});
  assert.deepEqual(parseToolArgs(undefined), {});
  assert.deepEqual(parseToolArgs('"a string"'), {});
  assert.deepEqual(parseToolArgs('null'), {});
});

test('describeToolCall reads as plain English for every tool', () => {
  assert.match(describeToolCall('github_list_repos', {}), /repositories/i);
  assert.match(describeToolCall('github_read_file', { repo: 'a/b', path: 'x.js' }), /Reading "x\.js" from a\/b/);
  assert.match(describeToolCall('github_commit_file', { repo: 'a/b', path: 'x.js' }), /Committing "x\.js" to a\/b/);
  assert.match(describeToolCall('github_list_files', { repo: 'a/b' }), /root of a\/b/);
  assert.match(describeToolCall('github_list_files', { repo: 'a/b', path: 'src' }), /"src" in a\/b/);
});

test('describeToolCall survives missing arguments', () => {
  assert.equal(typeof describeToolCall('github_read_file'), 'string');
  assert.match(describeToolCall('github_read_file', {}), /a repo/);
  assert.match(describeToolCall('something_else', {}), /something_else/);
});

const { extractMessageText, extractMessageReasoning, extractToolCalls } = require('../chatlib.js');

test('extractMessageText reads an OpenAI-style string reply', () => {
  assert.equal(extractMessageText({ content: 'hello' }), 'hello');
  assert.equal(extractMessageText('hello'), 'hello');
  assert.equal(extractMessageText({ text: 'hello' }), 'hello');
});

test('extractMessageText reads a Claude content-block array', () => {
  // The exact shape that rendered as "[object Object]" in production.
  assert.equal(extractMessageText({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
  assert.equal(
    extractMessageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    'ab'
  );
});

test('extractMessageText never returns the string "[object Object]"', () => {
  const shapes = [
    { content: [{ type: 'text', text: 'ok' }] },
    { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }] },
    { content: [] },
    { content: null },
    {},
    null,
    undefined,
  ];
  for (const shape of shapes) {
    assert.ok(!extractMessageText(shape).includes('[object Object]'), JSON.stringify(shape));
  }
});

test('extractMessageText leaves thinking blocks out of the answer', () => {
  const message = { content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'answer' }] };
  assert.equal(extractMessageText(message), 'answer');
});

test('extractMessageReasoning handles both providers', () => {
  assert.equal(extractMessageReasoning({ reasoning: 'because' }), 'because');
  assert.equal(
    extractMessageReasoning({ content: [{ type: 'thinking', thinking: 'step 1' }, { type: 'text', text: 'answer' }] }),
    'step 1'
  );
  assert.equal(extractMessageReasoning({ content: 'plain' }), '');
  assert.equal(extractMessageReasoning(null), '');
});

test('extractToolCalls normalizes Claude tool_use blocks to the OpenAI shape', () => {
  const openai = { tool_calls: [{ id: 'c1', function: { name: 'github_read_file', arguments: '{}' } }] };
  assert.equal(extractToolCalls(openai)[0].function.name, 'github_read_file');

  const claude = { content: [{ type: 'tool_use', id: 'tu1', name: 'github_read_file', input: { repo: 'a/b' } }] };
  const normalized = extractToolCalls(claude);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, 'tu1');
  assert.equal(normalized[0].function.name, 'github_read_file');
  // parseToolArgs accepts the already-parsed object Claude gives us.
  assert.deepEqual(parseToolArgs(normalized[0].function.arguments), { repo: 'a/b' });
});

test('extractToolCalls returns an empty list when there are none', () => {
  assert.deepEqual(extractToolCalls({ content: [{ type: 'text', text: 'hi' }] }), []);
  assert.deepEqual(extractToolCalls({}), []);
  assert.deepEqual(extractToolCalls(null), []);
});

const {
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  EFFORT_CAPABLE_MODEL_IDS,
  supportsEffort,
  isValidEffort,
  MODELS,
} = require('../chatlib.js');

test('effort levels are exactly the six Puter accepts', () => {
  assert.deepEqual(
    EFFORT_LEVELS.map((l) => l.id),
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  );
  for (const level of EFFORT_LEVELS) {
    assert.ok(level.name && level.desc, `${level.id} needs a name and description`);
  }
});

test('the default sends nothing, preserving prior behaviour', () => {
  assert.equal(DEFAULT_EFFORT, '');
  assert.ok(!isValidEffort(DEFAULT_EFFORT), 'the default must not be a real level');
});

test('isValidEffort rejects anything not on the list', () => {
  assert.ok(isValidEffort('xhigh'));
  assert.ok(isValidEffort('none'));
  assert.ok(!isValidEffort('ultra'));
  assert.ok(!isValidEffort(''));
  assert.ok(!isValidEffort(undefined));
});

test('every effort-capable id is a real model', () => {
  for (const id of EFFORT_CAPABLE_MODEL_IDS) {
    assert.ok(MODELS.some((m) => m.id === id), `${id} is not in MODELS`);
  }
});

test('supportsEffort covers the reasoning tiers and nothing else', () => {
  assert.ok(supportsEffort('claude-sonnet-5'));
  assert.ok(supportsEffort('gpt-6-astra-pro'));
  // Plain tiers and the coding models must not show the picker.
  assert.ok(!supportsEffort('gpt-4o'));
  assert.ok(!supportsEffort('gpt-5.4-nano'));
  assert.ok(!supportsEffort('openai/gpt-5.3-codex'));
  assert.ok(!supportsEffort(undefined));
});

test('all three Claude models take an effort setting', () => {
  for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
    assert.ok(supportsEffort(id), `${id} should support effort`);
  }
});

test('a commit description always names the identity it will land under', () => {
  // Never let a confirm dialog be vague about which account is committing.
  assert.match(describeToolCall('github_commit_file', { repo: 'alice/x', path: 'a.md' }), / as alice$/);
  assert.match(describeToolCall('github_commit_file', { repo: 'org/x', path: 'a.md', account: 'bob' }), / as bob$/);
});

test('repo-scoped tools accept an optional account argument', () => {
  for (const name of ['github_list_files', 'github_read_file', 'github_commit_file']) {
    const spec = GITHUB_TOOLS.find((t) => t.function.name === name);
    assert.ok(spec.function.parameters.properties.account, `${name} needs an account argument`);
    assert.ok(!spec.function.parameters.required.includes('account'), `${name} must not require it`);
  }
});

const { isEffortUnsupportedError } = require('../chatlib.js');

test('the exact Anthropic refusal seen in production is recognised', () => {
  const real = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.enabled\\" is not supported for this model. Use \\"thinking.type.adaptive\\" and \\"output_config.effort\\" to control thinking behavior."},"request_id":"req_011CetbKm3SuCmpdTrLt2pzK"}');
  assert.ok(isEffortUnsupportedError(real));
});

test('effort refusals are recognised however they are wrapped', () => {
  assert.ok(isEffortUnsupportedError('400 reasoning_effort is not supported'));
  assert.ok(isEffortUnsupportedError({ message: 'invalid_request_error: thinking.type is unsupported' }));
  assert.ok(isEffortUnsupportedError({ error: '400 output_config.effort not supported' }));
});

test('unrelated failures are left alone, so they are not silently retried', () => {
  assert.ok(!isEffortUnsupportedError('429 rate limited'));
  assert.ok(!isEffortUnsupportedError('500 internal error'));
  assert.ok(!isEffortUnsupportedError(new Error('Network request failed')));
  assert.ok(!isEffortUnsupportedError('400 model not found'));
  assert.ok(!isEffortUnsupportedError(null));
  assert.ok(!isEffortUnsupportedError(''));
});

const { toConversationMessage } = require('../chatlib.js');

test('metadata on a reply never travels back into the conversation', () => {
  // The exact shape that produced "messages.1.model: Extra inputs are not permitted".
  const reply = {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    model: 'claude-sonnet-5',
    id: 'msg_123',
    usage: { input_tokens: 10 },
    stop_reason: 'end_turn',
    type: 'message',
  };
  const turn = toConversationMessage(reply);
  assert.deepEqual(Object.keys(turn).sort(), ['content', 'role']);
  assert.equal(turn.model, undefined);
  assert.equal(turn.usage, undefined);
  assert.deepEqual(turn.content, [{ type: 'text', text: 'hi' }]);
});

test('tool_calls survive the trip back, since the loop depends on them', () => {
  const turn = toConversationMessage({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', function: { name: 'github_read_file', arguments: '{}' } }],
    model: 'gpt-4o',
  });
  assert.equal(turn.tool_calls.length, 1);
  assert.equal(turn.model, undefined);
});

test('a Claude tool_use block is preserved so its result can be matched', () => {
  const turn = toConversationMessage({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu1', name: 'github_read_file', input: {} }],
    model: 'claude-opus-5',
  });
  assert.equal(turn.content[0].type, 'tool_use');
  assert.equal(turn.content[0].id, 'tu1');
  assert.ok(!('model' in turn));
});

test('toConversationMessage handles junk without throwing', () => {
  assert.equal(toConversationMessage(null), null);
  assert.equal(toConversationMessage('a string'), null);
  assert.deepEqual(toConversationMessage({}), { role: 'assistant', content: '' });
  assert.deepEqual(toConversationMessage({ tool_calls: [] }), { role: 'assistant', content: '' });
});

const { isOutOfCreditsError, isHeavyModel, estimateCostWarning, HEAVY_MODEL_IDS } = require('../chatlib.js');

test('the exact out-of-credits error from production is recognised', () => {
  assert.ok(isOutOfCreditsError('Error: No usage left for request.'));
  assert.ok(isOutOfCreditsError(new Error('No usage left for request')));
  assert.ok(isOutOfCreditsError('402 insufficient credits'));
  assert.ok(isOutOfCreditsError({ message: 'quota exceeded' }));
});

test('ordinary failures are not mistaken for an empty balance', () => {
  assert.ok(!isOutOfCreditsError('429 rate limited'));
  assert.ok(!isOutOfCreditsError('500 internal error'));
  assert.ok(!isOutOfCreditsError('400 bad request'));
  assert.ok(!isOutOfCreditsError(null));
});

test('every heavy model id is a real model', () => {
  for (const id of HEAVY_MODEL_IDS) {
    assert.ok(MODELS.some((m) => m.id === id), `${id} is not in MODELS`);
  }
  assert.ok(isHeavyModel('claude-opus-5'));
  assert.ok(!isHeavyModel('claude-haiku-4-5'));
  assert.ok(!isHeavyModel('gpt-5.4-nano'));
});

test('the cost warning needs at least two expensive choices, not one', () => {
  // One heavy choice on its own is normal use and shouldn't nag.
  assert.equal(estimateCostWarning('claude-opus-5', '', false), '');
  assert.equal(estimateCostWarning('gpt-5.4-nano', 'xhigh', false), '');
  assert.equal(estimateCostWarning('gpt-5.4-nano', '', true), '');
});

test('the combination that emptied the allowance is called out by name', () => {
  const warning = estimateCostWarning('claude-opus-5', 'xhigh', true);
  assert.match(warning, /top-tier model/);
  assert.match(warning, /xhigh reasoning effort/);
  assert.match(warning, /each step is another request/);
});
