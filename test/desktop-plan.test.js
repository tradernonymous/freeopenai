// The plan canvas: the layout rule, and the wiring that keeps it honest.
//
// The layout is arithmetic, so it is tested without a browser. The wiring is
// not: what these tests can do is refuse the two ways a canvas quietly becomes
// a lie -- a node key the list does not use, and a status vocabulary that
// leaves the running step looking like every other one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const graph = require('../desktop/src/plan-graph.js');
const root = (...parts) => path.join(__dirname, '..', ...parts);

const read = (file) => fs.readFileSync(root(file), 'utf8');

const stepsOf = (count, phase = 'pending') =>
  Array.from({ length: count }, (_, i) => ({ id: `s${i}`, title: `Step ${i + 1}`, phase }));

test('a plan shorter than a row is one straight line', () => {
  const plan = graph.layout(stepsOf(3), { width: 1000 });
  assert.equal(plan.rows, 1);
  assert.equal(plan.columns >= 3, true);
  // Left to right, all at the same height, in the engine's order.
  const xs = plan.nodes.map((n) => n.x);
  assert.deepEqual(xs, xs.slice().sort((a, b) => a - b));
  assert.equal(new Set(plan.nodes.map((n) => n.y)).size, 1);
  assert.equal(plan.edges.length, 2);
});

test('a long plan snakes, so consecutive steps stay neighbours', () => {
  const plan = graph.layout(stepsOf(9), { width: 520 });
  assert.ok(plan.columns >= 2 && plan.columns < 9, `columns=${plan.columns}`);
  assert.ok(plan.rows > 1);
  // Every edge joins steps that are one column and one row apart at most: the
  // whole point of the snake is that no connector crosses the canvas.
  for (const edge of plan.edges) {
    const from = plan.nodes.find((n) => n.key === edge.from);
    const to = plan.nodes.find((n) => n.key === edge.to);
    assert.equal(Math.abs(to.index - from.index), 1);
    if (to.row === from.row) assert.equal(Math.abs(to.column - from.column), 1);
    else assert.equal(to.column, from.column);
  }
});

test('the snake reverses on every other row', () => {
  const plan = graph.layout(stepsOf(8), { width: 520 });
  const row0 = plan.nodes.filter((n) => n.row === 0).map((n) => n.column);
  const row1 = plan.nodes.filter((n) => n.row === 1).map((n) => n.column);
  assert.deepEqual(row0, row0.slice().sort((a, b) => a - b), 'first row runs right');
  assert.deepEqual(row1, row1.slice().sort((a, b) => b - a), 'second row runs back');
});

test('steps wear either vocabulary and read as three states', () => {
  assert.equal(graph.statusOf('started'), 'running');
  assert.equal(graph.statusOf('running'), 'running');
  assert.equal(graph.statusOf('done'), 'done');
  assert.equal(graph.statusOf('completed'), 'done');
  assert.equal(graph.statusOf('failed'), 'failed');
  assert.equal(graph.statusOf('EXPIRED'), 'failed');
  assert.equal(graph.statusOf('pending'), 'pending');
  assert.equal(graph.statusOf(undefined), 'pending');
  assert.equal(graph.statusOf('something-new'), 'pending');
});

test('a node carries the status of the step it stands for', () => {
  const plan = graph.layout(
    [
      { id: 'a', title: 'plan', phase: 'done' },
      { id: 'b', title: 'edit', phase: 'started' },
      { id: 'c', title: 'test', phase: 'pending' },
    ],
    { width: 900 },
  );
  assert.deepEqual(plan.nodes.map((n) => n.status), ['done', 'running', 'pending']);
  assert.equal(plan.progress.done, 1);
  assert.equal(plan.progress.running, 1);
  assert.equal(plan.progress.total, 3);
});

test('the count is of steps, and the cap never hides the number', () => {
  const plan = graph.layout(stepsOf(80), { width: 900, max: 10 });
  assert.equal(plan.nodes.length, 10);
  assert.equal(plan.truncated, true);
  assert.equal(plan.hidden, 70);
  assert.equal(plan.progress.total, 10, 'the count describes what was drawn');
});

test('an empty plan draws nothing rather than a zero-width canvas', () => {
  const plan = graph.layout([], { width: 900 });
  assert.deepEqual(plan.nodes, []);
  assert.deepEqual(plan.edges, []);
  assert.ok(plan.height > 0);
  assert.equal(graph.layout(null, { width: 900 }).nodes.length, 0);
});

test('a step missing its title still gets a name', () => {
  const plan = graph.layout([{ id: 'a' }], { width: 900 });
  assert.equal(plan.nodes[0].title, 'step 1');
  assert.equal(plan.nodes[0].detail, '');
  assert.equal(plan.nodes[0].exitCode, null);
});

test('an exit code survives, and zero is not mistaken for absent', () => {
  const plan = graph.layout(
    [
      { id: 'a', title: 'ok', phase: 'done', exitCode: 0 },
      { id: 'b', title: 'bad', phase: 'failed', exitCode: 2 },
    ],
    { width: 900 },
  );
  assert.equal(plan.nodes[0].exitCode, 0);
  assert.equal(plan.nodes[1].exitCode, 2);
});

test('dragged nodes are clamped to the canvas', () => {
  assert.deepEqual(graph.place(-40, -40, 800, 400), { x: 0, y: 0 });
  const max = graph.place(9999, 9999, 800, 400);
  assert.equal(max.x, 800 - graph.NODE_W);
  assert.equal(max.y, 400 - graph.NODE_H);
});

test('a drag moves a node without moving the plan', () => {
  const plan = graph.layout(stepsOf(3), { width: 900 });
  const node = plan.nodes[1];
  const moved = graph.nudge(node, 30, 12, plan.width, plan.height);
  assert.deepEqual(moved, { x: node.x + 30, y: node.y + 12 });
  // Nudging is pure: the layout it came from is untouched, which is why the
  // engine's order cannot be edited by dragging the picture.
  assert.equal(plan.nodes[1].x, node.x);
  assert.equal(graph.nudge(null, 5, 5, 100, 100).x, 0);
});

test('the canvas argues from the same words the list uses', () => {
  const screen = read('desktop/src/screens/BuildScreen.tsx');
  const canvas = read('desktop/src/components/PlanCanvas.tsx');
  const graphSource = read('desktop/src/plan-graph.js');

  // The canvas and the list select a step by the SAME key, or clicking a node
  // scrolls nowhere. The key is built in plan-graph.js and re-derived in the
  // screen, which is exactly the kind of pair that drifts.
  assert.match(graphSource, /text\(step\.id\) \+ ':' \+ i/);
  assert.match(screen, /focusedKey === `\$\{step\.id\}:\$\{i\}`/);

  assert.match(screen, /<PlanCanvas/);
  assert.match(canvas, /FreeAI4UPlanGraph/);
  // A node whose status cannot be drawn is a node with no status: the canvas
  // must not paint a fixed class list of its own.
  assert.doesNotMatch(canvas, /'running' \?/);
  assert.match(canvas, /node\.status/);
});

test('the build screen still renders the steps as a list', () => {
  const screen = read('desktop/src/screens/BuildScreen.tsx');
  // The canvas is an overview, not a replacement: the log has to stay, because
  // step text and exit codes are read there.
  assert.match(screen, /className="build-steps"/);
  assert.match(screen, /started: 'running'/);
  // ...and the escape-first diff view is still the one approvals use.
  assert.match(screen, /dangerouslySetInnerHTML=\{\{ __html: diffHtml\(active\.pending\.preview\) \}\}/);
});
