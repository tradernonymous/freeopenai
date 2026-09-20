// The artifacts canvas is the page counterpart to the per-block Preview
// dialog: an always-on sandboxed iframe pane that accumulates the HTML blocks
// from a chat and rerenders the one the reader picks, live. The pane state
// stays in localStorage (closed by default) so it survives a reload, and
// opening it always closes the session panel -- the two panes can never share
// the corner. Unlike the one-shot dialog it never carries same-origin bytes:
// every block is rendered through an opaque origin.
//
// The state and decisions live in canvas-artifacts.js and are tested directly
// below, constructed with stand-ins the way share-memory.test.js does it. This
// file keeps the two page-level pins the module cannot see: that the shipped
// iframe stays sandboxed without same-origin, and that the boot restores the
// canvas after the session panel.
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const { create: createCanvasArtifacts, REACT_MARKER } = require('../canvas-artifacts.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const CANVAS_HIDDEN_KEY = 'freeopenaiCanvasHidden';

// ---- module harness -------------------------------------------------------

// A storage stand-in that can be told to refuse writes, so the toggle's
// try/catch path is exercised rather than described.
function makeStorage({ failSets = false, stored = null } = {}) {
  const ops = [];
  const data = new Map();
  if (stored !== null) data.set(CANVAS_HIDDEN_KEY, stored);
  return {
    ops,
    getItem(k) { ops.push(['get', k]); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) {
      ops.push(['set', k, String(v)]);
      if (failSets) throw new Error('storage refused');
      data.set(k, String(v));
    },
  };
}

function makeEl(extra = {}) {
  return Object.assign({
    attrs: {}, children: [], textContent: '', value: '', srcdoc: '', title: '',
    handlers: {},
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
    toggleAttribute(n, on) { if (on) this.attrs[n] = ''; else delete this.attrs[n]; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
  }, extra);
}

function harness({ pres = [], stored = null, failSets = false, shellHidden = true, rawShell = false } = {}) {
  const shellEl = rawShell ? { notAnElement: true } : {
    classList: {
      contains(cls) { return cls === 'canvas-hidden' ? shellHidden : false; },
      toggle(cls, on) { if (cls === 'canvas-hidden') shellHidden = on; },
    },
  };
  const els = {
    canvasPane: makeEl(),
    canvasFrame: makeEl(),
    canvasSelect: makeEl(),
    canvasCount: makeEl(),
    canvasScrim: makeEl(),
  };
  const chat = { querySelectorAll(sel) { return sel === '.message .message-text pre[data-lang="html"]' ? pres : []; } };
  const storage = makeStorage({ failSets, stored });
  const sessionToggles = [];
  const module = createCanvasArtifacts({
    localStorage: storage,
    doc: {
      getElementById(id) { return els[id] || null; },
      querySelector(sel) { return sel === '#viewChat .chat-shell' ? shellEl : null; },
    },
    chatMessages: chat,
    onOpenPane: (force) => { sessionToggles.push(force); },
    onBlocks: () => { blocksDrawn += 1; },
  });
  let blocksDrawn = 0;
  return { module, els, storage, sessionToggles, chat, shell: shellEl, drawn: () => blocksDrawn };
}

function preBlock(code) {
  return {
    dataset: { lang: 'html' },
    querySelector(sel) { return sel === 'code' ? { textContent: code } : null; },
    textContent: code,
  };
}

// ---- document building (the sandboxing rule) ------------------------------

test('a bare fragment is wrapped in a full, self-contained document', () => {
  const h = harness();
  const doc = h.module.buildArtifactDocument('<b>hi</b>');
  assert.ok(doc.startsWith('<!doctype html>'));
  assert.ok(doc.includes('<body><b>hi</b></body>'));
  // It rode in as a plain fragment, so it must not drag React or Babel along.
  assert.ok(!doc.includes('canvas react'));
  assert.ok(!doc.includes('text/babel'));
});

test('a complete page is let through untouched', () => {
  const h = harness();
  const page = '<!doctype html><html><head><title>t</title></head><body>x</body></html>';
  assert.equal(h.module.buildArtifactDocument(page), page);
});

test('the react marker switches the body out to a JSX stage', () => {
  const h = harness();
  const doc = h.module.buildArtifactDocument('<!-- canvas react -->\nconst App = () => <h1>hi</h1>;');
  assert.ok(doc.includes('text/babel'), 'JSX needs the Babel toolchain, not a loophole');
  assert.ok(doc.includes('<div id="root">'));
  assert.ok(doc.includes('const App = () => <h1>hi</h1>;'));
  // The toolchains come from CDNs as ordinary scripts; the page itself must
  // not be truncated by an inline </script> in the user code, so the closer
  // is always emitted as a split string.
  const src = fs.readFileSync(path.join(__dirname, '..', 'canvas-artifacts.js'), 'utf8');
  assert.match(src, /\+ '\/script>'/);
});

test('the marker constant is shared with the page, not re-declared', () => {
  assert.equal(REACT_MARKER, '<!-- canvas react -->');
});

// ---- pane show/hide and persistence ----------------------------------------

test('opening the canvas surfaces the pane and closes the session panel', () => {
  const h = harness({ shellHidden: true });
  h.module.showPane(true);
  assert.equal(h.shell.classList.contains('canvas-hidden'), false, 'opening the canvas must surface the pane');
  assert.equal(h.els.canvasPane.attrs['aria-hidden'], 'false');
  assert.equal(h.els.canvasScrim.attrs['aria-hidden'], 'false');
  assert.equal(h.els.canvasPane.attrs.inert, undefined, 'a visible pane must not be inert');
  assert.deepEqual(h.sessionToggles.length, 1, 'the page hook runs on open (the page folds the session panel away)');
  assert.ok(h.storage.ops.some(([op, k, v]) => op === 'set' && k === CANVAS_HIDDEN_KEY && v === ''), 'an open canvas is remembered as open');
});

test('closing the canvas hides pane and scrim, makes them inert, and remembers the close', () => {
  const h = harness({ shellHidden: false });
  h.module.showPane(false);
  assert.equal(h.els.canvasPane.attrs['aria-hidden'], 'true');
  assert.equal(h.els.canvasScrim.attrs['aria-hidden'], 'true');
  assert.equal(h.els.canvasPane.attrs.inert, '', 'a hidden pane must be inert to keyboard focus');
  assert.ok(h.storage.ops.some(([op, k, v]) => op === 'set' && k === CANVAS_HIDDEN_KEY && v === '1'));
  assert.deepEqual(h.sessionToggles, [], 'closing never touches the session panel');
});

test('restore defaults to closed; an explicit stored value is honoured', () => {
  const closed = harness({ stored: null, shellHidden: true });
  closed.module.restorePane();
  assert.equal(closed.shell.classList.contains('canvas-hidden'), true, 'a canvas must stay closed until there is something to see');
  assert.deepEqual(closed.storage.ops.filter(([op]) => op === 'set'), [], 'a restore must not write the choice back as if just made');

  const open = harness({ stored: '', shellHidden: true });
  open.module.restorePane();
  assert.equal(open.shell.classList.contains('canvas-hidden'), false, "an explicitly stored '' means open");

  const shut = harness({ stored: '1', shellHidden: false });
  shut.module.restorePane();
  assert.equal(shut.shell.classList.contains('canvas-hidden'), true, "a stored '1' means closed");
});

test('a refusing storage degrades to a working toggle without the persistence', () => {
  const h = harness({ shellHidden: true, failSets: true });
  h.module.showPane(true);
  assert.equal(h.shell.classList.contains('canvas-hidden'), false, 'the toggle itself still works');
});

test('a missing shell is a no-op, not a crash', () => {
  const h = harness({ rawShell: true });
  h.module.showPane(true);
  assert.ok(true, 'reaching here is the assertion');
});

// ---- block collection and selection ----------------------------------------

test('collecting blocks dedupes the ones already on the list', () => {
  const h = harness({ pres: [preBlock('<b>a</b>'), preBlock('<b>a</b>'), preBlock('<b>b</b>')] });
  const blocks = h.module.collectBlocks();
  assert.equal(blocks.length, 2);
  assert.equal(h.drawn(), 1, 'the page hook fires once per collect');
});

test('a fresh collect follows the tail; an explicit pick stays put', () => {
  const first = preBlock('<b>a</b>');
  const second = preBlock('<b>b</b>');
  const h = harness({ pres: [first, second] });
  h.module.collectBlocks();
  assert.equal(h.module.currentIndex(), 1, 'a new list lands on the newest block');
  h.module.selectBlock(0); // the reader pins the first block
  h.chat.querySelectorAll = () => [first, second, preBlock('<b>c</b>')];
  h.module.collectBlocks();
  assert.equal(h.module.currentIndex(), 0, 'picking an older block must not be yanked to the tail');
});

test('an empty chat resets the list instead of keeping stale blocks', () => {
  const h = harness({ pres: [] });
  h.module.collectBlocks();
  h.module.selectBlock(0);
  assert.equal(h.module.blocksList().length, 0);
  assert.equal(h.module.currentIndex(), -1);
});

test('openForPre registers an unseen block, selects it, and shows the pane', () => {
  const h = harness({ pres: [preBlock('<b>a</b>')], shellHidden: true });
  h.module.collectBlocks();
  h.module.openForPre(preBlock('<b>z</b>'));
  assert.equal(h.module.blocksList().length, 2, 'the tapped block joined the list');
  assert.equal(h.module.currentIndex(), 1, 'the pane opened on the tapped block');
  assert.equal(h.shell.classList.contains('canvas-hidden'), false, 'tapping Canvas surfaces the pane');
  assert.equal(h.module.HIDDEN_KEY, CANVAS_HIDDEN_KEY, 'the storage key keeps its name');
});

// ---- the shipped page keeps its pins ----------------------------------------

test('the canvas picker and frame are wired into the page', () => {
  // The pane, the toggle, and the mutual exclusion with the session panel are
  // all present as markup and as page calls, so a build that drops any of them
  // fails here rather than silently losing the artifacts view.
  const at = HTML.indexOf('id="canvasFrame"');
  const frameTag = HTML.slice(Math.max(0, at - 200), at + 300);
  assert.match(frameTag, /<iframe[\s\S]*?sandbox="allow-scripts"/);
  assert.ok(!/allow-same-origin/.test(frameTag), 'the canvas iframe must never rejoin this origin');
  assert.ok(HTML.includes("classList.contains('canvas-hidden')"), 'the toggle keyed on the shell is how open/closed is tracked');
  assert.ok(HTML.includes('function restoreCanvas'), 'restoreCanvas must exist to reopen a persisted state');
  assert.ok(HTML.indexOf('restoreSessionPanel();') < HTML.indexOf('restoreCanvas();'), 'the boot must restore the session panel before the canvas');
  assert.ok(HTML.includes('canvas-artifacts.js'), 'the page loads the module');
  assert.ok(HTML.includes('CanvasArtifacts.create('), 'and builds its instance');
});
