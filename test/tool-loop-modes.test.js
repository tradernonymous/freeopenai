// The page's tool loop, on the two things that decide whether a coding task
// finishes: a call the model wrote as text is still run, and a build gets more
// steps than a question.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_TOOL_ROUNDS,
  TOOL_ROUNDS_BY_MODE,
  toolRoundsForMode,
  textToolCalls,
  withTextToolCalls,
  workspacePrompt,
  modePrompt,
  WEB_TOOLS,
  RUN_TOOLS,
} = require('../chatlib.js');

test('a build gets more tool steps than a chat, and chat keeps the old ceiling', () => {
  assert.equal(toolRoundsForMode('chat'), MAX_TOOL_ROUNDS);
  assert.ok(toolRoundsForMode('plan') > toolRoundsForMode('chat'));
  assert.ok(toolRoundsForMode('build') >= 50, 'a clone, a read, an edit, a test run and a fix is already ten');
  assert.equal(toolRoundsForMode('nonsense'), MAX_TOOL_ROUNDS);
  assert.deepEqual(Object.keys(TOOL_ROUNDS_BY_MODE).sort(), ['build', 'chat', 'plan']);
});

test('a tool call the model wrote as text runs, if it names a tool that was offered', () => {
  const tools = [...WEB_TOOLS, ...RUN_TOOLS];
  const message = { role: 'assistant', content: 'Checking.\n<tool_call>\n<function=run_command>\n<parameter=command>npm test</parameter>\n</function>\n</tool_call>' };
  const calls = textToolCalls(message, tools);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'run_command');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { command: 'npm test' });
  const cleaned = withTextToolCalls(message, calls);
  assert.equal(cleaned.content, 'Checking.');
  assert.equal(cleaned.tool_calls, calls);

  const foreign = { role: 'assistant', content: '<tool_call>{"name":"format_disk","arguments":{}}</tool_call>' };
  assert.deepEqual(textToolCalls(foreign, tools), [], 'a name that was never offered is prose');
  assert.deepEqual(textToolCalls(message, []), [], 'no tools offered, nothing parsed');
  assert.deepEqual(textToolCalls({ role: 'assistant', content: 'plain answer' }, tools), []);
});

test('the prompt says where the workspace is, and Build mode carries the coding rules', () => {
  assert.match(workspacePrompt(true), /run_command runs in/);
  assert.match(workspacePrompt(true), /git works/);
  assert.match(workspacePrompt(false), /browser/);
  const build = modePrompt('build');
  for (const rule of [/search/i, /re-read a file after a failed edit/i, /never force push/i, /non-interactive/i, /never assume a library/i]) {
    assert.match(build, rule);
  }
});
