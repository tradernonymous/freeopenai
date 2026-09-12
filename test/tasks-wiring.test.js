// The task tools live in index.html, where they were invisible to CI before the
// shared harness existed. These tests run the shipped function against stubs, so
// what is exercised is the wiring as written.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  newTaskGraph,
  normalizeTaskGraph,
  addTask,
  setTaskStatus,
  renderTaskGraphText,
  renderTaskGraphPrompt,
} = require('../chatlib.js');
const {
  loadFromIndex,
  referencedPageNames,
  assertScannerCanRead,
  assertSandboxCovers,
} = require('./helpers/index-html.js');

const NAMES = ['runTaskTool', 'buildConversation'];

function harness({ graph = newTaskGraph() } = {}) {
  let saves = 0;
  const events = [];
  const deps = {
    // The real rules, not stubs: this exercises the shipped pairing of the
    // page's wiring with chatlib's decisions.
    addTask,
    setTaskStatus,
    renderTaskGraphText,
    renderTaskGraphPrompt,
    normalizeTaskGraph,
    newTaskGraph,
    taskGraph: graph,
    saveTaskGraph: () => { saves += 1; },
    showStatus: (kind, text) => events.push(kind + ': ' + text),
    // What buildConversation needs to assemble a request.
    SYSTEM_PROMPT: 'You are a helpful assistant.',
    modePrompt: () => 'Mode: build',
    renderSkillsPrompt: () => 'skills',
    buildChatHistory: () => [],
    messages: [],
    selectedMode: 'build',
  };
  const loaded = loadFromIndex(NAMES, deps);
  return {
    deps,
    call: (name, args) => loaded.runTaskTool(name, args),
    request: () => loaded.buildConversation('hello'),
    system: () => loaded.buildConversation('hello')[0].content,
    graph: () => deps.taskGraph,
    tasks: () => deps.taskGraph.tasks,
    saves: () => saves,
  };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('a task write never asks for permission', () => {
  // The list changes nothing outside this conversation, and a dialog in front of
  // every status change would make planning unusable. Asserted as a property
  // rather than described: if the wiring ever reached for an approval function,
  // this fails and so does the sandbox guard above.
  // Checked against the tool itself, not the whole file: several unrelated
  // helpers have "prompt" in their name, which says nothing about approvals.
  const reached = referencedPageNames(['runTaskTool']);
  assert.deepEqual(reached.filter((name) => /confirm|approval|permission/i.test(name)), []);
});

test('the list starts empty and says so', async () => {
  assert.equal(await harness().call('task_list', {}), 'The task list is empty.');
});

test('the list rides at the end of the request, never in the cacheable system prompt', () => {
  const withTasks = harness({ graph: addTask(newTaskGraph(), { title: 'Ship the poller fix' }).graph });
  const request = withTasks.request();
  assert.equal(request[0].role, 'system');
  assert.ok(request[0].content.includes('You are a helpful assistant.'), 'the base prompt is still there');
  // The system message is the part a provider can reuse between turns, so the
  // list that changes as work moves must not be inside it.
  assert.equal(request[0].content.includes('TASK LIST'), false);
  const last = request[request.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(last.content.startsWith('hello'), 'the user turn is still the user turn');
  assert.ok(last.content.includes('TASK LIST'), 'the list is announced');
  assert.ok(last.content.includes('t1 Ship the poller fix'), 'and the tasks are in it');
  // An empty list must not add a heading about nothing on every single request.
  assert.equal(harness().request().slice(-1)[0].content.includes('TASK LIST'), false);
});

test('the system prompt does not change when the task list does', () => {
  // This is the whole reason the list moved: a prefix that changes on every turn
  // can never be served from the provider's cache, so every turn re-reads the
  // entire conversation at full price.
  const first = addTask(newTaskGraph(), { title: 'one' }).graph;
  const h = harness({ graph: first });
  const before = h.request()[0].content;
  h.deps.taskGraph = addTask(first, { title: 'two' }).graph;
  assert.equal(h.request()[0].content, before, 'a moving task list must not invalidate the prefix');
  assert.ok(h.request().slice(-1)[0].content.includes('t2 two'), 'and the new task still reaches the model');
});

test('adding a task records it, saves once, and reports its id', async () => {
  const h = harness();
  const reply = await h.call('task_add', { title: 'Fix the model menu' });
  assert.equal(reply, 'Added t1: Fix the model menu. 1 task(s) on the list.');
  assert.equal(h.saves(), 1);
  assert.deepEqual(h.tasks().map((t) => t.id + ' ' + t.status), ['t1 todo']);
  // And the list the model gets back reflects it straight away.
  assert.match(await h.call('task_list', {}), /\[todo\] t1 Fix the model menu/);
});

test('ids keep counting up across calls through the tool', async () => {
  const h = harness();
  await h.call('task_add', { title: 'one' });
  await h.call('task_add', { title: 'two', depends_on: 't1' });
  assert.deepEqual(h.tasks().map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(h.tasks()[1].dependsOn, ['t1']);
  assert.equal(h.saves(), 2);
});

test('a refused change is reported as an error and saved anyway never', async () => {
  const h = harness();
  const unknownDep = await h.call('task_add', { title: 'second', depends_on: 't7' });
  assert.match(unknownDep, /^Error: No such task: t7/);
  assert.match(unknownDep, /Known ids: none yet/);
  assert.deepEqual(h.tasks(), []);
  assert.equal(h.saves(), 0);

  const noTitle = await h.call('task_add', { title: '  ' });
  assert.match(noTitle, /^Error: A task needs a title/);
  assert.equal(h.saves(), 0);
});

test('status moves are reported, and a premature finish is refused', async () => {
  const h = harness();
  await h.call('task_add', { title: 'build' });
  await h.call('task_add', { title: 'verify', depends_on: 't1' });

  const toEarly = await h.call('task_update', { id: 't2', status: 'done' });
  assert.match(toEarly, /^Error: Cannot finish "verify"/);
  assert.deepEqual(h.tasks().map((t) => t.status), ['todo', 'todo']);
  assert.equal(h.saves(), 2, 'only the two adds were saved');

  assert.equal(await h.call('task_update', { id: 't1', status: 'doing' }), 't1 is now doing: build');
  assert.equal((await h.call('task_update', { id: 't1', status: 'done' })), 't1 is now done: build');
  assert.equal(await h.call('task_update', { id: 't2', status: 'done' }), 't2 is now done: verify');
  assert.deepEqual(h.tasks().map((t) => t.status), ['done', 'done']);
  assert.equal(h.saves(), 5);
});

test('an unknown id or status is answered with what is available', async () => {
  const h = harness();
  await h.call('task_add', { title: 'only' });
  assert.match(await h.call('task_update', { id: 't4', status: 'done' }), /^Error: No task "t4". Known ids: t1\./);
  assert.match(await h.call('task_update', { id: 't1', status: 'shipped' }), /^Error: Status must be one of/);
  assert.deepEqual(h.tasks().map((t) => t.status), ['todo']);
  assert.equal(h.saves(), 1);
});

test('an unknown task tool is an error, not a silent success', async () => {
  assert.equal(await harness().call('task_delete', { id: 't1' }), 'Error: unknown tool task_delete');
});

test('a graph already holding work is extended, not restarted', async () => {
  let graph = addTask(newTaskGraph(), { title: 'earlier work' }).graph;
  graph = setTaskStatus(graph, 't1', 'done').graph;
  const h = harness({ graph });
  const reply = await h.call('task_add', { title: 'next' });
  assert.equal(reply, 'Added t2: next. 2 task(s) on the list.');
  assert.deepEqual(h.tasks().map((t) => t.id + ':' + t.status), ['t1:done', 't2:todo']);
});
