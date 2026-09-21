// The message renderer is a library, but the code-block header (a language
// chip beside the Copy button) is page wiring: the chip only appears when
// setMessageContent reads the data-lang the renderer tagged the block with.
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdownLite } = require('../chatlib.js');
const { assertScannerCanRead, assertSandboxCovers, loadFromIndex } = require('./helpers/index-html.js');

function makeNode(tag) {
  return {
    tag,
    className: '',
    textContent: '',
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener() {},
  };
}

function runSetMessageContent(content, langs) {
  // langs holds the data-lang of each <pre> the rendered HTML carries, so the
  // fakes agree with what the real renderer emitted for this content.
  const appended = [];
  const inserted = [];
  const pres = langs.map((lang) => ({
    dataset: lang ? { lang } : {},
    firstChild: null,
    querySelector(sel) { return sel === 'code' ? { textContent: 'code' } : null; },
    appendChild(node) { appended.push(node); },
    insertBefore(node, ref) { inserted.push([node, ref]); },
  }));
  const textEl = {
    innerHTML: '',
    querySelectorAll(sel) {
      if (sel === 'pre') return pres;
      // setMessageContent checks whether a completed canvas-eligible block is
      // on screen to resync the canvas picker; only blocks that actually
      // carry a data-lang qualify, same as the real DOM selector.
      if (sel === 'pre[data-lang]') return pres.filter((p) => p.dataset && p.dataset.lang);
      return [];
    },
  };
  const el = {
    dataset: {},
    querySelector(sel) { return sel === '.message-text' ? textEl : null; },
  };
  const deps = {
    renderMarkdownLite,
    copyText: () => {},
    // The Preview and Diagram buttons delegate to staging functions with
    // their own tests -- here they are only collaborators that must exist.
    openHtmlPreview: () => {},
    renderDiagram: () => {},
    // The Canvas button and picker resync are page wiring with their own
    // tests; for the renderer they are collaborators that must exist.
    openCanvasForBlock: () => {},
    collectCanvasBlocks: () => {},
    CANVAS_ARTIFACT_LANGS: ['html', 'jsx', 'tsx', 'js', 'javascript'],
    document: { createElement: (tag) => makeNode(tag) },
  };
  assertScannerCanRead(['setMessageContent']);
  assertSandboxCovers(['setMessageContent'], deps);
  const { setMessageContent } = loadFromIndex(['setMessageContent'], deps);
  setMessageContent(el, content);
  return { el, textEl, appended, inserted };
}

test('a fenced block with a language gets a language chip plus the Copy button', () => {
  // python is deliberately not a canvas-eligible language here, so this stays
  // a test of the generic chip+Copy wiring rather than colliding with the
  // canvas button gate covered separately below.
  const run = runSetMessageContent('```python\nx = 1\n```', ['python']);
  assert.equal(run.el.dataset.rawContent, '```python\nx = 1\n```');
  assert.match(run.textEl.innerHTML, /data-lang="python"/);
  assert.equal(run.inserted.length, 1);
  assert.equal(run.inserted[0][0].className, 'code-lang');
  assert.equal(run.inserted[0][0].textContent, 'python');
  assert.equal(run.appended.length, 1);
  assert.equal(run.appended[0].className, 'code-copy-btn');
});

test('a fenced block without a language gets only the Copy button', () => {
  const run = runSetMessageContent('```\nplain\n```', [null]);
  assert.match(run.textEl.innerHTML, /<pre><code>plain<\/code><\/pre>/);
  assert.equal(run.inserted.length, 0);
  assert.equal(run.appended.length, 1);
  assert.equal(run.appended[0].textContent, 'Copy');
});

