// The session panel as shipped, run against a small DOM stub.
//
// The rules are unit-tested in todos.test.js; this file is about the wiring --
// that the page actually draws the plan in the panel, that a click goes through
// the same status rule the model's tool uses, and that what used to be two cards
// in the gutters is one surface whose sections cannot all be drawn at once. A
// render function nothing calls, or a class nothing toggles, is a feature that
// looks finished in a diff and is not there at runtime.
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

// The panel's open/close/tab machinery is extracted together, because the
// interesting rules are the ones between them: that opening draws the section it
// opens on, that only one section is ever drawn, and that a restored choice is
// honoured without being written back as if the user had just made it.
const NAMES = [
  'renderTaskList',
  'sessionShell',
  'toggleSessionPanel',
  'restoreSessionPanel',
  'showSessionTab',
  'openSessionPanel',
  'updateSessionSummary',
  'sessionSkillCount',
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
  // classList over className. The tab switcher is the only thing that needs it,
  // and `toggle(name, on)` is how it says which section is showing.
  node.classList = {
    contains: (c) => String(node.className || '').split(/\s+/).includes(c),
    add: (c) => { if (!node.classList.contains(c)) node.className = (node.className ? node.className + ' ' : '') + c; },
    remove: (c) => { node.className = String(node.className || '').split(/\s+/).filter((x) => x && x !== c).join(' '); },
    toggle: (c, on) => {
      const want = on === undefined ? !node.classList.contains(c) : !!on;
      if (want) node.classList.add(c); else node.classList.remove(c);
      return want;
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

// classList over a className string, which is all the panel toggle needs.
function stubShell(hidden = false) {
  const classes = new Set(hidden ? ['session-hidden'] : []);
  return {
    dataset: {},
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return on; },
      classes,
    },
  };
}

// The panel defaults to closed on its first section, so a test says what it
// wants open by calling the real toggle.
function harness({
  graph = newTaskGraph(),
  stored = null,
  storedTab = null,
  shell = null,
  catalogue = [],
  skillNames = [],
  skillUse = {},
  imageModeOn = false,
  puterImagesOn = false,
  conversationId = 'c1',
} = {}) {
  const document = stubDocument();
  const saved = [];
  const statuses = [];
  // Keyed, because the panel persists two different things: whether it is open
  // and which section it was left on. One slot would make reopening on the plan
  // look like reopening closed.
  const store = { data: { freeopenaiSessionHidden: stored, freeopenaiSessionTab: storedTab } };
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
      getItem: (k) => store.data[k] ?? null,
      setItem: (k, v) => { store.data[k] = v; },
    },
    SESSION_HIDDEN_KEY: 'freeopenaiSessionHidden',
    SESSION_TAB_KEY: 'freeopenaiSessionTab',
    SESSION_TABS: ['skills', 'tasks', 'image'],
    sessionTab: 'skills',
    // The page-scope names the summary reads. None is written by the panel, so
    // a test can set the world and read what the panel says about it.
    imageMode: imageModeOn,
    drawWithPuter: puterImagesOn,
    activeSkillNames: skillNames,
    activeConversationId: conversationId,
    skillUseLog: skillUse,
    skillsCatalog: catalogue,
    skillSearch: { value: '' },
    ensureSkillsLoaded: () => Promise.resolve(catalogue),
    // The picker's own renderers are covered by the skills tests; here they are
    // a seam, so the panel's job -- showing one section at a time -- is what is
    // measured.
    renderSkillMenuOptions: () => {},
    filterSkillOptions: () => {},
    saveTaskGraph: () => saved.push(JSON.parse(JSON.stringify(deps.taskGraph))),
    showStatus: (kind, text) => statuses.push(kind + ': ' + text),
    shell: shell || stubShell(),
  };
  // The shell is the only querySelector the panel makes.
  document.querySelector = (sel) => (sel === '#viewChat .chat-shell' ? deps.shell : null);
  const loaded = loadFromIndex(NAMES, deps);
  return { deps, document, saved, statuses, store, loaded };
}

const rows = (document) => document.getElementById('todoList').children;
const cls = (document, id) => String(document.getElementById(id).className || '');

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
  // And the dot on the buttons that open the panel, so a closed panel with open
  // work still says something.
  assert.notEqual(h.document.getElementById('sessionBadge').style.display, 'none');
});

