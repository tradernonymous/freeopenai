// The viralai mockup generator, ported (NEURA-070). These tests pin the two
// things that must not drift: viralai's composition constants (the look) and
// the port's deliberate changes (a stable hue, metrics that scale, overflow
// that elides). The measure is arithmetic here -- one character is size/2 px
// -- so wrap and placement are exact numbers, and paint is checked against a
// recorded context rather than a real canvas.
const test = require('node:test');
const assert = require('node:assert/strict');

const mockups = require('../desktop/src/design/mockups.js');

/** One character per half-em, like a monospace face. */
const measure = (text, size) => (text.length * size) / 2;

/** A canvas context that only records what it was asked to draw. */
function recordingCtx() {
  const ops = [];
  return {
    ops,
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect(x, y, w, h) {
      ops.push(['fillRect', this.fillStyle, x, y, w, h]);
    },
    fillText(text, x, y) {
      ops.push(['fillText', this.fillStyle, text, x, y]);
    },
  };
}

test('the composition keeps viralai constants on the 1080 square', () => {
  const p = mockups.plan({ text: 'Hello' }, measure);
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1080);
  assert.equal(p.paper, '#1e1e1e', 'PIL color=(30, 30, 30)');
  assert.equal(p.ink, '#ffffff');
  assert.equal(p.bar, 12, 'the accent bar is 12px');
  assert.equal(p.margin, 80);
  assert.equal(p.font.size, 56, 'DejaVuSans-Bold at 56');
  assert.equal(p.lineHeight, 70, 'the 70px rhythm');
});

test('metrics scale with the width so other formats keep the composition', () => {
  const p = mockups.plan({ text: 'Hello', width: 2160, height: 2700 }, measure);
  assert.equal(p.bar, 24);
  assert.equal(p.margin, 160);
  assert.equal(p.font.size, 112);
  assert.equal(p.lineHeight, 140);
});

test('the same text always gets the same accent, in any process', () => {
  // The port's fix for Python's salted hash(): the hue is a property of the
  // text alone. Same formula (hsv at s 0.6, v 0.5), stable input.
  assert.equal(mockups.accentFor('a stable sentence'), mockups.accentFor('a stable sentence'));
  assert.match(mockups.accentFor('a stable sentence'), /^#[0-9a-f]{6}$/);
  assert.notEqual(mockups.accentFor('a stable sentence'), mockups.accentFor('a different sentence'));
});

test('a single line is block-centred on the 70px rhythm', () => {
  // "One" measures 3 * 28 = 84px; the card centres it at (1080-84)/2 and the
  // one-line block at 1080/2 - 70/2 = 505, exactly where Pillow puts it.
  const p = mockups.plan({ text: 'One' }, measure);
  assert.equal(p.lines.length, 1);
  assert.deepEqual(p.lines[0], { text: 'One', x: 498, y: 505 });
});

test('wrap breaks at the measured width and elides past the line cap', () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
  const lines = mockups.wrap(words.join(' '), 200, (line) => line.length * 10);
  assert.ok(lines.length > 1, 'long copy wraps');
  for (const line of lines) assert.ok(line.length * 10 <= 200 + 10, `"${line}" fits the width`);
  assert.ok(lines.length <= mockups.LIMITS.lines, 'never past the cap');
  assert.ok(lines[lines.length - 1].endsWith('…'), 'the dropped tail is admitted with an ellipsis');
});

test('the empty slide is paper and the accent bar, and nothing else', () => {
  const p = mockups.plan({ text: '' }, measure);
  assert.equal(p.lines.length, 0);
  const ctx = recordingCtx();
  mockups.paint(ctx, p);
  assert.deepEqual(
    ctx.ops.map((op) => op.slice(0, 2)),
    [
      ['fillRect', '#1e1e1e'],
      ['fillRect', p.accent],
    ],
  );
});

test('paint draws paper, then the bar, then the lines from the top edge', () => {
  const p = mockups.plan({ text: 'One' }, measure);
  const ctx = recordingCtx();
  mockups.paint(ctx, p);
  assert.deepEqual(ctx.ops, [
    ['fillRect', '#1e1e1e', 0, 0, 1080, 1080],
    ['fillRect', p.accent, 0, 0, 1080, 12],
    ['fillText', '#ffffff', 'One', 498, 505],
  ]);
  assert.equal(ctx.textBaseline, 'top', 'y is the top of the line box, like Pillow');
  assert.equal(ctx.font, 'bold 56px sans-serif');
});

test('carousel plans one slide per text and stops at the slide cap', () => {
  const texts = Array.from({ length: mockups.LIMITS.slides + 5 }, (_, i) => `Slide ${i}`);
  const plans = mockups.carousel(texts, {}, measure);
  assert.equal(plans.length, mockups.LIMITS.slides);
  assert.equal(plans[0].accent, mockups.accentFor('Slide 0'), 'each slide keeps its own accent');
  assert.notEqual(plans[0].accent, plans[1].accent);
});

test('a palette can be supplied and wins over the derived accent', () => {
  const p = mockups.plan({ text: 'One', paper: '#fafafa', ink: '#111111', accent: '#ff0055' }, measure);
  assert.equal(p.paper, '#fafafa');
  assert.equal(p.ink, '#111111');
  assert.equal(p.accent, '#ff0055');
});

test('copy is bounded by the text limit, whatever the caller sends', () => {
  const p = mockups.plan({ text: 'x'.repeat(mockups.LIMITS.text + 500) }, measure);
  const drawn = p.lines.map((l) => l.text).join('');
  assert.ok(drawn.length <= mockups.LIMITS.text + mockups.LIMITS.lines, 'the render cannot exceed the capped copy');
});
