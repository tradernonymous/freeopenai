// Independent tool calls used to be awaited one at a time, so a question needing
// three files cost three round trips. The loop now runs reads together and keeps
// writes in turn -- and both halves of that are worth proving, because running a
// write alongside another tool is a race, not a speed-up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  batchIndices,
  isConcurrentSafeTool,
  planToolCalls,
  MAX_CONCURRENT_TOOLS,
  MAX_TOOL_RESULT_CHARS,
  toolCallKey,
  clipToolResult,
  REPEATED_TOOL_CALL_NOTICE,
  MAX_REPEATED_TOOL_CALLS,
  toolMemoFromConversation,
  RESUME_CONTINUATION_PROMPT,
  createReadMemory,
  isTaskWriteTool,
  todoReportNudge,
  newTaskGraph,
  addTask,
  setTaskStatus,
} = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = ['runChatWithTools', 'runToolCall'];

// Arguments are real JSON, not an empty object for every call: two calls to the
// same tool are only the same call when their arguments match, so a harness
// that erased them would make every repeat look identical.
const call = (name, id, args = {}) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

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

function harness({ toolCalls, rounds = null, webResult = null, taskGraph = null }) {
  const events = [];
  const conversation = [];
  const runs = [];
  let round = 0;
  const deps = {
    // The real decisions, so the loop is tested against the shipped rules.
    planToolCalls,
    batchIndices,
    isConcurrentSafeTool,
    toolCallKey,
    clipToolResult,
    REPEATED_TOOL_CALL_NOTICE,
    MAX_REPEATED_TOOL_CALLS,
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
    parseToolArgs: (raw) => {
      try { return JSON.parse(raw || '{}'); } catch { return {}; }
    },
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
    runWorkspaceTool: async (name) => {
      runs.push({ name, phase: 'start' });
      await new Promise((r) => setTimeout(r, 1));
      runs.push({ name, phase: 'end' });
      return 'workspace:' + name;
    },
    // Same again for the task tools, which added their own branch.
    isTaskTool: (n) => n.startsWith('task_'),
    runTaskTool: async () => 'task',
    // The real rule and the real nudge, not stubs: the loop arms its
    // "you still have todos open" check off this pair, and a stub would let the
    // test pass while the shipped pairing did nothing.
    isTaskWriteTool,
    todoReportNudge,
    // Empty by default, so an unrelated test is not nudged about a plan it never
    // made. The tests that care set their own.
    taskGraph: taskGraph || newTaskGraph(),
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
      return webResult || 'web:' + name;
    },
    runUseSkillTool: async () => 'skill',
    // `rounds` lets a test script what the model asks for turn by turn, which
    // is what a repeat across rounds needs; `toolCalls` stays the simple case.
    callModel: async () => {
      const planned = rounds ? rounds[round] : round === 0 ? toolCalls : [];
      round += 1;
      if (planned && planned.length) return { message: { tool_calls: planned }, finishReason: 'tool_calls' };
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
  const calls = [
    call('github_read_file', 'a', { repo: 'o/r', path: 'a.md' }),
    call('github_read_file', 'b', { repo: 'o/r', path: 'b.md' }),
    call('github_read_file', 'c', { repo: 'o/r', path: 'c.md' }),
  ];
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
    call('github_read_file', 'a', { repo: 'o/r', path: 'a.md' }),
    call('github_commit_file', 'b', { repo: 'o/r', path: 'a.md', content: 'x', message: 'y' }),
    call('github_read_file', 'c', { repo: 'o/r', path: 'c.md' }),
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
  const h = harness({ toolCalls: [call('github_read_file', 'a', { repo: 'o/r', path: 'a.md' })] });
  await h.runChatWithTools(h.conversation, 'model', [], null);
  assert.equal(h.events.some((e) => /things at once/.test(e)), false);
});

test('the same call twice in one round runs once and shares the answer', async () => {
  const h = harness({
    toolCalls: [
      call('web_search', 'a', { query: 'railway deploy' }),
      call('web_search', 'b', { query: 'railway deploy' }),
    ],
  });
  await h.runChatWithTools(h.conversation, 'model', [], null, new Map());
  // A runner records a start and an end, so one search is two entries here.
  assert.deepEqual(h.runs.map((r) => r.name + ':' + r.phase), ['web_search:start', 'web_search:end'], 'one search, not two');
  // Both tool_call_ids still get an answer, or the provider rejects the turn.
  const toolMessages = h.conversation.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMessages.map((m) => m.tool_call_id), ['a', 'b']);
  assert.deepEqual(toolMessages.map((m) => m.content), ['web:web_search', 'web:web_search']);
  assert.ok(h.events.some((e) => /Reused 1 earlier tool/.test(e)));
});

