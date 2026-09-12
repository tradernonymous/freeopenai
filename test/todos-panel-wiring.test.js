// The todo panel as shipped, run against a small DOM stub.
//
// The rules are unit-tested in todos.test.js; this file is about the wiring --
// that the page actually draws the list in the panel, that a click goes through
// the same status rule the model's tool uses, and that the panel is reachable on
// a phone. A render function nothing calls, or a class nothing toggles, is a
// feature that looks finished in a diff and is not there at runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  newTaskGraph,
  normalizeTaskGraph,
  addTask,
  setTaskStatus,
  orderTodos,
  todoProgress,
  toggleTodoStatus,
  renderTodoSummary,
  describeReasoning,
  reasoningTailLine,
} = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const NAMES = [
  'renderTaskList',
  'toggleTodos',
  'restoreTodosVisibility',
  'uiSetTaskStatus',
  'deleteTask',
  'todoMark',
  'setReasoningContent',
  'setReasoningStrip',
];

// Enough of an element for the renderer: children, class names, attributes and
// the two text properties it writes to.
function stubEl(tag = 'div') {
  const node = {
    tagName: tag,
    children: [],
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    style: {},
    attrs: {},
    onclick: null,
    type: '',
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    append(...kids) { kids.forEach((kid) => { kid.parent = this; this.children.push(kid); }); },
    appendChild(kid) { kid.parent = this; this.children.push(kid); return kid; },
    insertBefore(kid, ref) {
      kid.parent = this;
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at >= 0) this.children.splice(at, 0, kid);
      else this.children.unshift(kid);
      return kid;
    },
    // Detach for real: the renderers replace the live strip with the folded
    // scratchpad by removing it, and a stub that only set a flag would leave it
    // in the child list and make the removal look like it never happened.
    remove() {
      this.removed = true;
      if (!this.parent) return;
      const at = this.parent.children.indexOf(this);
      if (at >= 0) this.parent.children.splice(at, 1);
    },
    // Descendant lookup by class or tag -- all the renderers ask for.
    querySelector(selector) {
      const want = String(selector).replace(/^\./, '');
      const walk = (list) => {
        for (const child of list) {
          if (child.className && String(child.className).split(/\s+/).includes(want)) return child;
          if (child.tagName === want) return child;
          const found = walk(child.children || []);
          if (found) return found;
        }
        return null;
      };
      return walk(node.children);
    },
  };
  // The renderer clears by assigning innerHTML = ''. On a stub that has to
  // actually drop the children, or the second render just adds a second copy
  // and every assertion reads the first one.
  Object.defineProperty(node, 'innerHTML', {
    get() { return ''; },
    set(value) { if (!value) node.children.length = 0; },
  });
  return node;
}

function stubDocument(ids = {}) {
  const byId = new Map(Object.entries(ids));
  return {
    els: byId,
    createElement: (tag) => stubEl(tag),
    getElementById: (name) => {
      if (!byId.has(name)) byId.set(name, stubEl());
      return byId.get(name);
    },
    querySelector: () => null,
  };
}

// classList over a className string, which is all the toggle needs.
function stubShell(hidden = false) {
  const classes = new Set(hidden ? ['todos-hidden'] : []);
  return {
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return on; },
      classes,
    },
  };
}

function harness({ graph = newTaskGraph(), stored = null, narrow = false, shell = null } = {}) {
  const document = stubDocument();
  const saved = [];
  const statuses = [];
  const store = { value: stored };
  const deps = {
    // The real rules, not stubs: this exercises the shipped pairing.
    orderTodos,
    todoProgress,
    renderTodoSummary,
    toggleTodoStatus,
    setTaskStatus,
    normalizeTaskGraph,
    newTaskGraph,
    describeReasoning,
    reasoningTailLine,
    taskGraph: graph,
    document,
    localStorage: {
      getItem: () => store.value,
      setItem: (k, v) => { store.value = v; },
    },
    TODOS_HIDDEN_KEY: 'freeopenaiTodosHidden',
    isNarrowScreen: () => narrow,
    saveTaskGraph: () => saved.push(JSON.parse(JSON.stringify(deps.taskGraph))),
    showStatus: (kind, text) => statuses.push(kind + ': ' + text),
    shell: shell || stubShell(),
  };
  // The shell lookup is the one querySelector the toggle makes.
  document.querySelector = (sel) => (sel === '#viewChat .chat-shell' ? deps.shell : null);
  const loaded = loadFromIndex(NAMES, deps);
  return { deps, document, saved, statuses, store, loaded };
}