test('an empty list explains itself rather than rendering nothing', () => {
  const h = harness();
  h.loaded.renderTaskList();
  const drawn = rows(h.document);
  assert.equal(drawn.length, 1);
  assert.match(drawn[0].textContent, /No todos yet/);
  assert.equal(h.document.getElementById('todoCount').textContent, 'empty');
  assert.equal(h.document.getElementById('todoProgressFill').style.width, '0%');
  assert.equal(h.document.getElementById('sessionBadge').style.display, 'none', 'nothing open, no badge');
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
  h.loaded.toggleSessionPanel(false);
  assert.ok(shell.classList.contains('session-hidden'));
  assert.equal(h.document.getElementById('sessionToggle').getAttribute('aria-pressed'), 'false');
  assert.equal(h.document.getElementById('sessionChip').getAttribute('aria-expanded'), 'false');
  assert.equal(h.store.data.freeopenaiSessionHidden, '1', 'closed is remembered');
  h.loaded.toggleSessionPanel();
  assert.ok(!shell.classList.contains('session-hidden'));
  assert.equal(h.document.getElementById('sessionToggle').getAttribute('aria-pressed'), 'true');
  assert.equal(h.document.getElementById('sessionChip').getAttribute('aria-expanded'), 'true');
  assert.equal(h.store.data.freeopenaiSessionHidden, '', 'and so is open');
});

test('the panel starts closed, draws its first section, and honours both stored choices', () => {
  // Closed is the default everywhere. As columns these cards held their own
  // space and open-on-load cost nothing; floating, open-on-load is a surface
  // covering an answer nobody has read yet, so being open is a choice.
  const shell = stubShell(false);
  const h = harness({ shell });
  h.loaded.restoreSessionPanel();
  assert.ok(shell.classList.contains('session-hidden'), 'closed by default');
  // Nothing was written back: a default is not a choice.
  assert.equal(h.store.data.freeopenaiSessionHidden, null, 'restoring must not persist a default');
  assert.equal(h.store.data.freeopenaiSessionTab, null, 'nor a default section');
  assert.equal(h.deps.sessionTab, 'skills');
  assert.match(cls(h.document, 'sessionSectionSkills'), /active/);
  assert.doesNotMatch(cls(h.document, 'sessionSectionTasks'), /active/);

  // Once chosen, honoured: a panel left open on the plan reopens on the plan.
  const openShell = stubShell(true);
  const open = harness({ shell: openShell, stored: '', storedTab: 'tasks' });
  open.loaded.restoreSessionPanel();
  assert.ok(!openShell.classList.contains('session-hidden'), 'a stored "open" survives');
  assert.equal(open.deps.sessionTab, 'tasks');
  assert.equal(open.document.getElementById('sessionTabTasks').getAttribute('aria-pressed'), 'true');
  assert.equal(open.document.getElementById('sessionTabSkills').getAttribute('aria-pressed'), 'false');
  assert.match(cls(open.document, 'sessionSectionTasks'), /active/);

  // A stored section that no longer exists is not a reason to draw nothing.
  const stale = harness({ storedTab: 'nonsense' });
  stale.loaded.restoreSessionPanel();
  assert.equal(stale.deps.sessionTab, 'skills');
});

test('the three sections are one surface, and only one is drawn at a time', () => {
  const shell = stubShell(false);
  const h = harness({ shell });
  h.loaded.toggleSessionPanel(true);
  assert.ok(!shell.classList.contains('session-hidden'));

  for (const tab of ['image', 'tasks', 'skills']) {
    h.loaded.showSessionTab(tab);
    const cap = tab.charAt(0).toUpperCase() + tab.slice(1);
    assert.equal(h.deps.sessionTab, tab);
    assert.equal(shell.dataset.sessionTab, tab, 'the shell says which section is showing');
    assert.equal(h.document.getElementById('sessionTab' + cap).getAttribute('aria-pressed'), 'true');
    const drawn = ['skills', 'tasks', 'image']
      .filter((name) => /active/.test(cls(h.document, 'sessionSection' + name.charAt(0).toUpperCase() + name.slice(1))));
    assert.deepEqual(drawn, [tab], 'exactly one section is drawn');
    for (const other of ['skills', 'tasks', 'image'].filter((n) => n !== tab)) {
      assert.equal(h.document.getElementById('sessionTab' + other.charAt(0).toUpperCase() + other.slice(1)).getAttribute('aria-pressed'), 'false');
    }
  }
  assert.equal(h.store.data.freeopenaiSessionTab, 'skills', 'the section is remembered');
});

