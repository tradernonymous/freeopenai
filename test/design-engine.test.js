// The brand engine and the anti-slop linter: pure modules, exercised here the
// same way the app runs them. A design tool that preaches contrast must pass
// its own contrast tests, and a linter that flags slop must not be slop.
const test = require('node:test');
const assert = require('node:assert/strict');

const brand = require('../desktop/src/design/brand.js');
const slop = require('../desktop/src/design/slop.js');

// ---- color + contrast ------------------------------------------------------

test('color parsing covers the forms a page actually ships', () => {
  assert.deepEqual(brand.parseColor('#ff0000'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(brand.parseColor('#f00'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(brand.parseColor('rgb(16, 32, 64)'), { r: 16, g: 32, b: 64 });
  assert.equal(brand.parseColor('not-a-color'), null);
  assert.equal(brand.parseColor(''), null);
  assert.equal(brand.parseColor(null), null);
});

test('contrast ratio matches the WCAG reference values', () => {
  // Black on white is the ceiling: exactly 21.
  assert.equal(brand.contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(brand.contrastRatio('#ffffff', '#000000'), 21, 'order does not matter');
  // The classic AA example: #767676 gray on white is 4.54.
  const ratio = brand.contrastRatio('#767676', '#ffffff');
  assert.ok(ratio > 4.5 && ratio < 4.6, 'expected ~4.54, got ' + ratio);
  assert.equal(brand.contrastRatio('nope', '#ffffff'), null, 'unparseable input says so');
});

test('contrast reports name which tiers pass', () => {
  const good = brand.contrastReport('#000000', '#ffffff');
  assert.equal(good.passAA, true);
  assert.equal(good.passAAA, true);
  const mid = brand.contrastReport('#767676', '#ffffff');
  assert.equal(mid.passAA, true);
  assert.equal(mid.passAAA, false, '4.5:1 is AA, not AAA');
  const bad = brand.contrastReport('#cccccc', '#ffffff');
  assert.equal(bad.passAA, false);
  assert.equal(bad.passAALarge, false, '1.6:1 fails even the large-text tier');
});

test('palette extraction prefers what the page repeats', () => {
  const html = `
    <style>
      body { background: #f8f7f4; color: #1a1a2e; }
      .btn { background: #e63946; color: #f8f7f4; }
      .btn:hover { background: #e63946; }
      .badge { background: #e63946; }
      a { color: #1a1a2e; }
    </style>`;
  const palette = brand.paletteFromText(html);
  assert.ok(palette.includes('#e63946'), 'the repeated button color leads or follows, but is found');
  assert.equal(palette[palette.length - 1] === '#e63946' || palette[0] === '#e63946', true, 'the most frequent color ranks first among ties broken by insertion');
  assert.ok(palette.indexOf('#e63946') < palette.indexOf('#1a1a2e'), 'twice-repeated outranks once-used');
  assert.ok(palette.length <= 8);
  assert.deepEqual(brand.paletteFromText('no colors here'), []);
});

test('semantic roles assign paper, ink and accent sensibly', () => {
  const roles = brand.semanticRoles(['#f8f7f4', '#1a1a2e', '#e63946']);
  assert.equal(roles.paper, '#f8f7f4', 'lightest becomes paper');
  assert.equal(roles.ink, '#1a1a2e', 'darkest becomes ink');
  assert.equal(roles.accent, '#e63946', 'the most saturated remaining color becomes accent');
  assert.ok(roles.muted);
  assert.equal(brand.semanticRoles([]), null);
});

test('DESIGN.md renders the contract the model and the human share', () => {
  const md = brand.designMd({ palette: ['#f8f7f4', '#1a1a2e', '#e63946'], fontStack: '"Iowan Old Style", serif', url: 'https://example.com' }, 'Poster');
  assert.match(md, /# DESIGN\.md — Poster/);
  assert.match(md, /#e63946 \(crimson\)/, 'colors get their nearest name');
  assert.match(md, /paper \(background\): #f8f7f4/);
  assert.match(md, /Iowan Old Style/);
  assert.match(md, /"passAA":true/, 'the contrast verdicts are in the document, not on trust');
  const empty = brand.designMd({}, 'Nothing');
  assert.match(empty, /No brand extracted yet/);
});

// ---- anti-slop -------------------------------------------------------------

test('clean, decided HTML scores 100', () => {
  const clean = `
    <html><head><style>
      body { background: #f8f7f4; color: #1a1a2e; font-family: "Iowan Old Style", serif; }
      .cta { background: #b3261e; color: #fdfcf9; }
      .cta:focus-visible { outline: 2px solid #1a1a2e; outline-offset: 2px; }
    </style></head>
    <body><h1>Field notes from the dock</h1>
    <button class="cta">Read the report</button></body></html>`;
  const { findings, score } = slop.score(clean);
  assert.deepEqual(findings, []);
  assert.equal(score, 100);
});

test('the linter catches the classic generated tells', () => {
  const offender = `
    <div class="hero" style="background: linear-gradient(to right, #7c3aed, #3b82f6);">
      <h1 style="font-family: Inter, sans-serif;">Welcome</h1>
      <div class="card"><div class="card">nested</div></div>
      <span>🚀</span>
      <p>Lorem ipsum dolor sit amet.</p>
    </div>`;
  const { findings, score } = slop.score(offender);
  const ids = findings.map((f) => f.id);
  assert.ok(ids.includes('gradient-splash'), 'purple-blue gradient flagged');
  assert.ok(ids.includes('inter-display'), 'Inter as display flagged');
  assert.ok(ids.includes('card-in-card'), 'nested cards flagged');
  assert.ok(ids.includes('emoji-icons'), 'emoji icon flagged');
  assert.ok(ids.includes('generic-copy'), 'placeholder copy flagged');
  assert.ok(score < 60, 'many findings cost real score, got ' + score);
  for (const f of findings) {
    assert.ok(f.fix && f.fix.length > 10, 'every finding names its fix: ' + f.id);
  }
});

test('gradient overuse is flagged even without purple', () => {
  const src = `
    <style>
      .a { background: linear-gradient(#111, #222); }
      .b { background: linear-gradient(#333, #444); }
      .c { background: linear-gradient(#555, #666); }
      .d { background: linear-gradient(#777, #888); }
    </style>`;
  const ids = slop.lint(src).map((f) => f.id);
  assert.ok(ids.includes('gradient-count'));
});

test('emoji inside code samples is not an icon violation', () => {
  const doc = '<pre><code>git commit -m "ship it 🚀"</code></pre>';
  assert.deepEqual(slop.lint(doc), []);
});

// The same principle one rule over: a prompt that FORBIDS placeholder copy is
// not placeholder copy. Flagging it made the linter unusable on the design
// screen's own system prompt, which is why the rule now reads what precedes it.
test('an instruction to avoid placeholder copy is not placeholder copy', () => {
  for (const instruction of [
    'Write a self-contained page (no external assets, no lorem ipsum).',
    'A real document, never lorem ipsum, with one sentence per block.',
    'Use real copy, not "your text here".',
    'Avoid placeholder text in the output.',
  ]) {
    assert.deepEqual(slop.lint(instruction).filter((f) => f.id === 'generic-copy'), [], instruction);
  }
});

test('placeholder copy actually shipped is still flagged', () => {
  for (const shipped of [
    '<p>Lorem ipsum dolor sit amet.</p>',
    '<h1>Your content here</h1>',
    '<div>placeholder text</div>',
    // "and" is not a negation, so this one stands.
    '<p>No border, and lorem ipsum body copy.</p>',
  ]) {
    assert.ok(
      slop.lint(shipped).some((f) => f.id === 'generic-copy'),
      shipped,
    );
  }
});

test('every rule carries the fields the UI renders', () => {
  for (const rule of slop.RULES) {
    assert.ok(rule.id && rule.label && rule.why && rule.fix, rule.id + ' is complete');
  }
});
