const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TASK_TOOLS,
  TASK_TOOL_NAMES,
  TASK_STATUSES,
  isTaskTool,
  isTaskWriteTool,
  newTaskGraph,
  normalizeTaskGraph,
  addTask,
  setTaskStatus,
  readyTasks,
  renderTaskGraphText,
  renderTaskGraphPrompt,
  isConcurrentSafeTool,
  planToolCalls,
  describeToolCall,
  MAX_TASKS,
} = require('../chatlib.js');

// Adds a task and returns the new graph, failing loudly if the model's call
// would have been refused.
function added(graph, input) {
  const result = addTask(graph, input);
  assert.equal(result.error, undefined, `addTask refused: ${result.error}`);
  return result;
}

test('the task tools are well-formed specs with unique names', () => {
  assert.deepEqual(TASK_TOOL_NAMES, ['task_list', 'task_add', 'task_update']);
  for (const tool of TASK_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.ok(tool.function.description.length > 40, `${tool.function.name} needs a real description`);
    assert.equal(tool.function.parameters.type, 'object');
    for (const required of tool.function.parameters.required) {
      assert.ok(required in tool.function.parameters.properties, `${tool.function.name} requires undefined "${required}"`);
    }
  }
  // The status enum is offered to the model, so it must match what we accept.
  assert.deepEqual(TASK_TOOLS[2].function.parameters.properties.status.enum, TASK_STATUSES);
  assert.ok(isTaskTool('task_update'));
  assert.ok(!isTaskTool('task_delete'));
  assert.ok(isTaskWriteTool('task_add'));
  assert.ok(isTaskWriteTool('task_update'));
  assert.ok(!isTaskWriteTool('task_list'));
});

test('ids are handed out in order and never reused', () => {
  let graph = newTaskGraph();
  graph = added(graph, { title: 'first' }).graph;
  graph = added(graph, { title: 'second' }).graph;
  assert.deepEqual(graph.tasks.map((t) => t.id), ['t1', 't2']);
  // With the saved nextId intact, deleting the newest task does not let its id
  // be handed out again -- a reference the model already made must not come to
  // mean a different piece of work.
  const afterDelete = normalizeTaskGraph({ tasks: graph.tasks.slice(0, 1), nextId: graph.nextId });
  assert.equal(afterDelete.nextId, 3);
  assert.equal(added(afterDelete, { title: 'third' }).task.id, 't3');
  // Without it -- an older stored shape -- the next unused number is safe.
  assert.equal(added(normalizeTaskGraph({ tasks: graph.tasks.slice(0, 1) }), { title: 'x' }).task.id, 't2');
});

test('a task needs a title', () => {
  assert.match(addTask(newTaskGraph(), {}).error, /needs a title/);
  assert.match(addTask(newTaskGraph(), { title: '   ' }).error, /needs a title/);
  // A long title is truncated rather than refused: the model's request is
  // otherwise fine, and a refusal here would just cost another round trip.
  const long = added(newTaskGraph(), { title: 'x'.repeat(200) });
  assert.equal(long.task.title.length, 120);
});

test('a dependency must name a task that already exists', () => {
  const graph = added(newTaskGraph(), { title: 'first' }).graph;
  const missing = addTask(graph, { title: 'second', depends_on: 't7' });
  assert.match(missing.error, /No such task: t7/);
  assert.match(missing.error, /Known ids: t1/);
  // A task cannot wait on a task that does not exist yet, which is also why a
  // cycle cannot be expressed: the id it would need has not been handed out.
  assert.match(addTask(newTaskGraph(), { title: 'first', depends_on: 't1' }).error, /No such task/);
  // Both spellings are accepted, since models reliably send either.
  assert.deepEqual(added(graph, { title: 'second', depends_on: 't1' }).task.dependsOn, ['t1']);
  assert.deepEqual(added(graph, { title: 'third', dependsOn: ['t1', 't1'] }).task.dependsOn, ['t1']);
});

test('finishing something that still waits on open work is refused', () => {
  let graph = added(newTaskGraph(), { title: 'build the thing' }).graph;
  graph = added(graph, { title: 'verify it', depends_on: 't1' }).graph;

  const tooEarly = setTaskStatus(graph, 't2', 'done');
  assert.match(tooEarly.error, /Cannot finish "verify it" while it still depends on t1/);
  // The refusal returns no graph at all, so a caller cannot save a half change.
  assert.equal(tooEarly.graph, undefined);

  graph = setTaskStatus(graph, 't1', 'done').graph;
  const now = setTaskStatus(graph, 't2', 'done');
  assert.equal(now.error, undefined);
  assert.equal(now.task.status, 'done');
  assert.deepEqual(now.graph.tasks.map((t) => t.status), ['done', 'done']);
});

