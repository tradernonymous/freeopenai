// Mermaid diagrams stay behind a tap: the gate, the loader and the render
// each have a failure that must leave the code block exactly where it was.
// Rendered SVG output runs only in a browser, so what is pinned here is the
// contract around it: what may load, what may render, and what every failure
// says. This branch stays unmerged until the SVG output is eyeballed.
const test = require('node:test');
const assert = require('node:assert/strict');

const { HTML, sourceOf, assertScannerCanRead, assertSandboxCovers, loadFromIndex } = require('./helpers/index-html.js');

function realDiagramTypes() {
  const at = HTML.indexOf('const MERMAID_TYPES = [');
  assert.ok(at > 0, 'MERMAID_TYPES is gone -- re-point this test');
  const body = HTML.slice(at, HTML.indexOf('];', at));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the gate accepts known diagram types and rejects prose', () => {
  const deps = { MERMAID_TYPES: realDiagramTypes() };
  assertScannerCanRead(['mermaidDiagramType']);
  assertSandboxCovers(['mermaidDiagramType'], deps);
  const { mermaidDiagramType } = loadFromIndex(['mermaidDiagramType'], deps);
  assert.equal(mermaidDiagramType('graph TD\n  A-->B'), 'graph');
  assert.equal(mermaidDiagramType('sequenceDiagram\n  A->>B: hi'), 'sequenceDiagram');
  assert.equal(mermaidDiagramType('%%{init: {"theme": "dark"}}%%\npie\n  "a": 1'), 'pie');
  assert.equal(mermaidDiagramType('hello world'), null);
  assert.equal(mermaidDiagramType(''), null);
  assert.equal(mermaidDiagramType('click A callback'), null);
});

