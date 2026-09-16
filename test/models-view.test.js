// The Models view is a card grid, and a grid with dozens of rows needs the
// same filter the dropdown already has. Plus the removal of a dead control:
// the pre-rewrite size picker whose state nothing ever read.
const test = require('node:test');
const assert = require('node:assert/strict');

const { HTML, sourceOf, assertScannerCanRead, assertSandboxCovers, loadFromIndex } = require('./helpers/index-html.js');

test('the dead size picker is gone, markup and state', () => {
  // Sizes now come from the prompt's own words (imageSizeFromPrompt) with a
  // live hint; the picker buttons wrote a variable nothing read, defaulting
  // to a Cover the requests never sent.
  assert.ok(!HTML.includes('image-size-picker'), 'the picker markup is back');
  assert.ok(!HTML.includes('selectSize'), 'the picker handler is back');
  assert.ok(!HTML.includes('selectedImageSize'), 'the picker state is back');
});

test('the Models view filters through the shared search control', () => {
  assert.match(HTML, /id="modelCardSearch"[^>]*oninput="filterModelCards\(this\.value\)"/, 'the view needs a wired search box');
  assert.match(HTML, /class="model-dropdown-search models-search"/, 'the box reuses the one search look');
  const render = sourceOf('renderModelOptions');
  assert.match(render, /filterModelCards\(cardSearch\.value\)/, 'a re-render must not forget the filter');
});

function cardHarness(names) {
  const cards = names.map((textContent) => ({ textContent, hidden: false }));
  let empty = null;
  const modelsList = {
    querySelectorAll(sel) { return sel === '.model-card' ? cards : []; },
    querySelector(sel) { return sel === '.models-empty' ? empty : null; },
    appendChild(node) { empty = node; },
  };
  const deps = {
    modelsList,
    document: {
      createElement: (tag) => ({ tag, className: '', textContent: '', hidden: false }),
    },
  };
  assertScannerCanRead(['filterModelCards']);
  assertSandboxCovers(['filterModelCards'], deps);
  return { cards, deps, getEmpty: () => empty, loaded: loadFromIndex(['filterModelCards'], deps) };
}

test('filterModelCards hides what does not match and names the empty grid', () => {
  const run = cardHarness(['agnes-2.5-flash', 'stepfun-3.7-flash']);
  run.loaded.filterModelCards('agnes');
  assert.equal(run.cards[0].hidden, false);
  assert.equal(run.cards[1].hidden, true);
  assert.equal(run.getEmpty(), null);
  run.loaded.filterModelCards('zzz-no-such-model');
  assert.equal(run.cards[0].hidden, true);
  assert.equal(run.cards[1].hidden, true);
  assert.equal(run.getEmpty().textContent, 'No model matches that.');
  run.loaded.filterModelCards('');
  assert.equal(run.cards[0].hidden, false);
  assert.equal(run.cards[1].hidden, false);
  assert.equal(run.getEmpty().hidden, true);
});