test('an unknown id or status is explained rather than silently ignored', () => {
  const graph = added(newTaskGraph(), { title: 'only' }).graph;
  const unknown = setTaskStatus(graph, 't9', 'done');
  assert.match(unknown.error, /No task "t9"/);
  assert.match(unknown.error, /Known ids: t1/);
  const bad = setTaskStatus(graph, 't1', 'finished');
  assert.match(bad.error, /Status must be one of: todo, doing, done, blocked/);
  // Nothing moved.
  assert.equal(graph.tasks[0].status, 'todo');
});

test('blocked is a deliberate park, not a ready task', () => {
  let graph = added(newTaskGraph(), { title: 'waiting on a decision' }).graph;
  graph = setTaskStatus(graph, 't1', 'blocked').graph;
  assert.deepEqual(readyTasks(graph).map((t) => t.id), []);
  graph = added(graph, { title: 'free to start' }).graph;
  assert.deepEqual(readyTasks(graph).map((t) => t.id), ['t2']);
});

test('ready work is what can start now, in list order', () => {
  let graph = added(newTaskGraph(), { title: 'one' }).graph;
  graph = added(graph, { title: 'two', depends_on: 't1' }).graph;
  graph = added(graph, { title: 'three' }).graph;
  // t2 cannot start until t1 is done; t3 has no dependencies at all.
  assert.deepEqual(readyTasks(graph).map((t) => t.id), ['t1', 't3']);
  graph = setTaskStatus(graph, 't2', 'doing').graph;
  assert.deepEqual(readyTasks(graph).map((t) => t.id), ['t1', 't3'], 'starting early does not make it ready');
});

test('a stored graph is repaired rather than trusted', () => {
  const repaired = normalizeTaskGraph({
    tasks: [
      null,
      'nonsense',
      { title: '' },
      { id: 't2', title: 'keeps its id', status: 'done', dependsOn: ['t1', 't99', 't2'] },
      { id: 't2', title: 'duplicate id', status: 'nope' },
      { title: 'long', detail: 'x'.repeat(5000), status: 'doing' },
    ],
  });
  assert.deepEqual(repaired.tasks.map((t) => t.id), ['t2', 't3', 't4']);
  // A dependency on a missing task, and on itself, are both dropped: either
  // would leave a task that can never be marked finished.
  assert.deepEqual(repaired.tasks[0].dependsOn, [], 't1 and t2 do not exist as separate tasks here');
  assert.equal(repaired.tasks[1].status, 'todo', 'an unknown status becomes todo');
  assert.equal(repaired.tasks[2].detail.length, 600);
  assert.equal(repaired.nextId, 5, 'past the highest id in use');
  // Junk in means an empty graph out, never a crash.
  for (const junk of [null, undefined, 42, [], { tasks: 'no' }, 'text']) {
    assert.deepEqual(normalizeTaskGraph(junk).tasks, []);
  }
});

test('the list is capped so one runaway turn cannot fill storage', () => {
  let graph = newTaskGraph();
  for (let i = 0; i < MAX_TASKS; i++) graph = added(graph, { title: 'task ' + i }).graph;
  assert.match(addTask(graph, { title: 'one more' }).error, new RegExp('already holds ' + MAX_TASKS));
});

test('an empty list adds nothing to the prompt but still answers task_list', () => {
  assert.equal(renderTaskGraphPrompt(newTaskGraph()), '');
  assert.equal(renderTaskGraphText(newTaskGraph()), 'The task list is empty.');
});

test('the prompt shows status, id, title, dependency and detail', () => {
  let graph = added(newTaskGraph(), { title: 'first', detail: 'the file is chatlib.js' }).graph;
  graph = added(graph, { title: 'second', depends_on: 't1' }).graph;
  graph = setTaskStatus(graph, 't1', 'doing').graph;
  const prompt = renderTaskGraphPrompt(graph);
  assert.match(prompt, /TASK LIST — kept in this browser/);
  assert.ok(prompt.includes('- [doing] t1 first -- the file is chatlib.js'));
  assert.ok(prompt.includes('- [todo] t2 second (after t1)'));
  // task_list shows the same rows without the preamble.
  assert.equal(renderTaskGraphText(graph), prompt.split('\n').slice(1).join('\n'));
});

test('task writers stay serial while the reading tool may overlap', () => {
  assert.ok(isConcurrentSafeTool('task_list'));
  assert.ok(!isConcurrentSafeTool('task_add'));
  assert.ok(!isConcurrentSafeTool('task_update'));
  const plan = planToolCalls([
    { function: { name: 'task_list' } },
    { function: { name: 'task_add' } },
    { function: { name: 'task_update' } },
  ]);
  assert.deepEqual(plan.concurrent, [0]);
  assert.deepEqual(plan.serial, [1, 2]);
});

test('a task step names what it is doing', () => {
  assert.equal(describeToolCall('task_list', {}), 'Reading the task list');
  assert.equal(describeToolCall('task_add', { title: 'Ship it' }), 'Adding a task: "Ship it"');
  assert.equal(describeToolCall('task_update', { id: 't2', status: 'done' }), 'Marking t2 as done');
});
