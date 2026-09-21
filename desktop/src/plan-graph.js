// A build plan, as a canvas instead of a list.
//
// The engine owns the plan. It emits steps in order and the app watches them,
// so this module invents no dependencies it cannot see: what it does is lay the
// ordered steps out as a readable graph -- a column-wise snake of nodes, each
// step joined to the next -- and give every node the status the plan actually
// reported. Position is presentation; the engine's order stays the truth. That
// is why dragging a node rearranges the picture and can never reorder the plan.
//
// Keeping the arithmetic here rather than in the component is the same choice
// the radial menu made: the layout is a rule, so it is worth testing without a
// browser, and both the canvas and the tests read one implementation.
//
// UMD like the repo's other shared modules: node gets module.exports, the
// bundled app gets the global.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UPlanGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var NODE_W = 212;
  var NODE_H = 62;
  var GAP_X = 26;
  var GAP_Y = 20;
  var PAD = 18;
  /** A canvas is an overview; a plan longer than this is read in the list. */
  var MAX_NODES = 60;

  // The engine's step phases and the workspace's session statuses are two
  // vocabularies for the same three states, and a step can arrive wearing
  // either. One table, so a node never falls back to "pending" because it was
  // spelled "started".
  var STATUS = {
    running: 'running',
    started: 'running',
    pending: 'pending',
    queued: 'pending',
    waiting: 'pending',
    done: 'done',
    ok: 'done',
    complete: 'done',
    completed: 'done',
    failed: 'failed',
    error: 'failed',
    cancelled: 'failed',
    expired: 'failed',
    skipped: 'skipped',
  };

  /** The status a step is really in, from whichever word it was given. */
  function statusOf(phase) {
    var key = String(phase == null ? '' : phase).toLowerCase();
    return STATUS[key] || 'pending';
  }

  /** How many nodes fit across a width. Always at least one: a narrow window
   *  scrolls, it does not divide by nothing. */
  function perRow(width) {
    var usable = Math.max(0, Number(width) || 0) - PAD * 2 + GAP_X;
    return Math.max(1, Math.floor(usable / (NODE_W + GAP_X)));
  }

  /** Where one node's box sits, in the snake. */
  function box(index, columns) {
    var row = Math.floor(index / columns);
    var within = index % columns;
    // Odd rows run right to left, so the last node of a row is directly above
    // the first of the next one and the connector between them is a short
    // straight drop instead of a diagonal across the canvas.
    var column = row % 2 === 1 ? columns - 1 - within : within;
    return {
      row: row,
      column: column,
      x: PAD + column * (NODE_W + GAP_X),
      y: PAD + row * (NODE_H + GAP_Y),
    };
  }

  /** The line from one node to the next, as an SVG path. */
  function edgePath(from, to) {
    var fromMidY = round(from.y + from.h / 2);
    var toMidY = round(to.y + to.h / 2);
    if (from.row === to.row) {
      // Side by side: leave one box and enter the next on facing edges.
      var rightward = to.x > from.x;
      var x1 = rightward ? from.x + from.w : from.x;
      var x2 = rightward ? to.x : to.x + to.w;
      var bend = Math.max(12, round(Math.abs(x2 - x1) / 2));
      var c1 = rightward ? x1 + bend : x1 - bend;
      var c2 = rightward ? x2 - bend : x2 + bend;
      return (
        'M ' + round(x1) + ' ' + fromMidY +
        ' C ' + c1 + ' ' + fromMidY + ', ' + c2 + ' ' + toMidY + ', ' + round(x2) + ' ' + toMidY
      );
    }
    // A new row: drop out of the bottom of one box and into the top of the next.
    var fromMidX = round(from.x + from.w / 2);
    var toMidX = round(to.x + to.w / 2);
    var y1 = from.y + from.h;
    var y2 = to.y;
    var bendY = Math.max(10, round((y2 - y1) / 2));
    return (
      'M ' + fromMidX + ' ' + round(y1) +
      ' C ' + fromMidX + ' ' + (y1 + bendY) + ', ' + toMidX + ' ' + (y2 - bendY) + ', ' + toMidX + ' ' + round(y2)
    );
  }

  function round(value) {
    return Math.round(Number(value) || 0);
  }

  function text(value) {
    return value == null ? '' : String(value);
  }

  /**
   * layout(steps, { width, max })
   *
   * Returns the nodes, the edges between them, the canvas they need, and how
   * far the plan has got. `hidden` is the count a capped canvas left to the
   * list, so the header can say so instead of quietly dropping steps.
   */
  function layout(steps, opts) {
    var options = opts || {};
    var list = Array.isArray(steps) ? steps : [];
    var width = Math.max(NODE_W + PAD * 2, Number(options.width) || 720);
    var max = Number(options.max) > 0 ? Math.floor(Number(options.max)) : MAX_NODES;
    var shown = list.slice(0, max);
    var columns = perRow(width);
    var rows = Math.max(1, Math.ceil(shown.length / columns));

    var nodes = [];
    var progress = { total: shown.length, done: 0, running: 0, failed: 0, pending: 0, skipped: 0 };
    for (var i = 0; i < shown.length; i += 1) {
      var step = shown[i] || {};
      var at = box(i, columns);
      var status = statusOf(step.phase != null ? step.phase : step.status);
      if (progress[status] != null) progress[status] += 1;
      nodes.push({
        key: text(step.id) + ':' + i,
        id: text(step.id),
        index: i,
        title: text(step.title) || 'step ' + (i + 1),
        detail: text(step.text),
        status: status,
        exitCode: typeof step.exitCode === 'number' ? step.exitCode : null,
        row: at.row,
        column: at.column,
        x: at.x,
        y: at.y,
        w: NODE_W,
        h: NODE_H,
      });
    }

    var edges = [];
    for (var e = 1; e < nodes.length; e += 1) {
      edges.push({
        key: nodes[e - 1].key + '>' + nodes[e].key,
        from: nodes[e - 1].key,
        to: nodes[e].key,
        d: edgePath(nodes[e - 1], nodes[e]),
      });
    }

    return {
      nodes: nodes,
      edges: edges,
      columns: columns,
      rows: rows,
      width: width,
      height: PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y,
      hidden: Math.max(0, list.length - shown.length),
      truncated: list.length > shown.length,
      progress: progress,
    };
  }

  /**
   * place(x, y, width, height)
   *
   * A dragged node stays on the canvas. The pointer handling lives in the
   * component; this is the rule it obeys, so the clamping can be tested.
   */
  function place(x, y, width, height) {
    var maxX = Math.max(0, (Number(width) || 0) - NODE_W);
    var maxY = Math.max(0, (Number(height) || 0) - NODE_H);
    return {
      x: Math.min(maxX, Math.max(0, round(x))),
      y: Math.min(maxY, Math.max(0, round(y))),
    };
  }

  /** Nudge a node by a drag delta, clamped to the canvas. */
  function nudge(node, dx, dy, width, height) {
    if (!node) return { x: 0, y: 0 };
    return place(node.x + (Number(dx) || 0), node.y + (Number(dy) || 0), width, height);
  }

  return {
    layout: layout,
    place: place,
    nudge: nudge,
    statusOf: statusOf,
    perRow: perRow,
    NODE_W: NODE_W,
    NODE_H: NODE_H,
    GAP_X: GAP_X,
    GAP_Y: GAP_Y,
    PAD: PAD,
    MAX_NODES: MAX_NODES,
  };
});
