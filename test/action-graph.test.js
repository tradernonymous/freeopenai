'use strict';

// A plan carried out as a graph rather than a conversation.
//
// A free model that has to be asked again between every step spends most of a
// build re-reading its own context, and loses the thread. `plan_actions` lets
// it lay the whole sequence out once, with each action naming what it waits
// for; the engine then runs them in order without asking again. What matters
// here is that the ordering is real, that a failure stops what depended on it
// rather than the whole graph, and that a cycle or an unknown tool is refused
// before anything runs.
const test = require('node:test');
const assert = require('node:assert/strict');

const { orderActions, MAX_GRAPH_ACTIONS } = require('../agent-sessions.js');

test('actions run after what they wait for, and independent ones keep their order', () => {
  const { order, error } = orderActions([
    { id: 'c', tool: 'run_command', args: { command: 'npm test' }, after: ['a', 'b'] },
    { id: 'a', tool: 'write_file', args: { path: 'a.js', content: 'x' } },
    { id: 'b', tool: 'write_file', args: { path: 'b.js', content: 'y' } },
  ]);
  assert.equal(error, '');
  assert.deepEqual(order.map((a) => a.id), ['a', 'b', 'c']);
});

test('a cycle, a missing dependency, a duplicate id and an unknown tool are all refused', () => {
  assert.match(orderActions([
    { id: 'a', tool: 'read_file', args: {}, after: ['b'] },
    { id: 'b', tool: 'read_file', args: {}, after: ['a'] },
  ]).error, /circle|cycle/i);
  assert.match(orderActions([{ id: 'a', tool: 'read_file', args: {}, after: ['ghost'] }]).error, /ghost/);
  assert.match(orderActions([
    { id: 'a', tool: 'read_file', args: {} },
    { id: 'a', tool: 'read_file', args: {} },
  ]).error, /twice|duplicate/i);
  assert.match(orderActions([{ id: 'a', tool: 'format_disk', args: {} }]).error, /format_disk/);
  assert.match(orderActions([{ id: 'a', tool: 'plan_actions', args: {} }]).error, /plan_actions/);
  assert.match(orderActions([{ id: 'a', tool: 'ask_user', args: { question: 'x' } }]).error, /ask_user/);
  assert.match(orderActions([]).error, /at least one/i);
  assert.match(orderActions(Array.from({ length: MAX_GRAPH_ACTIONS + 1 }, (_, i) => ({ id: 's' + i, tool: 'read_file', args: {} }))).error,
    new RegExp(String(MAX_GRAPH_ACTIONS)));
});

test('a loose name is matched the same way a tool call is', () => {
  const { order, error } = orderActions([{ id: '1', tool: 'bash', args: { command: 'ls' } }]);
  assert.equal(error, '');
  assert.equal(order[0].tool, 'run_command');
});
