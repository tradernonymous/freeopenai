'use strict';

// NeuraOS design tokens (docs/neuraos-rebrand-plan.md, R0): the generated
// files match design/tokens.json, and every colour pair the apps put text on
// meets WCAG AA in both themes. The desktop already swept its accent hues this
// way (desktop-look.test.js); this makes it true for every app at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { render, readTokens, themes, contrast } = require('../scripts/tokens.js');

test('the generated CSS and Kotlin match design/tokens.json (run `npm run tokens`)', () => {
  for (const [file, text] of Object.entries(render())) {
    assert.ok(fs.existsSync(file), 'missing ' + file);
    assert.equal(fs.readFileSync(file, 'utf8'), text, file + ' is stale: run `npm run tokens`');
  }
});

// [foreground, background, minimum]: 4.5 for text, 3 for a control's boundary
// or a large accent mark.
const PAIRS = [
  ['text', 'bg', 4.5], ['text', 'surface', 4.5], ['text', 'raised', 4.5], ['text', 'accentSoft', 4.5],
  ['muted', 'bg', 4.5], ['muted', 'surface', 4.5], ['muted', 'raised', 4.5],
  ['accent', 'bg', 4.5], ['accent', 'surface', 4.5], ['accent', 'raised', 4.5],
  ['onAccent', 'accent', 4.5],
  ['danger', 'bg', 4.5], ['danger', 'surface', 4.5],
  ['warning', 'bg', 4.5], ['warning', 'surface', 4.5],
  ['success', 'surface', 4.5], ['info', 'surface', 4.5],
  ['text', 'code', 4.5],
  ['line', 'bg', 3], ['line', 'surface', 3], ['line', 'raised', 3],
  ['glow', 'bg', 3],
];

for (const [theme, list] of Object.entries(themes(readTokens()))) {
  test(`${theme} theme: every text colour meets WCAG AA on what it is drawn on`, () => {
    const colors = Object.fromEntries(list);
    for (const [fg, bg, min] of PAIRS) {
      const ratio = contrast(colors[fg], colors[bg]);
      assert.ok(ratio >= min, `${theme}: ${fg} ${colors[fg]} on ${bg} ${colors[bg]} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
    }
  });
}

test('both themes name the same colours, and every colour is #RRGGBB', () => {
  const all = themes(readTokens());
  assert.deepEqual(all.dark.map(([name]) => name), all.light.map(([name]) => name));
  assert.throws(() => themes({ color: { dark: { a: { $value: 'red' } }, light: { a: { $value: '#000000' } } } }), /#RRGGBB/);
  assert.throws(() => themes({ color: { dark: { a: { $value: '#000000' } }, light: { b: { $value: '#000000' } } } }), /same colours/);
});

test('contrast math matches the WCAG reference points', () => {
  assert.equal(contrast('#000000', '#FFFFFF').toFixed(2), '21.00');
  assert.equal(contrast('#777777', '#FFFFFF').toFixed(2), '4.48');
});