test('a call already answered earlier in the question is not paid for again', async () => {
  // Different ids, different rounds, identical arguments: the model re-reading
  // the same file. The memos are what make this one round trip instead of two.
  const read = (id) => call('github_read_file', id, { repo: 'o/r', path: 'README.md' });
  const h = harness({ rounds: [[read('a')], [read('b')], []] });
  const memo = new Map();
  await h.runChatWithTools(h.conversation, 'model', [], null, memo);
  assert.deepEqual(h.runs.map((r) => r.name + ':' + r.phase), [
    'github_read_file:start',
    'github_read_file:end',
  ]);
  const toolMessages = h.conversation.filter((m) => m.role === 'tool');
  assert.equal(toolMessages[1].content, toolMessages[0].content, 'the second answer is the first one');
  assert.equal(memo.size, 1, 'and the answer is on record for the rest of the question');
});

test('a question that repeats itself is told plainly to stop', async () => {
  const search = (id) => call('web_search', id, { query: 'same thing' });
  const h = harness({ rounds: [[search('a')], [search('b')], [search('c')], []] });
  await h.runChatWithTools(h.conversation, 'model', [], null, new Map());
  // The search ran once for three asks.
  assert.deepEqual(h.runs.map((r) => r.name + ':' + r.phase), ['web_search:start', 'web_search:end']);
  // And the instruction not to repeat it arrived in the conversation, where the
  // next round can read it -- a status toast is what the model never sees.
  const said = h.conversation.filter((m) => m.role === 'user');
  assert.equal(said.length, 1);
  assert.match(said[0].content, /already called that tool/i);
});

test('a turn picked back up does not buy its lookups a second time', async () => {
  const args = { repo: 'o/r', path: 'README.md' };
  // What a stopped turn looks like on the way back in: the model's own calls,
  // the results recorded against them, and the line that tells it to carry on.
  const restored = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'read my readme and fix the typos' },
    { role: 'assistant', content: '', tool_calls: [call('github_read_file', 'a', args)] },
    { role: 'tool', tool_call_id: 'a', content: 'ran:github_read_file' },
    { role: 'user', content: RESUME_CONTINUATION_PROMPT },
  ];
  // Continuing, the model asks for the very file it already read.
  const h = harness({ rounds: [[call('github_read_file', 'b', args)], []] });
  await h.runChatWithTools(restored, 'model', [], null, toolMemoFromConversation(restored));
  assert.deepEqual(h.runs, [], 'the read was already paid for');
  const toolMessages = restored.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.equal(toolMessages[1].content, 'ran:github_read_file', 'the answer is the stored one');
});

test('a huge tool result is clipped before every later round re-sends it', async () => {
  const huge = 'y'.repeat(MAX_TOOL_RESULT_CHARS + 500);
  const h = harness({
    toolCalls: [call('web_fetch', 'a', { url: 'https://example.com/long' })],
    webResult: huge,
  });
  await h.runChatWithTools(h.conversation, 'model', [], null, new Map());
  const content = h.conversation.find((m) => m.role === 'tool').content;
  assert.ok(content.length < huge.length);
  assert.equal(content.startsWith('y'.repeat(MAX_TOOL_RESULT_CHARS)), true);
  assert.match(content, /clipped/);
});

test('a read paid for in an earlier question is not bought again by the next one', async () => {
  const args = { repo: 'o/r', path: 'README.md' };
  const memory = createReadMemory();
  const ask = (id) => harness({ rounds: [[call('github_read_file', id, args)], []] });

  const first = ask('a');
  await first.runChatWithTools(first.conversation, 'model', [], null, new Map(), memory);
  assert.deepEqual(first.runs.map((r) => r.phase), ['start', 'end']);

  // The second question gets its own -- empty -- question memo, which is exactly
  // the state in which this read used to be paid for all over again.
  const second = ask('b');
  await second.runChatWithTools(second.conversation, 'model', [], null, new Map(), memory);
  assert.deepEqual(second.runs, [], 'the second question did not read it again');
  const content = second.conversation.find((m) => m.role === 'tool').content;
  assert.equal(content, '[remembered from a moment ago] ran:github_read_file');
  assert.ok(second.events.some((e) => /earlier in this conversation/.test(e)));
});

