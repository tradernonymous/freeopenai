// NEURA-069, the shell half: the two rails and what they remember.
//
// The rules live in desktop/src/workbench.js, which is pure, so the storage
// cases are exercised directly. The components are checked the way every other
// .tsx in this repo is -- by reading the source for the contract the stylesheet
// depends on (`data-pinned`, `role="tab"`, `.workbench-tab-label`), because a
// rail whose attributes are wrong is a rail the CSS cannot lay out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workbench = require('../desktop/src/workbench.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const WORKBENCH_TSX = read('desktop', 'src', 'components', 'Workbench.tsx');
const SIDEBAR_TSX = read('desktop', 'src', 'Sidebar.tsx');
const APP_TSX = read('desktop', 'src', 'App.tsx');
const CSS = read('desktop', 'src', 'index.css');

/** What the component actually renders: its comments explain, they do not show. */
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** A localStorage stand-in whose contents the test can look at. */
function memoryStore() {
  const data = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

/** A store in the state a private window or a blocked-cookies window gives. */
function brokenStore() {
  return {
    getItem() { throw new Error('storage is not available'); },
    setItem() { throw new Error('storage is not available'); },
    removeItem() { throw new Error('storage is not available'); },
  };
}

test('the rail keys are the three the shell agreed on', () => {
  assert.equal(workbench.LEFT_KEY, 'freeai4u.rail.left.pinned');
  assert.equal(workbench.RIGHT_KEY, 'freeai4u.rail.right.pinned');
  assert.equal(workbench.TOOL_KEY, 'freeai4u.rail.right.tool');
});

test('a pinned rail is still pinned after a restart', () => {
  const store = memoryStore();
  assert.equal(workbench.readPinned(workbench.RIGHT_KEY, store), false, 'a fresh install pins nothing');

  workbench.writePinned(workbench.RIGHT_KEY, true, store);
  assert.equal(workbench.readPinned(workbench.RIGHT_KEY, store), true);
  // The other rail is a separate decision and must not have moved.
  assert.equal(workbench.readPinned(workbench.LEFT_KEY, store), false);

  workbench.writePinned(workbench.RIGHT_KEY, false, store);
  assert.equal(workbench.readPinned(workbench.RIGHT_KEY, store), false);
});

test('damaged storage leaves the rails unpinned rather than throwing', () => {
  const broken = brokenStore();
  assert.doesNotThrow(() => workbench.writePinned(workbench.LEFT_KEY, true, broken));
  assert.equal(workbench.readPinned(workbench.LEFT_KEY, broken), false);
  assert.equal(workbench.readTool(broken), workbench.DEFAULT_TOOL);
  assert.doesNotThrow(() => workbench.writeTool('files', broken));

  // A key somebody else's build wrote a JSON blob into is not a pin either.
  const junk = memoryStore();
  junk.data[workbench.LEFT_KEY] = '{"pinned":true}';
  junk.data[workbench.TOOL_KEY] = '{"tool":"files"}';
  assert.equal(workbench.readPinned(workbench.LEFT_KEY, junk), false);
  assert.equal(workbench.readTool(junk), workbench.DEFAULT_TOOL);
});

test('the remembered tool is one of the four, whatever is on disk', () => {
  assert.deepEqual(workbench.toolIds(), ['design', 'build', 'files', 'changes']);

  const store = memoryStore();
  workbench.writeTool('changes', store);
  assert.equal(workbench.readTool(store), 'changes');

  workbench.writeTool('a-tool-that-was-removed', store);
  assert.equal(workbench.readTool(store), workbench.DEFAULT_TOOL, 'an unknown id falls back, it does not render nothing');
  assert.equal(workbench.cleanTool(undefined), workbench.DEFAULT_TOOL);
  assert.equal(workbench.cleanTool('files'), 'files');
});

test('every tool says what it is for', () => {
  for (const item of workbench.TOOLS) {
    assert.ok(item.label && item.label.length <= 12, `${item.id} has a rail-sized label`);
    assert.ok(item.blurb.length > 30, `${item.id} explains itself`);
    assert.ok(!/^[A-Z ]+$/.test(item.label), `${item.id} is not shouted`);
  }
});

test('data-pinned is rendered as the stylesheet spells it', () => {
  assert.equal(workbench.pinnedAttr(true), 'true');
  assert.equal(workbench.pinnedAttr(false), 'false');
  // Both rails: the CSS switches overlay vs in-flow on exactly this attribute.
  assert.match(WORKBENCH_TSX, /data-pinned=\{workbench\.pinnedAttr\(pinned\)\}/);
  assert.match(SIDEBAR_TSX, /data-pinned=\{pinned \? 'true' : 'false'\}/);
  assert.match(CSS, /\.workbench\[data-pinned="false"\]/);
  assert.match(CSS, /\.sidebar\[data-pinned="false"\]/);
});

test('an unpinned rail renders data-pinned="false" and overlays the floor', () => {
  // pinnedAttr is the only source of the attribute, so its false case is the
  // unpinned rail: the CSS then makes it absolute and keeps the floor's margin.
  assert.equal(workbench.pinnedAttr(false), 'false');
  assert.match(
    CSS,
    /\.app-body:has\(\.workbench\[data-pinned="false"\]\) > \.main \{ margin-right: var\(--rail\); \}/,
    'nothing is hidden behind a collapsed right rail',
  );
  assert.ok(
    !/style=\{\{[^}]*margin/.test(WORKBENCH_TSX),
    'the component adds no margin of its own -- that is the stylesheet\'s job',
  );
});

test('exactly one tab can be selected, and the tabs are real tabs', () => {
  assert.match(WORKBENCH_TSX, /role="tablist"/);
  assert.match(WORKBENCH_TSX, /role="tab"/);
  assert.match(WORKBENCH_TSX, /aria-selected=\{tool === item\.id\}/);
  // One `tool` value, compared for equality against ids that are unique, is
  // what makes "exactly one" true rather than a thing to remember by hand.
  assert.equal(new Set(workbench.toolIds()).size, workbench.TOOLS.length);
  for (const id of workbench.toolIds()) {
    const selected = workbench.TOOLS.filter((t) => t.id === workbench.cleanTool(id));
    assert.equal(selected.length, 1, `${id} selects one tab`);
  }
  // Even a tool id that is no longer offered resolves to one selected tab.
  assert.equal(workbench.TOOLS.filter((t) => t.id === workbench.cleanTool('gone')).length, 1);
});

test('the label lives in the span the stylesheet hides when the rail is narrow', () => {
  assert.match(WORKBENCH_TSX, /<span className="workbench-tab-label">\{item\.label\}<\/span>/);
  assert.match(CSS, /\.workbench\[data-pinned="false"\]:not\(:hover\):not\(:focus-within\) \.workbench-tab-label/);
});

test('both pins are real buttons that report their state', () => {
  assert.match(WORKBENCH_TSX, /className="workbench-pin"[\s\S]{0,200}aria-pressed=\{pinned\}/);
  assert.match(SIDEBAR_TSX, /className="sidebar-pin"[\s\S]{0,200}aria-pressed=\{pinned\}/);
  for (const source of [WORKBENCH_TSX, SIDEBAR_TSX]) {
    assert.match(source, /type="button"/, 'a pin is a button, not a div that listens for clicks');
  }
});

test('Escape closes a peeking rail and leaves a pinned one alone', () => {
  assert.equal(workbench.closesOnEscape(false), true);
  assert.equal(workbench.closesOnEscape(true), false);
  for (const source of [WORKBENCH_TSX, SIDEBAR_TSX]) {
    assert.match(source, /e\.key !== 'Escape'/);
    assert.ok(!/preventDefault\(\)/.test(source), 'Escape is shared with the palette and the composer');
  }
});

test('gold marks the selected tab and nothing else', () => {
  // The rail's gold is one rule, and it hangs off the tab's own aria state.
  assert.match(CSS, /\.workbench-tab\[aria-selected="true"\][\s\S]{0,300}var\(--gilt\)/);
  for (const source of [WORKBENCH_TSX, SIDEBAR_TSX]) {
    assert.ok(
      !/var\(--gilt/.test(source),
      'no component paints gold itself; it comes from aria-selected and aria-pressed',
    );
  }
});

test('App owns the rails and hands each one its pin', () => {
  assert.match(APP_TSX, /rails\.readPinned\(rails\.LEFT_KEY\)/);
  assert.match(APP_TSX, /rails\.readPinned\(rails\.RIGHT_KEY\)/);
  assert.match(APP_TSX, /rails\.readTool\(\)/);
  assert.match(APP_TSX, /<Workbench/);
  assert.match(APP_TSX, /pinned=\{leftPinned\}/);
  assert.match(APP_TSX, /pinned=\{rightPinned\}/);
  // A sibling of <main>, inside .app-body: the overlay and the floor's margin
  // both depend on that shape.
  const body = APP_TSX.slice(APP_TSX.indexOf('<div className="app-body">'));
  assert.ok(body.indexOf('</main>') < body.indexOf('<Workbench'), 'the rail sits beside the floor, not inside it');
});

test('Files shows the folder tree, and says what to do when there is none', () => {
  assert.match(WORKBENCH_TSX, /<LocalTree root=\{localRoot\}/);
  assert.match(WORKBENCH_TSX, /Open a folder to see its files\./);
  // Empty states are directions, not apologies.
  assert.ok(!/No data|Nothing here|Sorry/i.test(withoutComments(WORKBENCH_TSX)));
});
