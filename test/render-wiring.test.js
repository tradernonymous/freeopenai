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