test('the engine loads vendored, strict, and only on demand', () => {
  assert.ok(
    HTML.includes("const MERMAID_SRC = './vendor/mermaid/mermaid-12.0.0.mjs'"),
    'the loader must point at the vendored bytes, never a CDN',
  );
  assert.ok(!HTML.includes('cdn.jsdelivr'), 'no CDN script may join the diagram path');
  assert.ok(HTML.includes("securityLevel: 'strict'"), 'the engine must sanitise labels');
  const render = sourceOf('renderDiagram');
  assert.match(render, /mermaidDiagramType\(code\)/, 'rendering without the gate loads the engine for prose');
  assert.match(render, /ensureMermaid\(\)/);
  assert.match(render, /api\.render\(/);
  assert.match(render, /the code is untouched/, 'every failure must say the code survived');
  const ensure = sourceOf('ensureMermaid');
  assert.match(ensure, /import\(MERMAID_SRC\)/, 'the engine must arrive as a module, loadable on demand');
});

function diagramDeps(overrides) {
  const shown = [];
  const deps = Object.assign(
    {
      mermaidDiagramType: () => 'graph',
      ensureMermaid: async () => {
        throw new Error('no engine in unit tests');
      },
      showStatus: (kind, text) => shown.push(kind + ': ' + text),
      document: {
        createElement: () => ({
          className: '',
          textContent: '',
          attrs: {},
          setAttribute() {},
          appendChild() {},
        }),
      },
    },
    overrides,
  );
  return { shown, deps };
}

test('a rejected block never touches the engine or the holder', async () => {
  const { shown, deps } = diagramDeps({
    mermaidDiagramType: () => null,
    ensureMermaid: () => {
      throw new Error('must not load');
    },
  });
  assertSandboxCovers(['renderDiagram'], deps);
  const { renderDiagram } = loadFromIndex(['renderDiagram'], deps);
  const holder = {
    innerHTML: 'x',
    hidden: true,
    appended: [],
    appendChild(node) { this.appended.push(node); },
  };
  await renderDiagram(holder, 'hello world');
  assert.equal(holder.appended.length, 0);
  assert.match(shown[0], /^error: That block is not a diagram/);
});

test('an engine that will not load hides the holder and says the code survived', async () => {
  const { shown, deps } = diagramDeps({});
  assertSandboxCovers(['renderDiagram'], deps);
  const { renderDiagram } = loadFromIndex(['renderDiagram'], deps);
  const holder = { innerHTML: '', hidden: false, appendChild() {} };
  await renderDiagram(holder, 'graph TD');
  assert.equal(holder.hidden, true);
  assert.match(shown[0], /code is untouched/);
});

test('a drawn diagram lands in the holder and unhides it', async () => {
  const api = { render: async (id, code) => ({ svg: '<svg>' + code + '</svg>' }) };
  const { shown, deps } = diagramDeps({
    ensureMermaid: async () => api,
    document: {
      createElement: (tag) => ({
        tag,
        className: '',
        textContent: '',
        innerHTML: '',
        attrs: {},
        setAttribute(name, value) { this.attrs[name] = value; },
        appendChild(child) { (this.kids = this.kids || []).push(child); },
      }),
    },
  });
  assertSandboxCovers(['renderDiagram'], deps);
  const { renderDiagram } = loadFromIndex(['renderDiagram'], deps);
  const holder = {
    innerHTML: 'old',
    hidden: true,
    kids: [],
    appendChild(node) { this.kids.push(node); },
  };
  await renderDiagram(holder, 'graph TD');
  assert.equal(holder.hidden, false);
  const wrap = holder.kids[holder.kids.length - 1];
  assert.equal(wrap.className, 'diagram-svg');
  assert.match(wrap.innerHTML, /<svg>graph TD<\/svg>/);
  assert.equal(shown.length, 0);
});

test('tapping Diagram twice draws, then puts the drawing away', () => {
  const appended = [];
  const parentInserts = [];
  const renders = [];
  const pre = {
    dataset: { lang: 'mermaid' },
    firstChild: null,
    nextSibling: null,
    querySelector(sel) { return sel === 'code' ? { textContent: 'graph TD' } : null; },
    appendChild(node) { appended.push(node); },
    insertBefore(node) { appended.push(node); },
    parentNode: {
      insertBefore(node, ref) { parentInserts.push([node, ref]); },
    },
  };
  const textEl = {
    innerHTML: '',
    querySelectorAll(sel) { return sel === 'pre' ? [pre] : []; },
  };
  const el = {
    dataset: {},
    querySelector(sel) { return sel === '.message-text' ? textEl : null; },
  };
  const deps = {
    renderMarkdownLite: (content) => content,
    copyText: () => {},
    openHtmlPreview: () => {},
    renderDiagram: (holder, code) => renders.push([holder, code]),
    document: {
      createElement: (tag) => ({
        tag,
        className: '',
        textContent: '',
        hidden: false,
        innerHTML: '',
        attrs: {},
        setAttribute(name, value) { this.attrs[name] = value; },
        addEventListener(type, fn) { (this.handlers = this.handlers || {})[type] = fn; },
      }),
    },
  };
  assertScannerCanRead(['setMessageContent']);
  assertSandboxCovers(['setMessageContent'], deps);
  const { setMessageContent } = loadFromIndex(['setMessageContent'], deps);
  setMessageContent(el, '```mermaid\ngraph TD\n```');
  const draw = appended.find((node) => node.className === 'code-diagram-btn');
  assert.ok(draw, 'the mermaid block has no Diagram button');
  draw.handlers.click();
  assert.equal(renders.length, 1);
  assert.equal(renders[0][1], 'graph TD');
  const holder = renders[0][0];
  assert.equal(holder.className, 'diagram-wrap');
  assert.equal(pre._diagramHolder, holder);
  draw.handlers.click();
  assert.equal(renders.length, 1, 'a second tap puts the drawing away instead of redrawing');
  assert.equal(pre._diagramHolder, null);
  assert.equal(holder.hidden, true);
});