const rows = (document) => document.getElementById('todoList').children;

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('the panel is drawn where it lives, in the order the work happens', () => {
  let graph = addTask(newTaskGraph(), { title: 'Set up the branch' }).graph;
  graph = addTask(graph, { title: 'Write the panel', detail: 'Rows, ticks, and a count.' }).graph;
  graph = addTask(graph, { title: 'Test it on a phone' }).graph;
  graph = setTaskStatus(graph, 't1', 'done').graph;
  graph = setTaskStatus(graph, 't2', 'doing').graph;

  const h = harness({ graph });
  h.loaded.renderTaskList();

  const drawn = rows(h.document);
  assert.equal(drawn.length, 3, 'one row per task');
  // Doing first, then what is next, then what is finished.
  assert.deepEqual(drawn.map((row) => row.dataset.id), ['t2', 't3', 't1']);
  assert.match(drawn[0].className, /doing/);
  assert.match(drawn[2].className, /done/);
  // The row carries the model's own marking of the status.
  assert.equal(drawn[2].children[0].textContent, '✓');
  assert.equal(drawn[0].children[0].textContent, '◐');
  // Title and detail both reach the page as text, never as markup.
  assert.equal(drawn[0].children[1].children[0].textContent, 'Write the panel');
  assert.match(drawn[0].children[1].children[2].textContent, /Rows, ticks, and a count\./);
  // Header count and the progress bar agree with the list.
  assert.equal(h.document.getElementById('todoCount').textContent, '1/3');
  assert.equal(h.document.getElementById('todoProgressFill').style.width, (1 / 3) * 100 + '%');
  assert.equal(h.document.getElementById('todoProgress').getAttribute('aria-valuenow'), '1');
  assert.equal(h.document.getElementById('todoProgress').getAttribute('aria-valuemax'), '3');
  // A badge for open work, so the panel can be closed and still say something.
  assert.notEqual(h.document.getElementById('todoBadge').style.display, 'none');
});

test('an empty list explains itself rather than rendering nothing', () => {
  const h = harness();
  h.loaded.renderTaskList();
  const drawn = rows(h.document);
  assert.equal(drawn.length, 1);
  assert.match(drawn[0].textContent, /No todos yet/);
  assert.equal(h.document.getElementById('todoCount').textContent, 'empty');
  assert.equal(h.document.getElementById('todoProgressFill').style.width, '0%');
  assert.equal(h.document.getElementById('todoBadge').style.display, 'none', 'nothing open, no badge');
});

test('ticking a row goes through the same rule the model\u2019s tool uses', () => {
  const graph = addTask(newTaskGraph(), { title: 'Only one' }).graph;
  const h = harness({ graph });
  h.loaded.renderTaskList();
  const check = rows(h.document)[0].children[0];

  check.onclick();
  assert.equal(h.deps.taskGraph.tasks[0].status, 'done');
  assert.equal(h.saved.length, 1, 'and it is saved');

  // The next render shows it finished, and clicking again reopens it.
  h.loaded.renderTaskList();
  assert.equal(rows(h.document)[0].children[0].textContent, '✓');
  rows(h.document)[0].children[0].onclick();
  assert.equal(h.deps.taskGraph.tasks[0].status, 'todo');
});