test('a file written is not read back from the answer that came before the write', async () => {
  const read = (id) => call('workspace_read_file', id, { path: 'notes/a.md' });
  const write = (id) => call('workspace_write_file', id, { path: 'notes/a.md', content: 'new' });
  const h = harness({ rounds: [[read('a')], [write('b')], [read('c')], []] });
  await h.runChatWithTools(h.conversation, 'model', [], null, new Map(), createReadMemory());
  // Read, write, read: the second read has to be a real one. Serving it from the
  // memo would hand the model the text from before its own write, and it would
  // conclude the write had failed.
  assert.deepEqual(
    h.runs.filter((r) => r.phase === 'start').map((r) => r.name),
    ['workspace_read_file', 'workspace_write_file', 'workspace_read_file']
  );
  assert.equal(
    h.conversation.some((m) => m.role === 'tool' && /remembered from/.test(m.content)),
    false,
    'and nothing about that file is remembered across the write'
  );
});

test('a write is still only run once when the model asks twice', async () => {
  const write = (id) => call('workspace_write_file', id, { path: 'notes/a.md', content: 'same' });
  const h = harness({ rounds: [[write('a')], [write('b')], []] });
  await h.runChatWithTools(h.conversation, 'model', [], null, new Map(), createReadMemory());
  // Forgetting what a write touched must not forget the write: this is the guard
  // that keeps a duplicate commit from becoming a second commit.
  assert.deepEqual(h.runs.map((r) => r.phase), ['start', 'end']);
});

test('a report that arrives with its own plan still open is sent back once', async () => {
  // A turn that wrote to the list and left one task open behind it.
  let graph = addTask(newTaskGraph(), { title: 'Ship the panel' }).graph;
  graph = addTask(graph, { title: 'Verify it in a browser' }).graph;
  graph = setTaskStatus(graph, 't1', 'doing').graph;
  graph = setTaskStatus(graph, 't2', 'done').graph;
  const h = harness({
    rounds: [[call('task_update', 'a', { id: 't1', status: 'doing' })], [], []],
    taskGraph: graph,
  });
  const result = await h.runChatWithTools(h.conversation, 'model', [], null);
  const said = h.conversation.filter((m) => m.role === 'user');
  // Once, not once per round: a model that will not reconcile on the first ask
  // will not on the second, and the user is waiting.
  assert.equal(said.length, 1, 'nudged once: ' + JSON.stringify(said.map((m) => m.content)));
  assert.match(said[0].content, /TODO LIST — 1 of 2 still open/);
  assert.match(said[0].content, /\[doing\] t1 Ship the panel/);
  assert.match(said[0].content, /Do not report the work as complete while they are open/);
  // And the turn still ends with the model's own answer: the nudge is one more
  // chance to be honest, not a loop that holds the reply hostage.
  assert.equal(result.message.content, 'done');
});

test('an old open todo does not interrupt a turn that never touched the list', async () => {
  // The list is carried between conversations on purpose, so an unfinished task
  // from last week is normal. A turn that never wrote to it was not working from
  // it, and interrupting an unrelated answer would make the list a nuisance.
  const graph = addTask(newTaskGraph(), { title: 'From an earlier conversation' }).graph;
  const h = harness({ rounds: [[call('web_search', 'a', { query: 'something else' })], []], taskGraph: graph });
  await h.runChatWithTools(h.conversation, 'model', [], null);
  assert.deepEqual(h.conversation.filter((m) => m.role === 'user'), []);
});

test('a turn that wrote to the list and closed everything is not nagged', async () => {
  const graph = setTaskStatus(addTask(newTaskGraph(), { title: 'Only one' }).graph, 't1', 'done').graph;
  const h = harness({ rounds: [[call('task_update', 'a', { id: 't1', status: 'done' })], []], taskGraph: graph });
  await h.runChatWithTools(h.conversation, 'model', [], null);
  assert.deepEqual(h.conversation.filter((m) => m.role === 'user'), []);
});

test('the shipped call site hands the loop a memory to remember reads in', () => {
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(HTML, /readMemoryFor\(activeConversationId\)/, 'the page keeps a per-conversation read memory');
  assert.match(
    HTML,
    /runChatWithTools\(turnConvo, selectedModel, tools, controller\.signal, memo, remembered\)/,
    'and passes it in, or the memory is written and never read'
  );
});
