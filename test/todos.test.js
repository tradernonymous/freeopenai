// The rules behind the todo panel and the turn contract.
//
// The panel is the visible half of the task list the model already kept in the
// system prompt, so these are the decisions it makes: what order to show the
// plan in, what "still open" means, what a click on a row does, and when the
// model is told its own plan is unfinished.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  newTaskGraph,
  addTask,
  setTaskStatus,
  orderTodos,
  todoProgress,
  toggleTodoStatus,
  renderTodoSummary,
  todoReportNudge,
  reasoningTailLine,
  describeReasoning,
  modePrompt,
} = require('../chatlib.js');

// A graph built by id, so the fixtures read as the plan they describe.
function graphOf(...tasks) {
  let graph = newTaskGraph();
  for (const task of tasks) {
    const added = addTask(graph, { title: task.title, detail: task.detail, depends_on: task.after });
    assert.equal(added.error, undefined, added.error);
    graph = added.graph;
    if (task.status) graph = setTaskStatus(graph, added.task.id, task.status).graph;
  }
  return graph;
}

test('the panel shows the work, not the order things were added', () => {
  // t1 is finished and t3 has not started, but t2 is what is happening now --
  // and a plan you are reading mid-task has to lead with that.
  const graph = graphOf(
    { title: 'Set up the branch', status: 'done' },
    { title: 'Write the panel', status: 'doing' },
    { title: 'Test it on a phone' },
    { title: 'Waiting on a decision', status: 'blocked' }
  );
  assert.deepEqual(orderTodos(graph).map((t) => t.id + ':' + t.status), [
    't2:doing',
    't3:todo',
    't4:blocked',
    't1:done',
  ]);
  // The stored list is not reordered -- only the view is.
  assert.deepEqual(graph.tasks.map((t) => t.id), ['t1', 't2', 't3', 't4']);
});

test('ids sort by number, so the tenth task comes after the ninth', () => {
  let graph = newTaskGraph();
  for (let i = 1; i <= 11; i++) graph = addTask(graph, { title: 'task ' + i }).graph;
  const ids = orderTodos(graph).map((t) => t.id);
  assert.deepEqual(ids.slice(8), ['t9', 't10', 't11']);
});

test('progress counts what is finished and what is still open', () => {
  const empty = todoProgress(newTaskGraph());
  assert.deepEqual(empty, { total: 0, done: 0, doing: 0, todo: 0, blocked: 0, open: 0 });
  const graph = graphOf(
    { title: 'one', status: 'done' },
    { title: 'two', status: 'doing' },
    { title: 'three' },
    { title: 'four', status: 'blocked' }
  );
  assert.deepEqual(todoProgress(graph), { total: 4, done: 1, doing: 1, todo: 1, blocked: 1, open: 3 });
  assert.equal(renderTodoSummary(newTaskGraph()), '', 'nothing to say about an empty list');
  assert.equal(renderTodoSummary(graph), '1 of 4 done · 1 in progress · 1 blocked');
});

test('a click completes a task, and completing it again reopens it', () => {
  // 'doing' and 'blocked' both complete: the person is the authority on their
  // own work, and a row stuck mid-flight with nothing running helps nobody.
  assert.equal(toggleTodoStatus('todo'), 'done');
  assert.equal(toggleTodoStatus('doing'), 'done');
  assert.equal(toggleTodoStatus('blocked'), 'done');
  assert.equal(toggleTodoStatus('done'), 'todo');
  assert.equal(toggleTodoStatus(undefined), 'done');
});

test('the model is told what its own plan still owes, in panel order', () => {
  const graph = graphOf(
    { title: 'Ship it', status: 'done' },
    { title: 'Write the panel', status: 'doing' },
    { title: 'Test it' }
  );
  const nudge = todoReportNudge(graph, { touched: true });
  assert.match(nudge, /^TODO LIST — 2 of 3 still open:/);
  assert.match(nudge, /- \[doing\] t2 Write the panel/);
  assert.match(nudge, /- \[todo\] t3 Test it/);
  assert.ok(!nudge.includes('t1 Ship it'), 'a finished task is not listed as owed');
  assert.match(nudge, /Do not report the work as complete while they are open/);
});

test('the nudge only fires for a turn that was working from the list', () => {
  const graph = graphOf({ title: 'Still open' });
  // A turn that never wrote to the list is not working from it, and the list is
  // carried between conversations -- so an old task must not interrupt an
  // unrelated answer.
  assert.equal(todoReportNudge(graph, { touched: false }), '');
  assert.equal(todoReportNudge(graph), '', 'untouched by default');
  // Nothing open: nothing to say.
  const finished = graphOf({ title: 'Done', status: 'done' });
  assert.equal(todoReportNudge(finished, { touched: true }), '');
  assert.equal(todoReportNudge(newTaskGraph(), { touched: true }), '');
  assert.equal(todoReportNudge(null, { touched: true }), '');
});

test('mode prompts carry the todo contract, which is what makes the list live', () => {
  // The contract is in the mode prompt rather than in each request on purpose:
  // that text never changes between turns, so it cannot invalidate a cacheable
  // prefix (#89), and it is the plan-of-record instruction the panel depends on.
  const build = modePrompt('build');
  assert.match(build, /todo list/i);
  assert.match(build, /revise the list/i);
  assert.match(build, /Finish every todo before you report/);
  assert.match(modePrompt('plan'), /Record the plan .* as tasks/);
});

test('the live reasoning view shows the end of the thought, on one line', () => {
  assert.equal(reasoningTailLine('short thought'), 'short thought');
  assert.equal(reasoningTailLine('  spaced\n\nout   text  '), 'spaced out text');
  assert.equal(reasoningTailLine(''), '');
  assert.equal(reasoningTailLine(null), '');
  const long = 'x'.repeat(400) + 'the end of it';
  const tail = reasoningTailLine(long, 40);
  assert.ok(tail.startsWith('\u2026'), 'trimmed at the front, not the back: ' + tail);
  assert.ok(tail.endsWith('the end of it'), 'and keeps the newest words');
  assert.equal(tail.length, 41);
});

test('a finished scratchpad is summarised by size, and by time only if it was timed', () => {
  // Restored from storage on a later day there is no start time, so claiming a
  // duration would be inventing one.
  assert.equal(describeReasoning('abc'), 'Thought · 3 chars');
  assert.equal(describeReasoning(''), 'Thought · 0 chars');
  assert.equal(describeReasoning('x'.repeat(1200)), 'Thought · 1.2k chars');
  assert.equal(describeReasoning('hello there', { startedAt: 1000, now: 4200 }), 'Thought for 3.2s · 11 chars');
  // A clock that went backwards is not a negative duration.
  assert.equal(describeReasoning('hi', { startedAt: 5000, now: 1000 }), 'Thought · 2 chars');
  // Under half a second is not worth a decimal.
  assert.equal(describeReasoning('hi', { startedAt: 1000, now: 1100 }), 'Thought · 2 chars');
});