test('a task that is not ready yet cannot be ticked off from the panel either', () => {
  // The model's task_update refuses this, and the panel ticking past it would
  // show a finished plan that is not.
  let graph = addTask(newTaskGraph(), { title: 'Build it' }).graph;
  graph = addTask(graph, { title: 'Verify it', depends_on: 't1' }).graph;
  const h = harness({ graph });
  // Force the row's own handler to ask for done on the dependent task.
  const refused = h.loaded.uiSetTaskStatus('t2', 'done');
  assert.equal(refused, false);
  assert.equal(h.deps.taskGraph.tasks[1].status, 'todo');
  assert.deepEqual(h.saved, [], 'a refused change saves nothing');
  assert.match(h.statuses[0], /^error: Cannot finish/);
  // And the same call on the task it depends on is allowed.
  assert.equal(h.loaded.uiSetTaskStatus('t1', 'done'), true);
  assert.equal(h.deps.taskGraph.tasks[0].status, 'done');
});

test('the panel opens and closes, and the choice sticks', () => {
  const shell = stubShell(false);
  const h = harness({ shell });
  h.loaded.toggleTodos(false);
  assert.ok(shell.classList.contains('todos-hidden'));
  assert.equal(h.document.getElementById('todoToggle').getAttribute('aria-pressed'), 'false');
  assert.equal(h.store.value, '1', 'closed is remembered');
  h.loaded.toggleTodos();
  assert.ok(!shell.classList.contains('todos-hidden'));
  assert.equal(h.store.value, '', 'and so is open');
});

test('a phone starts with the panel out of the way, and a stored choice wins', () => {
  const narrowShell = stubShell(false);
  const narrow = harness({ shell: narrowShell, narrow: true, stored: null });
  narrow.loaded.restoreTodosVisibility();
  assert.ok(narrowShell.classList.contains('todos-hidden'), 'closed by default on a phone');

  const wideShell = stubShell(false);
  const wide = harness({ shell: wideShell, narrow: false });
  wide.loaded.restoreTodosVisibility();
  assert.ok(!wideShell.classList.contains('todos-hidden'), 'open by default on a laptop');

  // Once chosen, honoured everywhere: overriding it was why the history
  // sidebar's setting never appeared to stick on mobile.
  const chosenShell = stubShell(true);
  const chosen = harness({ shell: chosenShell, narrow: false, stored: '1' });
  chosen.loaded.restoreTodosVisibility();
  assert.ok(chosenShell.classList.contains('todos-hidden'), 'a stored "closed" survives a wide screen');
});

test('the reasoning scratchpad is one moving line while it streams, then a summary', () => {
  const document = stubDocument();
  const deps = { document, describeReasoning, reasoningTailLine, Date, reasoningVisible: true };
  const { setReasoningStrip, setReasoningContent } = loadFromIndex(
    ['setReasoningStrip', 'setReasoningContent'],
    deps
  );
  const bubble = stubEl();

  setReasoningStrip(bubble, 'First I look at the file,\nthen I check the tests.');
  const strip = bubble.children[0];
  assert.match(strip.className, /reasoning-strip/);
  assert.equal(strip.children[0].textContent, 'Thinking');
  // Flattened to one line: a live view that wraps is not a live view.
  assert.equal(strip.children[1].textContent, 'First I look at the file, then I check the tests.');
  assert.ok(bubble.dataset.reasoningStartedAt, 'the strip starts the clock');

  // The final view replaces it, so the raw stream never sits in the transcript.
  setReasoningContent(bubble, 'First I look at the file, then I check the tests.');
  assert.ok(!bubble.children.some((c) => /reasoning-strip/.test(c.className)), 'strip removed');
  const box = bubble.children.find((c) => /message-reasoning/.test(c.className));
  assert.ok(box, 'the scratchpad is kept behind a summary');
  assert.match(box.children[0].textContent, /^Thought for |^Thought · /);
  assert.equal(box.children[1].textContent, 'First I look at the file, then I check the tests.');
  assert.equal(bubble.dataset.rawReasoning, 'First I look at the file, then I check the tests.');
});

