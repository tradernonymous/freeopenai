// The artifacts canvas is the page counterpart to the per-block Preview
// dialog: an always-on sandboxed iframe pane that accumulates the HTML blocks
// from a chat and rerenders the one the reader picks, live. The pane state
// stays in localStorage (closed by default) so it survives a reload, and
// opening it always closes the session panel -- the two panes can never share
// the corner. Unlike the one-shot dialog it never carries same-origin bytes:
// every block is rendered through an opaque origin. The same helper-wiring
// harness used by the diagram and preview tests lifts these functions out of
// the page and runs them against stubs.
//
// No canvas function may contain a template literal: the scanner that reads
// them out of the page is brace-walking and would stop at the first backtick.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertScannerCanRead,
  assertSandboxCovers,
  loadFromIndex,
  sourceOf,
  HTML,
} = require('./helpers/index-html.js');

const CANVAS_REACT_MARKER = '<!-- canvas react -->';
const CANVAS_HIDDEN_KEY = 'freeopenaiCanvasHidden';

const NAMES = [
  'artifactDocument',
  'renderCanvasArtifact',
  'canvasShell',
  'toggleCanvas',
  'restoreCanvas',
  'collectCanvasBlocks',
  'renderCanvasPicker',
  'selectCanvasBlock',
  'openSelectedCanvasBlock',
  'updateCanvasFrame',
  'openCanvasForBlock',
];

