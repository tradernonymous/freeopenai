// Independent tool calls used to be awaited one at a time, so a question needing
// three files cost three round trips. The loop now runs reads together and keeps
// writes in turn -- and both halves of that are worth proving, because running a
// write alongside another tool is a race, not a speed-up.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  batchIndices,
  isConcurrentSafeTool,
  planToolCalls,
  MAX_CONCURRENT_TOOLS,
} = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = ['runChatWithTools', 'runToolCall'];

const call = (name, id) => ({ id, type: 'function', function: { name, arguments: '{}' } });

test('only reads are allowed to overlap', () => {
  assert.equal(isConcurrentSafeTool('web_search'), true);
  assert.equal(isConcurrentSafeTool('web_fetch'), true);
  assert.equal(isConcurrentSafeTool('github_read_file'), true);
  assert.equal(isConcurrentSafeTool('github_list_files'), true);
  // The one that changes something is never run alongside another.
  assert.equal(isConcurrentSafeTool('github_commit_file'), false);
  // Unknown and missing names are treated as unsafe rather than guessed at.
  assert.equal(isConcurrentSafeTool('some_future_tool'), false);
  assert.equal(isConcurrentSafeTool(''), false);
  assert.equal(isConcurrentSafeTool(undefined), false);
});

test('one round is split into the calls that may overlap and the ones that may not', () => {
  const calls = [
    call('web_search', 'a'),
    call('github_read_file', 'b'),
    call('github_commit_file', 'c'),
    call('web_fetch', 'd'),
  ];
  const plan = planToolCalls(calls);
  // Positions, so results can be paired back to the calls the model asked for.
  assert.deepEqual(plan.concurrent, [0, 1, 3]);
  assert.deepEqual(plan.serial, [2]);
  // Order within each group is the model's order.
  assert.deepEqual(planToolCalls([call('github_commit_file', 'x')]).serial, [0]);
  assert.deepEqual(planToolCalls([]).concurrent, []);
  assert.deepEqual(planToolCalls(null).serial, []);
  // Junk in the list must not crash a turn in progress.
  assert.deepEqual(planToolCalls([null, {}, call('web_search', 'y')]).concurrent, [2]);
});

test('a long round is sent in waves rather than all at once', () => {
  assert.deepEqual(batchIndices([0, 1, 2, 3, 4, 5, 6, 7, 8]), [[0, 1, 2, 3], [4, 5, 6, 7], [8]]);
  assert.deepEqual(batchIndices([0, 1], 2), [[0, 1]]);
  assert.deepEqual(batchIndices([]), []);
  // A nonsense size must not produce empty or endless batches.
  assert.deepEqual(batchIndices([0, 1], 0), [[0], [1]]);
  assert.ok(MAX_CONCURRENT_TOOLS > 0);
});

