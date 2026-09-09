const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GITHUB_TOOLS,
  GITHUB_TOOL_NAMES,
  MAX_TOOL_ROUNDS,
  isGithubTool,
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

test('the tool loop is bounded', () => {
  assert.ok(MAX_TOOL_ROUNDS > 1 && MAX_TOOL_ROUNDS <= 10);
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
