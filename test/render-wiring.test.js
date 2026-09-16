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
    querySelectorAll(sel) { return sel === 'pre' ? pres : []; },
  };
  const el = {
    dataset: {},
    querySelector(sel) { return sel === '.message-text' ? textEl : null; },
  };
  const deps = {
    renderMarkdownLite,
    copyText: () => {},
    // The Preview button delegates to the staging function, which has its
    // own tests below -- here it is only a collaborator that must exist.
    openHtmlPreview: () => {},
    document: { createElement: (tag) => makeNode(tag) },
  };
  assertScannerCanRead(['setMessageContent']);
  assertSandboxCovers(['setMessageContent'], deps);
  const { setMessageContent } = loadFromIndex(['setMessageContent'], deps);
  setMessageContent(el, content);
  return { el, textEl, appended, inserted };
}

test('a fenced block with a language gets a language chip plus the Copy button', () => {
  const run = runSetMessageContent('```js\nconst x = 1;\n```', ['js']);
  assert.equal(run.el.dataset.rawContent, '```js\nconst x = 1;\n```');
  assert.match(run.textEl.innerHTML, /data-lang="js"/);
  assert.equal(run.inserted.length, 1);
  assert.equal(run.inserted[0][0].className, 'code-lang');
  assert.equal(run.inserted[0][0].textContent, 'js');
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

test('an HTML block gets a Preview button; other languages do not', () => {
  const html = runSetMessageContent('```html\n<b>hi</b>\n```', ['html']);
  const labels = html.appended.map((node) => node.textContent);
  assert.ok(labels.includes('Preview'), 'the HTML block has no way to show itself');
  assert.ok(labels.includes('Copy'));
  const js = runSetMessageContent('```js\nconst x = 1;\n```', ['js']);
  assert.ok(!js.appended.map((node) => node.textContent).includes('Preview'), 'a JS block cannot run here, so it must not offer to');
});

function runHtmlPreview(code) {
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
  const deps = { document: fakeDocument };
  assertScannerCanRead(['openHtmlPreview', 'closeHtmlPreview']);
  assertSandboxCovers(['openHtmlPreview', 'closeHtmlPreview'], deps);
  const page = loadFromIndex(['openHtmlPreview', 'closeHtmlPreview'], deps);
  page.openHtmlPreview(code);
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

test('closeHtmlPreview removes the stage', () => {
  const { page, overlay } = runHtmlPreview('x');
  assert.equal(overlay.removed, false);
  page.closeHtmlPreview();
  assert.equal(overlay.removed, true);
  page.closeHtmlPreview();
});
