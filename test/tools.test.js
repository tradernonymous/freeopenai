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