test('html and jsx/js blocks get a Preview and a Canvas button; other languages do not', () => {
  const html = runSetMessageContent('```html\n<b>hi</b>\n```', ['html']);
  const htmlLabels = html.appended.map((node) => node.textContent);
  assert.ok(htmlLabels.includes('Preview'), 'the HTML block has no way to show itself');
  assert.ok(htmlLabels.includes('Canvas'), 'the HTML block has no way to reach the canvas');
  assert.ok(htmlLabels.includes('Copy'));
  const jsx = runSetMessageContent('```jsx\nconst App = () => <b>hi</b>;\n```', ['jsx']);
  const jsxLabels = jsx.appended.map((node) => node.textContent);
  assert.ok(jsxLabels.includes('Preview'), 'a jsx fence is canvas-eligible too, not html-only');
  assert.ok(jsxLabels.includes('Canvas'));
  const python = runSetMessageContent('```python\nx = 1\n```', ['python']);
  const pyLabels = python.appended.map((node) => node.textContent);
  assert.ok(!pyLabels.includes('Preview'), 'python cannot run in the sandbox, so it must not offer to');
  assert.ok(!pyLabels.includes('Canvas'), 'python cannot run in the sandbox, so it must not offer the canvas');
});

test('a mermaid block gets a Diagram button; other languages do not', () => {
  const mm = runSetMessageContent('```mermaid\ngraph TD\n```', ['mermaid']);
  assert.ok(mm.appended.map((node) => node.textContent).includes('Diagram'), 'the diagram has no way to draw itself');
  const js = runSetMessageContent('```js\nconst x = 1;\n```', ['js']);
  assert.ok(!js.appended.map((node) => node.textContent).includes('Diagram'));
});

function runHtmlPreview(code, lang) {
  const added = [];
  let current = null;
  function makeNode(tag) {
    return {
      tag,
      className: '',
      textContent: '',
      id: '',
      children: [],
      attrs: {},
      removed: false,
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener() {},
      appendChild(node) { this.children.push(node); },
      remove() { this.removed = true; },
    };
  }
  const fakeDocument = {
    createElement: (tag) => makeNode(tag),
    body: { appendChild: (node) => added.push(node) },
    getElementById: (id) => (current && current.id === id ? current : null),
  };
  const deps = { document: fakeDocument, artifactDocument: (c) => '<!--artifact-->' + c };
  assertScannerCanRead(['openHtmlPreview', 'closeHtmlPreview']);
  assertSandboxCovers(['openHtmlPreview', 'closeHtmlPreview'], deps);
  const page = loadFromIndex(['openHtmlPreview', 'closeHtmlPreview'], deps);
  page.openHtmlPreview(code, lang);
  current = added[0];
  return { page, overlay: current, added };
}

test('openHtmlPreview stages the snippet in an opaque-origin frame', () => {
  // The sandbox value is the whole security story: allow-scripts without
  // allow-same-origin means an opaque origin -- no parent DOM, no cookies,
  // no storage. Anything else here is a containment failure, not a feature.
  const { overlay } = runHtmlPreview('<b>hi</b>');
  assert.equal(overlay.className, 'modal-overlay');
  assert.equal(overlay.id, 'htmlPreviewOverlay');
  const dialog = overlay.children[0];
  const frame = dialog.children[dialog.children.length - 1];
  assert.equal(frame.tag, 'iframe');
  assert.equal(frame.attrs.sandbox, 'allow-scripts');
  assert.ok(!frame.attrs.sandbox.includes('same-origin'), 'the frame must never rejoin this origin');
  assert.equal(frame.srcdoc, '<b>hi</b>');
});

test('openHtmlPreview routes a non-html language through the artifact document builder', () => {
  const { overlay } = runHtmlPreview('const App = () => <h1>hi</h1>;', 'jsx');
  const dialog = overlay.children[0];
  const frame = dialog.children[dialog.children.length - 1];
  assert.equal(frame.srcdoc, '<!--artifact-->const App = () => <h1>hi</h1>;', 'a jsx fence is not valid HTML on its own, so it must go through the builder');
});

test('closeHtmlPreview removes the stage', () => {
  const { page, overlay } = runHtmlPreview('x');
  assert.equal(overlay.removed, false);
  page.closeHtmlPreview();
  assert.equal(overlay.removed, true);
  page.closeHtmlPreview();
});