function harness({ toolCalls }) {
  const events = [];
  const conversation = [];
  const runs = [];
  let round = 0;
  const deps = {
    // The real decisions, so the loop is tested against the shipped rules.
    planToolCalls,
    batchIndices,
    isConcurrentSafeTool,
    MAX_TOOL_ROUNDS: 5,
    EMPTY_REPLY_NUDGE: 'nudge',
    TOOL_ROUNDS_EXHAUSTED_PROMPT: 'summarise',
    GITHUB_TOOLS: [],
    abortError: () => new Error('aborted'),
    isToolsRejection: () => false,
    extractMessageText: () => 'text',
    extractMessageReasoning: () => '',
    toConversationMessage: (m) => ({ role: 'assistant', content: '', tool_calls: m.tool_calls }),
    extractToolCalls: (m) => (m && m.tool_calls) || [],
    parseToolArgs: () => ({}),
    describeToolCall: (name) => 'step: ' + name,
    addMessage: (role, text) => events.push(text),
    showStatus: (kind, text) => events.push(kind + ': ' + text),
    isGithubTool: (n) => n.startsWith('github_'),
    isWebTool: (n) => n.startsWith('web_'),
    isUseSkillTool: (n) => n === 'use_skill',
    // The workspace has its own dispatch branch. The sandbox has to know about
    // it even though this file never calls one, or the loop's dependency guard
    // has no way to tell a new branch from a typo.
    isWorkspaceTool: (n) => n.startsWith('workspace_'),
    runWorkspaceTool: async () => 'workspace',
    // Each runner marks itself busy, waits a tick, then marks itself done. Two
    // overlapping calls therefore appear interleaved, which is the whole point.
    githubTool: 'github',
    // The timings differ on purpose. With every stub finishing in the same
    // tick, completion order collapses onto call order and a loop that recorded
    // results as they arrived would look correct.
    runGithubTool: async (name) => {
      runs.push({ name, phase: 'start' });
      await new Promise((r) => setTimeout(r, name === 'github_read_file' ? 20 : 5));
      runs.push({ name, phase: 'end' });
      return 'ran:' + name;
    },
    runWebTool: async (name) => {
      runs.push({ name, phase: 'start' });
      await new Promise((r) => setTimeout(r, 1));
      runs.push({ name, phase: 'end' });
      return 'web:' + name;
    },
    runUseSkillTool: async () => 'skill',
    callModel: async () => {
      round += 1;
      if (round === 1) return { message: { tool_calls: toolCalls }, finishReason: 'tool_calls' };
      return { message: { content: 'done' }, finishReason: 'stop' };
    },
  };
  deps.conversation = conversation;
  deps.events = events;
  deps.runs = runs;
  return { deps, conversation, events, runs, ...loadFromIndex(NAMES, deps) };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  const h = harness({ toolCalls: [] });
  assertSandboxCovers(NAMES, h.deps);
});

test('independent reads are issued together instead of one after another', async () => {
  const calls = [call('github_read_file', 'a'), call('github_read_file', 'b'), call('github_read_file', 'c')];
  const h = harness({ toolCalls: calls });
  await h.runChatWithTools(h.conversation, 'model', [], null);
  const order = h.runs.map((r) => r.name + ':' + r.phase);
  // All three start before any of them finishes: with a 5ms runner, three serial
  // calls would read start,end,start,end,start,end.
  assert.deepEqual(order, [
    'github_read_file:start',
    'github_read_file:start',
    'github_read_file:start',
    'github_read_file:end',
    'github_read_file:end',
    'github_read_file:end',
  ]);
  // And the user is told what is going on rather than seeing nothing.
  assert.ok(h.events.some((e) => /Looking up 3 things at once/.test(e)));
});

test('a write never overlaps another tool', async () => {
  const calls = [
    call('github_read_file', 'a'),
    call('github_commit_file', 'b'),
    call('github_read_file', 'c'),
  ];
  const h = harness({ toolCalls: calls });
  await h.runChatWithTools(h.conversation, 'model', [], null);
  const order = h.runs.map((r) => r.name + ':' + r.phase);
  // The two reads overlap each other, and the write runs alone, in between.
  assert.deepEqual(order, [
    'github_read_file:start',
    'github_read_file:start',
    'github_read_file:end',
    'github_read_file:end',
    'github_commit_file:start',
    'github_commit_file:end',
  ]);
});

test('results come back in the order the model asked for, whatever order they finished', async () => {
  const calls = [call('github_read_file', 'a'), call('web_search', 'b'), call('github_commit_file', 'c')];
  const h = harness({ toolCalls: calls });
  await h.runChatWithTools(h.conversation, 'model', [], null);
  // First prove the finishing order really is the reverse of the asking order,
  // otherwise this test would pass against a loop that recorded arrivals.
  assert.deepEqual(
    h.runs.map((r) => r.name + ':' + r.phase),
    [
      'github_read_file:start',
      'web_search:start',
      'web_search:end',
      'github_read_file:end',
      'github_commit_file:start',
      'github_commit_file:end',
    ],
  );
  const toolMessages = h.conversation.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMessages.map((m) => m.tool_call_id), ['a', 'b', 'c']);
  assert.deepEqual(toolMessages.map((m) => m.content), ['ran:github_read_file', 'web:web_search', 'ran:github_commit_file']);
});

test('a single lookup does not announce a wave', async () => {
  const h = harness({ toolCalls: [call('github_read_file', 'a')] });
  await h.runChatWithTools(h.conversation, 'model', [], null);
  assert.equal(h.events.some((e) => /things at once/.test(e)), false);
});