test('opening at a named section, for the two places that mean one', () => {
  const shell = stubShell(false);
  const h = harness({ shell });
  h.loaded.openSessionPanel('tasks');
  assert.ok(!shell.classList.contains('session-hidden'), 'it opens');
  assert.equal(h.deps.sessionTab, 'tasks', 'on the section that was asked for');
  assert.equal(h.store.data.freeopenaiSessionTab, 'tasks');
});

test('one line and one dot summarise what the panel holds', () => {
  // Nothing used, nothing recorded: the panel says so rather than being blank,
  // and the dot stays off.
  const quiet = harness();
  quiet.loaded.updateSessionSummary();
  assert.equal(quiet.document.getElementById('sessionCount').textContent, 'nothing on yet');
  assert.equal(quiet.document.getElementById('sessionBadge').style.display, 'none');

  // Skills the router applied are a fact about this chat, and they count even
  // when nothing is pinned.
  const used = harness({ skillUse: { c1: { ponytail: { pinned: false, turns: 2 } } } });
  used.loaded.updateSessionSummary();
  assert.equal(used.document.getElementById('sessionCount').textContent, '1 skill');
  // A skill the router applied on its own is a record, not something waiting on
  // you -- so it is worth a line and not worth lighting the dot.
  assert.equal(used.document.getElementById('sessionBadge').style.display, 'none');

  // A pinned skill, a recorded plan and a forced drawing are all reasons the dot
  // lights: the panel is closed most of the time, and "there is something in
  // here" has to be legible without opening it.
  let graph = addTask(newTaskGraph(), { title: 'Ship it' }).graph;
  graph = setTaskStatus(graph, 't1', 'done').graph;
  const busy = harness({
    graph,
    skillNames: ['ponytail'],
    skillUse: { c1: { ponytail: { pinned: true, turns: 3 } } },
    imageModeOn: true,
  });
  busy.loaded.updateSessionSummary();
  const line = busy.document.getElementById('sessionCount').textContent;
  assert.match(line, /1 skill, 1 pinned/);
  assert.match(line, /1\/1 tasks/);
  assert.match(line, /drawing/);
  assert.equal(busy.document.getElementById('sessionBadge').style.display, '');

  // Another chat's habits are not this chat's summary.
  const elsewhere = harness({ skillUse: { 'other-chat': { ponytail: { pinned: false, turns: 9 } } } });
  elsewhere.loaded.updateSessionSummary();
  assert.equal(elsewhere.document.getElementById('sessionCount').textContent, 'nothing on yet');
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

test('the session surface is one glass pop-up, and a drawer on a phone', () => {
  // Markup: one panel, three sections, and the plan's list, count and progress
  // bar inside it rather than in a card of its own.
  for (const id of [
    'sessionPanel', 'sessionScrim', 'sessionToggle', 'sessionChip', 'sessionCount', 'sessionBadge',
    'sessionTabSkills', 'sessionTabTasks', 'sessionTabImage',
    'sessionSectionSkills', 'sessionSectionTasks', 'sessionSectionImage',
    'skillRailList', 'skillMenuList', 'skillSearch', 'autoSkillsCheck',
    'todoList', 'todoCount', 'todoProgress', 'todoProgressFill', 'imageModeSwitch', 'sessionImageShape',
  ]) {
    assert.ok(HTML.includes('id="' + id + '"'), 'index.html is missing #' + id);
  }
  // And the two cards and the three composer controls it absorbed are gone, ids
  // included: a leftover id is a second source of truth waiting to be wired up.
  for (const gone of [
    'skillRail', 'todoSidebar', 'skillRailToggle', 'todoToggle', 'todoBadge', 'skillRailBadge',
    'skillRailCount', 'todoScrim', 'skillScrim', 'skillsToggle', 'skillTrigger', 'skillMenu',
    'imageModeBtn',
  ]) {
    assert.equal(HTML.includes('id="' + gone + '"'), false, '#' + gone + ' outlived the consolidation');
  }
  // The shell carries the class the toggle flips -- a toggle for a class nobody
  // sets is a button that does nothing.
  assert.match(HTML, /class="chat-shell[^"]*"/);
  assert.match(HTML, /\.chat-shell\.session-hidden \.session-panel/);
  // The panel is still one thing, not two: the width-budget rule that used to
  // arbitrate between two pop-ups has nothing left to arbitrate.
  assert.doesNotMatch(HTML, /panelsFitTogether|PANELS_BESIDE_MEASURE_PX/);

  // The desktop shape is a glass pop-up over the chat, not a column of the
  // layout. The two lists used to cost 500px of the transcript between them.
  const panel = HTML.slice(HTML.indexOf('\n        .session-panel {'), HTML.indexOf('\n        /* Out of the way means out of reach'));
  assert.match(panel, /position: absolute; z-index: 25;/);
  assert.match(panel, /top: calc\(var\(--bar-h\) \+ 10px\)/, 'a pop-up that covers the button that dismisses it is a trap');
  // And it stops above the composer. `bottom: 10px` put the todo card over Send:
  // the composer's right edge and the card's left edge crossed, so the one
  // control every turn needs was behind a panel.
  assert.match(panel, /bottom: var\(--panel-floor, 10px\)/);
  assert.match(HTML, /function syncPanelFloor\(\)/, 'nothing measures the composer');
  const floor = HTML.slice(HTML.indexOf('function syncPanelFloor()'), HTML.indexOf('function watchPanelFloor()'));
  assert.match(floor, /shellBox\.bottom - composerBox\.top \+ 10/, 'the floor is not derived from the composer');
  assert.match(floor, /Math\.max\(10, /, 'a collapsed composer would put the panel through the floor');
  assert.match(HTML, /panelFloorObserver = new ResizeObserver/, 'the floor does not follow a growing composer');
  assert.match(HTML, /restoreSessionPanel\(\);\s*watchPanelFloor\(\)/, 'the floor is never measured at startup');
  assert.match(panel, /background: var\(--glass\)/);
  assert.match(panel, /backdrop-filter: blur\(18px\)/, 'the pop-up has to be glass');
  assert.match(panel, /-webkit-backdrop-filter: blur\(18px\)/, 'or Safari gets an opaque slab');
  assert.match(panel, /border-radius: var\(--r-lg\)/);
  assert.match(panel, /box-shadow: var\(--lift-lg\), 0 16px 40px/);
  assert.match(panel, /transition: transform/);
  // Out of the layout means no width to give back and no flex item either.
  assert.doesNotMatch(panel, /flex-shrink/, 'a floating panel is not a layout column');
  // One scroll region: the section scrolls, and neither list keeps a scrollbar
  // of its own. Two nested scrollers inside 300px is a maze.
  assert.match(HTML, /\.session-section \{ display: none; flex: 1; min-height: 0; overflow-y: auto;/);
  assert.match(HTML, /\.session-section\.active \{ display: block; \}/);
  assert.match(HTML, /\.session-section \.rail-list, \.session-section \.todo-list \{ flex: none; overflow: visible; \}/);
  // Hidden has to mean gone, not merely invisible: a transparent panel still
  // swallows the clicks meant for the transcript underneath it.
  const putAway = HTML.slice(HTML.indexOf('.chat-shell.session-hidden .session-panel {'), HTML.indexOf('.session-tabs {'));
  assert.match(putAway, /opacity: 0; pointer-events: none;/);
  assert.match(putAway, /translateX\(calc\(100% \+ 20px\)\)/);

  // Both small screens -- a portrait phone and a short landscape one -- turn the
  // panel into an off-canvas drawer from the right, flush and square: there is
  // no room for a card beside anything. That shape is shared, so it lives in the
  // one small-screen block; the landscape block only narrows how much of the
  // width the drawer takes.
  const small = HTML.slice(
    HTML.indexOf('@media (max-width: 640px), (max-height: 520px) and (orientation: landscape)'),
    HTML.indexOf('@media (max-width: 380px)'),
  );
  assert.match(small, /\.session-panel \{[\s\S]*?position: absolute; top: 0; bottom: 0; right: 0[\s\S]*?margin: 0/);
  assert.match(small, /\.chat-shell\.session-hidden \.session-panel \{[\s\S]*?translateX\(102%\)/);
  assert.match(small, /\.session-scrim \{[\s\S]*?display: block/);
  assert.match(small, /\.chat-shell\.session-hidden \.session-scrim \{ opacity: 0; pointer-events: none; \}/);
  const landscape = HTML.slice(HTML.indexOf('@media (max-height: 520px) and (orientation: landscape) {'));
  assert.match(landscape, /\.session-panel,[\s\S]*?width: 34%/);
  // Nothing is hidden at any desktop size any more: one pop-up has no width to
  // argue over, so it is available at every one of them.
  assert.doesNotMatch(HTML, /#sessionToggle \{ display: none; \}/, 'the panel is hidden at some desktop width again');
});

test('the composer and the chat bar each carry one control for the surface', () => {
  // The two header buttons became one, and the composer's three image/skill
  // controls became one chip in the settings group.
  assert.match(HTML, /id="sessionToggle"/);
  assert.match(HTML, /id="sessionChip"/);
  assert.match(HTML, /<button class="session-chip"[^>]*id="sessionChip"[^>]*onclick="toggleSessionPanel\(\)"/);
  // The actions group is down to attach alone, and it now leads the settings row
  // rather than holding a line of its own -- so the slice runs from the group to
  // the first control after it.
  const actions = HTML.slice(HTML.indexOf('<div class="composer-actions">'), HTML.indexOf('id="sessionChip"'));
  assert.match(actions, /id="attachTrigger"/);
  assert.doesNotMatch(actions, /id="imageModeBtn"|toggleImageMode/);
  assert.equal(HTML.includes('id="skillsToggle"'), false);
  // The switch that replaced the draw button is a labelled checkbox, and the
  // hero starter that turns it on is still the discoverable path to it.
  assert.match(HTML, /<label for="imageModeSwitch">Read the next message as a drawing<\/label>/);
  assert.match(HTML, /<input type="checkbox" id="imageModeSwitch" onchange="setImageMode\(this\.checked\)">/);
  // Spending Puter credits on a picture is a choice, and this is where it is
  // made. It sits beside the drawing switch because that is where someone who
  // wants a better picture will look for it.
  assert.match(HTML, /<input type="checkbox" id="imagePuterSwitch" onchange="setDrawWithPuter\(this\.checked\)">/);
  assert.match(HTML, /Draw with Puter/);
  assert.match(HTML, /spends credits/);
  // Off unless the stored value says otherwise: a default that read the other
  // way would spend the allowance before anyone touched anything.
  assert.match(HTML, /let drawWithPuter = localStorage\.getItem\(IMAGE_PUTER_KEY\) === '1';/);
  assert.match(HTML, /onclick="startImageTurn\(\)"/);
  const hero = HTML.slice(HTML.indexOf('function startImageTurn()'), HTML.indexOf('function startPlanTurn()'));
  assert.match(hero, /if \(!imageMode\) toggleImageMode\(\);/);
});

test('every control in the toolbar is built from the same four values', () => {
  // The row used to be 999px pills beside 8px rectangles, 4px padding beside
  // 6px: three apps stitched together. These tokens are now the only thing that
  // decides how a control looks.
  const root = HTML.slice(HTML.indexOf(':root {'), HTML.indexOf('/* Light theme'));
  for (const token of ['--ctl-h', '--ctl-r', '--ctl-bg', '--ctl-bg-hover']) {
    assert.ok(root.includes(token + ':'), 'missing ' + token);
  }
  for (const group of ['\\.effort-chip, \\.mode-chip, \\.session-chip', '\\.composer-attach, \\.composer-send']) {
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

test('the skills panel records what applied, per conversation', () => {
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
  const tap = HTML.slice(HTML.indexOf('function dropSkillUseRow'), HTML.indexOf('// --- Sending a work step'));
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
