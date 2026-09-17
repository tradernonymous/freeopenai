'use strict';

// Models without native tool calling write the call into their text, each
// family in its own shape. The parser has to read every shape the free tiers
// produce, and the hub has to hide the block from the user while still running
// it.
const { test } = require('node:test');
const assert = require('node:assert');

const { parseToolCallText, stripToolCallText, TOOL_CALL_SHAPES } = require('../tool-call-text');

test('llama-style <function=name><parameter=k>v</parameter></function> inside <tool_call>', () => {
  const text = 'Let me look.\n<tool_call>\n<function=run_command>\n<parameter=command>\ncd /app && head -5 src/ui/Hall.tsx\n</parameter>\n<parameter=cwd>portwebsitepilot</parameter>\n</function>\n</tool_call>';
  const calls = parseToolCallText(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'run_command');
  assert.deepEqual(calls[0].arguments, { command: 'cd /app && head -5 src/ui/Hall.tsx', cwd: 'portwebsitepilot' });
  assert.equal(stripToolCallText(text), 'Let me look.');
});

test('hermes/qwen <tool_call>{json}</tool_call>, several in one reply', () => {
  const text = '<tool_call>\n{"name": "read_file", "arguments": {"path": "a.md"}}\n</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"b.md"}}</tool_call>';
  const calls = parseToolCallText(text);
  assert.deepEqual(calls.map((c) => c.arguments.path), ['a.md', 'b.md']);
  assert.equal(stripToolCallText(text), '');
});

test('anthropic-style <invoke name="x"><parameter name="k">v</parameter></invoke>', () => {
  const text = 'Checking.\n<function_calls>\n<invoke name="web_search">\n<parameter name="query">node sea</parameter>\n</invoke>\n</function_calls>';
  const calls = parseToolCallText(text);
  assert.equal(calls[0].name, 'web_search');
  assert.deepEqual(calls[0].arguments, { query: 'node sea' });
  assert.equal(stripToolCallText(text), 'Checking.');
});

test('mistral [TOOL_CALLS] and a fenced json call', () => {
  const mistral = parseToolCallText('[TOOL_CALLS] [{"name": "web_fetch", "arguments": {"url": "https://x.y"}}]');
  assert.equal(mistral[0].name, 'web_fetch');
  const fenced = parseToolCallText('I will write it.\n```json\n{"tool": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}\n```');
  assert.equal(fenced[0].name, 'write_file');
  assert.equal(fenced[0].arguments.content, 'hi');
});

test('parameter values keep their type when they read as json, and stay strings otherwise', () => {
  const calls = parseToolCallText('<function=edit_file><parameter=all>true</parameter><parameter=old_text>{"a": 1}</parameter><parameter=new_text>2</parameter></function>');
  assert.deepEqual(calls[0].arguments, { all: true, old_text: '{"a": 1}', new_text: '2' });
});

test('prose that merely mentions a tool is not a call, and stripping leaves it alone', () => {
  const text = 'You could call read_file on {"path": "x"} yourself, or use <tool_call> syntax.';
  assert.deepEqual(parseToolCallText(text), []);
  assert.equal(stripToolCallText(text), text);
  assert.deepEqual(parseToolCallText(''), []);
  assert.deepEqual(parseToolCallText(null), []);
});

test('a code block that shows a tool call as an example is left to the reader', () => {
  const text = 'Example:\n```xml\n<function=run_command><parameter=command>ls</parameter></function>\n```';
  assert.deepEqual(parseToolCallText(text), []);
});

test('every shape is named so the prompt can list what is understood', () => {
  assert.ok(TOOL_CALL_SHAPES.length >= 4);
  for (const shape of TOOL_CALL_SHAPES) assert.equal(typeof shape, 'string');
});