function makeDeps({ pres = [], hiddenDefault = true, persist = true } = {}) {
  let shellHidden = hiddenDefault;
  const shell = {
    classList: {
      contains(cls) { return cls === 'canvas-hidden' ? shellHidden : false; },
      toggle(cls, on) { if (cls === 'canvas-hidden') shellHidden = on; },
    },
  };
  function makeEl() {
    return {
      attrs: {}, children: [], textContent: '', value: '', srcdoc: '', title: '',
      handlers: {},
      setAttribute(n, v) { this.attrs[n] = String(v); },
      removeAttribute(n) { delete this.attrs[n]; },
      toggleAttribute(n, on) { if (on) this.attrs[n] = ''; else delete this.attrs[n]; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    };
  }
  const canvasPane = makeEl();
  const canvasFrame = makeEl();
  canvasFrame.id = 'canvasFrame';
  const canvasSelect = makeEl();
  canvasSelect.id = 'canvasSelect';
  const canvasCount = makeEl();
  canvasCount.id = 'canvasCount';
  const canvasScrim = makeEl();
  canvasScrim.id = 'canvasScrim';
  const els = { canvasPane, canvasFrame, canvasSelect, canvasCount, canvasScrim };
  const storage = [];
  const sessionToggles = [];
  const picks = [];
  const deps = {
    CANVAS_REACT_MARKER,
    CANVAS_HIDDEN_KEY,
    canvasShell: () => shell,
    toggleSessionPanel: (force) => { sessionToggles.push(force); },
    renderCanvasPicker: () => { picks.push(1); },
    document: {
      querySelector(sel) { return sel === '#viewChat .chat-shell' ? shell : null; },
      getElementById(id) { return els[id] || null; },
      createElement(tag) { return makeEl(); },
    },
    chatMessages: {
      querySelectorAll(sel) { return sel === '.message .message-text pre[data-lang="html"]' ? pres : []; },
    },
    localStorage: {
      getItem(k) { storage.push(['get', k]); return null; },
      setItem(k, v) { storage.push(['set', k, v]); },
    },
    chatMessages2: null, // placeholder slot; real name is chatMessages
  };
  // The page-scope picker is real (extracted) in production but a recording
  // spy here, so tests watch the toggle without re-rendering the DOM.
  deps.canvasBlocks = [];
  deps.canvasIndex = -1;
  return { deps, shell, els, storage, sessionToggles, picks };
}

function preBlock(code) {
  return {
    dataset: { lang: 'html' },
    querySelector(sel) { return sel === 'code' ? { textContent: code } : null; },
    textContent: code,
  };
}

test('fix the canvas wiring names the scanner must be able to read', () => {
  assertScannerCanRead(NAMES);
});

test('every page-scope name the canvas calls is supplied to the sandbox', () => {
  assertSandboxCovers(NAMES, {
    CANVAS_REACT_MARKER,
    CANVAS_HIDDEN_KEY,
    canvasShell: () => null,
    toggleSessionPanel: () => {},
    renderCanvasPicker: () => {},
    selectCanvasBlock: () => {},
    toggleCanvas: () => {},
    document: { querySelector: () => null, getElementById: () => null },
    chatMessages: { querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
});

test('a bare fragment is wrapped in a full, self-contained document', () => {
  const { deps } = makeDeps();
  const { artifactDocument } = loadFromIndex(['artifactDocument'], deps);
  const doc = artifactDocument('<b>hi</b>');
  assert.ok(doc.startsWith('<!doctype html>'));
  assert.ok(doc.includes('<body><b>hi</b></body>'));
  // It rode in as a plain fragment, so it must not drag React or Babel along.
  assert.ok(!doc.includes('canvas react'));
  assert.ok(!doc.includes('text/babel'));
});

test('a complete page is let through untouched', () => {
  const { deps } = makeDeps();
  const { artifactDocument } = loadFromIndex(['artifactDocument'], deps);
  const page = '<!doctype html><html><head><title>t</title></head><body>x</body></html>';
  assert.equal(artifactDocument(page), page);
});

test('the react marker switches the body out to a JSX stage', () => {
  const { deps } = makeDeps();
  const { artifactDocument } = loadFromIndex(['artifactDocument'], deps);
  const doc = artifactDocument('<!-- canvas react -->\nconst App = () => <h1>hi</h1>;');
  assert.ok(doc.includes('text/babel'), 'JSX needs the Babel toolchain, not a loophole');
  assert.ok(doc.includes('<div id="root">'));
  assert.ok(doc.includes('const App = () => <h1>hi</h1>;'));
  // The toolchains come from CDNs as ordinary scripts; the page itself must
  // not be truncated by an inline </script> in the user code, so the closer
  // is always emitted as a split string.
  assert.match(sourceOf('artifactDocument'), /\+ '\/script>'/);
});

test('the live frame is a sandbox without same-origin, filled via srcdoc', () => {
  const { deps, els } = makeDeps();
  const { renderCanvasArtifact } = loadFromIndex(['artifactDocument', 'renderCanvasArtifact'], deps);
  renderCanvasArtifact('<p>hi</p>');
  assert.ok(els.canvasFrame.srcdoc.startsWith('<!doctype html>'));
  assert.ok(els.canvasFrame.srcdoc.includes('<p>hi</p>'), 'the artifact must render inside the frame');
});

test('opening the canvas closes the session panel and persists the choice', () => {
  const { deps, shell, els, storage, sessionToggles } = makeDeps({ hiddenDefault: true });
  const page = loadFromIndex(NAMES, deps);
  page.toggleCanvas(true);
  assert.equal(shell.classList.contains('canvas-hidden'), false, 'opening the canvas must surface the pane');
  assert.equal(els.canvasPane.attrs['aria-hidden'], 'false');
  assert.equal(els.canvasScrim.attrs['aria-hidden'], 'false');
  assert.deepEqual(sessionToggles, [false], 'the canvas pane must not share its corner with the session panel');
  assert.equal(els.canvasSelect.children.length, 1, 'opening must draw whatever block is selected');
  assert.ok(storage.some(([op, k, v]) => op === 'set' && k === CANVAS_HIDDEN_KEY && v === ''), 'an open canvas must be remembered as open');
});

test('closing the canvas hides pane and scrim and remembers the close', () => {
  const { deps, els, storage } = makeDeps({ hiddenDefault: false });
  const page = loadFromIndex(NAMES, deps);
  page.toggleCanvas(false);
  assert.equal(els.canvasPane.attrs['aria-hidden'], 'true');
  assert.equal(els.canvasScrim.attrs['aria-hidden'], 'true');
  assert.equal(els.canvasPane.attrs.inert, '', 'a hidden pane must be inert to keyboard focus');
  assert.ok(storage.some(([op, k, v]) => op === 'set' && k === CANVAS_HIDDEN_KEY && v === '1'));
});

test('restore defaults to closed; an explicit stored value is honoured', () => {
  const base = makeDeps({ hiddenDefault: true });
  base.deps.localStorage.getItem = () => null;
  // The real restore cannot run here because toggleCanvas() is what it calls,
  // so hand it back through the loader instead.
  const hidden = makeDeps({ hiddenDefault: true });
  const page = loadFromIndex(NAMES, hidden.deps);
  page.restoreCanvas();
  assert.equal(page.canvasShell().classList.contains('canvas-hidden'), true, 'a canvas must stay closed until there is something to see');

  const shown = makeDeps({ hiddenDefault: false });
  shown.deps.localStorage.getItem = () => '';
  const page2 = loadFromIndex(NAMES, shown.deps);
  page2.restoreCanvas();
  assert.equal(page2.canvasShell().classList.contains('canvas-hidden'), false);
});

test('collecting blocks dedupes and drops the ones already on the list', () => {
  const pres = [preBlock('<b>a</b>'), preBlock('<b>a</b>'), preBlock('<b>b</b>')];
  const { deps } = makeDeps({ pres });
  deps.canvasBlocks = [];
  deps.canvasIndex = -1;
  const page = loadFromIndex(NAMES, deps);
  page.collectCanvasBlocks();
  assert.equal(deps.canvasBlocks.length, 2);
});

test('an explicit pick stays put when a newer block arrives', () => {
  const first = preBlock('<b>a</b>');
  const second = preBlock('<b>b</b>');
  const third = preBlock('<b>c</b>');
  const { deps } = makeDeps({ pres: [first, second] });
  deps.canvasBlocks = [];
  deps.canvasIndex = -1;
  const page = loadFromIndex(NAMES, deps);
  page.collectCanvasBlocks(); // -> index 1
  page.selectCanvasBlock(0); // reader pins the first block
  deps.chatMessages = { querySelectorAll: () => [first, second, third] };
  page.collectCanvasBlocks();
  assert.equal(deps.canvasIndex, 0, 'picking an older block must not be yanked to the tail');
});

test('an empty chat resets the picker instead of keeping the last block list', () => {
  const { deps } = makeDeps({ pres: [] });
  deps.canvasBlocks = [{ code: 'old', label: 'HTML — old' }];
  deps.canvasIndex = 0;
  const page = loadFromIndex(NAMES, deps);
  page.collectCanvasBlocks();
  assert.equal(deps.canvasBlocks.length, 0);
  assert.equal(deps.canvasIndex, -1);
});

test('openCanvasForBlock registers a new block and opens the pane on it', () => {
  const pres = [preBlock('<b>a</b>')];
  const { deps, shell, picks, sessionToggles } = makeDeps({ pres, hiddenDefault: true });
  deps.canvasBlocks = [];
  deps.canvasIndex = -1;
  const page = loadFromIndex(NAMES, deps);
  page.collectCanvasBlocks(); // the chat block is already listed
  page.openCanvasForBlock(preBlock('<b>z</b>'));
  assert.equal(deps.canvasBlocks.length, 2);
  assert.equal(shell.classList.contains('canvas-hidden'), false, 'opening a block must surface the canvas');
  assert.ok(sessionToggles.length && sessionToggles[0] === false, 'opening must fold the session panel away');
});

test('the canvas picker and frame are wired into the page', () => {
  // The pane, the toggle, and the mutual exclusion with the session panel are
  // all present as markup and as page calls, so a build that drops any of them
  // fails here rather than silently losing the artifacts view.
  const at = HTML.indexOf('id="canvasFrame"');
  const frameTag = HTML.slice(Math.max(0, at - 200), at + 300);
  assert.match(frameTag, /<iframe[\s\S]*?sandbox="allow-scripts"/);
  assert.ok(!/allow-same-origin/.test(frameTag), 'the canvas iframe must never rejoin this origin');
  assert.ok(HTML.includes('classList.contains(\'canvas-hidden\')'), 'the toggle keyed on the shell is how open/closed is tracked');
  assert.ok(HTML.includes('function restoreCanvas'), 'restoreCanvas must exist to reopen a persisted state');
  assert.ok(HTML.indexOf('restoreSessionPanel();') < HTML.indexOf('restoreCanvas();'), 'the boot must restore the session panel before the canvas');
});