test('the panels are cards beside the chat, and drawers on a phone', () => {
  // Markup: the todo card, its count, its progress bar and its toggle all exist,
  // along with the skills card on the other side.
  for (const id of ['todoSidebar', 'todoList', 'todoCount', 'todoProgress', 'todoProgressFill', 'todoToggle', 'todoScrim', 'skillRail', 'skillRailList', 'skillRailCount', 'skillRailToggle']) {
    assert.ok(HTML.includes('id="' + id + '"'), 'index.html is missing #' + id);
  }
  // The shell carries the class each toggle flips -- a toggle for a class
  // nobody sets is a button that does nothing.
  assert.match(HTML, /class="chat-shell[^"]*"/);
  assert.match(HTML, /\.chat-shell\.todos-hidden \.todo-sidebar/);
  assert.match(HTML, /\.chat-shell\.skills-hidden \.skill-rail/);

  // The desktop shape is a floating card, not a wall of the layout: inset,
  // rounded, raised. It still takes width rather than covering the transcript,
  // because a list of the remaining work is useless if reading it hides the
  // work -- so it is a flex child and never position: absolute (which is also
  // the shape that made the attach menu open invisibly inside a scroll box).
  const todoCard = HTML.slice(HTML.indexOf('\n        .todo-sidebar {'), HTML.indexOf('.todo-head, .rail-head {'));
  assert.ok(!/position: absolute/.test(todoCard), 'the desktop card is a layout column, not an overlay');
  assert.match(todoCard, /margin: 10px 10px 10px 0/);
  assert.match(todoCard, /border-radius: var\(--r-lg\)/);
  assert.match(todoCard, /box-shadow: var\(--lift-lg\)/);
  const skillCard = HTML.slice(HTML.indexOf('.skill-rail {'), HTML.indexOf('.rail-list {'));
  assert.ok(!/position: absolute/.test(skillCard), 'the skills card follows the same shape');
  assert.match(skillCard, /margin: 10px 0 10px 10px/);

  // Both narrow layouts turn the todo card into an off-canvas drawer, from the
  // right, flush and square: at 640px and in a landscape phone there is no room
  // for a card beside anything.
  const portrait = HTML.slice(HTML.indexOf('@media (max-width: 640px)'), HTML.indexOf('@media (max-width: 380px)'));
  assert.match(portrait, /\.todo-sidebar \{[\s\S]*?position: absolute; top: 0; bottom: 0; right: 0[\s\S]*?margin: 0/);
  assert.match(portrait, /\.chat-shell\.todos-hidden \.todo-sidebar \{[\s\S]*?translateX\(102%\)/);
  const landscape = HTML.slice(HTML.indexOf('@media (max-height: 520px) and (orientation: landscape)'));
  assert.match(landscape, /\.todo-sidebar \{[\s\S]*?position: absolute; top: 0; bottom: 0; right: 0/);
  // With no room for a third column the skills card yields first: it is
  // information, and the same facts are a tap away in the picker.
  assert.match(HTML, /@media \(max-width: 1100px\) \{\s*\.skill-rail, #skillRailToggle \{ display: none; \}/);
});

test('every control in the toolbar is built from the same four values', () => {
  // The row used to be 999px pills beside 8px rectangles, 4px padding beside
  // 6px: three apps stitched together. These tokens are now the only thing that
  // decides how a control looks.
  const root = HTML.slice(HTML.indexOf(':root {'), HTML.indexOf('/* Light theme'));
  for (const token of ['--ctl-h', '--ctl-r', '--ctl-bg', '--ctl-bg-hover']) {
    assert.ok(root.includes(token + ':'), 'missing ' + token);
  }
  for (const group of ['\.effort-chip, \.mode-chip, \.skills-toggle', '\.composer-attach, \.composer-send']) {
    const block = HTML.slice(HTML.indexOf(group.replace(/\\/g, '')), HTML.indexOf('}', HTML.indexOf(group.replace(/\\/g, ''))));
    assert.match(block, /border-radius: var\(--ctl-r\)|var\(--ctl-r\)/, group + ' must use the shared radius');
  }
  // No pill shapes left in the composer row, and the attach button is a real
  // control with the same fill as the chips rather than an invisible glyph.
  const composer = HTML.slice(HTML.indexOf('.composer-attach, .composer-send'), HTML.indexOf('.composer-input {'));
  assert.ok(!/999px/.test(composer), 'the composer controls share one radius now');
  assert.match(composer, /\.composer-attach \{[^}]*background: var\(--ctl-bg\)/);
  assert.match(composer, /\.composer-attach \{[^}]*border-color: var\(--border\)/);
  // A visible keyboard focus ring on all of them, which the pills never had.
  assert.match(HTML, /\.effort-chip:focus-visible[\s\S]{0,200}box-shadow: var\(--glow\)/);
});

test('the reasoning summary can be switched off, and the setting reaches old replies', () => {
  // The checkbox is in Settings, next to the other behaviour switches.
  assert.match(HTML, /id="reasoningCheck" checked onchange="setReasoningVisible\(this\.checked\)"/);
  // Read at startup, applied at startup, and the control reflects it.
  assert.match(HTML, /let reasoningVisible = localStorage\.getItem\(REASONING_KEY\) !== '1'/);
  assert.match(HTML, /document\.getElementById\('reasoningCheck'\)\.checked = reasoningVisible/);
  // Both renderers consult it, so a reply that arrives while it is off leaves
  // no scratchpad behind...
  const strip = HTML.slice(HTML.indexOf('function setReasoningStrip'), HTML.indexOf('function setReasoningContent'));
  assert.match(strip, /!text \|\| !reasoningVisible/);
  const content = HTML.slice(HTML.indexOf('function setReasoningContent'), HTML.indexOf('// Puter streams reasoning'));
  assert.match(content, /!text \|\| !reasoningVisible/);
  // ...but the text is still recorded, so switching it on shows the reasoning of
  // replies that already happened rather than only the next one.
  assert.match(strip, /if \(text\) el\.dataset\.rawReasoning = text;/);
  assert.match(content, /if \(text\) el\.dataset\.rawReasoning = text;/);
  const toggle = HTML.slice(HTML.indexOf('function setReasoningVisible'), HTML.indexOf('// Ticking a row goes through'));
  assert.match(toggle, /querySelectorAll\('\.message\.bot'\)/);
});

test('the skills card records what applied, per conversation', () => {
  // Written on the turn, from what actually rode along -- not from what was
  // pinned, which would claim credit for skills the router never used.
  assert.match(HTML, /logSkillsUsed\(activeConversationId, activeSkills\)/);
  const log = HTML.slice(HTML.indexOf('function logSkillsUsed'), HTML.indexOf('function renderSkillRail'));
  assert.match(log, /pinned: !!skill\.pinned/);
  assert.match(log, /turns: prev\.turns \+ 1/);
  // Every path that changes which chat is open redraws it, from one place.
  assert.match(HTML, /renderSkillBar\(\);[\s\S]{0,320}renderSkillRail\(\);/);
  // A skill that is no longer installed cannot be pinned, so tapping it drops
  // the row rather than offering something that cannot work.
  const tap = HTML.slice(HTML.indexOf('function dropSkillUseRow'), HTML.indexOf('function toggleSkillRail'));
  assert.match(tap, /if \(isPinned\) \{ removePinnedSkill\(name\); return; \}/);
  assert.match(tap, /no longer installed/);
  // But an empty catalogue is not a missing skill: a chat that never needed a
  // skill never fetched the library, so the tap has to look before concluding.
  assert.match(tap, /ensureSkillsLoaded\(\)\.then\(\(\) => \{/);
  assert.match(HTML, /else if \(!skillsCatalog\.length\) \{/);
});

test('all of the conversation stays inside the one scroll window', () => {
  const css = HTML.slice(HTML.indexOf('.chat-messages {'), HTML.indexOf('.message {'));
  // One axis scrolling and the other visible computes to auto on both, which let
  // a wide child be scrolled to instead of wrapped -- and because the column is
  // centred, half of that overflow sat at an offset nothing could reach.
  assert.match(css, /overflow-y: auto/);
  assert.match(css, /overflow-x: hidden/);
});
