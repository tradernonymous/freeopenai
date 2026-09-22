// Phase 9: the Design studio leftovers. The protocol and the pure modules
// (tweaks, stage, the extended gate, critique, diagram layout, exports and
// the social templates) are tested directly; DesignScreen.tsx and
// CodeScreen.tsx are held to wiring them the way the sandbox and the
// local-first rules require.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// systems.js first: prompt.js reads its global at call time, as in the app.
const systems = require('../desktop/src/design/systems.js');
const prompt = require('../desktop/src/design/prompt.js');
const artifact = require('../desktop/src/design/artifact.js');
const slop = require('../desktop/src/design/slop.js');
const brand = require('../desktop/src/design/brand.js');
const tweaks = require('../desktop/src/design/tweaks.js');
const stage = require('../desktop/src/design/stage.js');
const critique = require('../desktop/src/design/critique.js');
const diagram = require('../desktop/src/design/diagram-layout.js');
const exportsLib = require('../desktop/src/design/exports.js');
const social = require('../desktop/src/design/social.js');

const SRC = path.join(__dirname, '..', 'desktop', 'src');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8').replace(/\r\n/g, '\n');
const SCREEN = read('screens', 'DesignScreen.tsx');
const CODE = read('screens', 'CodeScreen.tsx');

const SCHEMA = {
  version: 1,
  controls: [
    { var: '--accent', label: 'Accent', type: 'color', default: '#2F6F4F' },
    { var: '--size', label: 'Title size', type: 'slider', min: 24, max: 96, step: 4, unit: 'px', default: 48 },
    { var: '--dense', label: 'Dense', type: 'toggle', on: '0.75', off: '1', default: false },
    { var: '--layout', label: 'Layout', type: 'select', options: [{ value: 'grid', label: 'Grid' }, 'list'], default: 'list' },
  ],
};

const PAGE = `<!DOCTYPE html><html><head><style>:root{--paper:#f6f5f1;--ink:#1b1c1a;--accent:#2f6f4f;--space:8px}
body{background:var(--paper);color:var(--ink)} a:focus-visible{outline:2px solid var(--accent)}
/* neura-tweaks:start */:root{--accent:#a63a24;--size:40px;}/* neura-tweaks:end */</style>
<script type="application/neura-tweaks+json">${JSON.stringify(SCHEMA)}</script></head>
<body><main><h1>Quarterly field notes</h1><a href="#more">More</a></main></body></html>`;

// ---- 4.8 tweaks protocol ---------------------------------------------------

test('a tweaks schema is validated strictly', () => {
  const s = tweaks.validateSchema(SCHEMA);
  assert.equal(s.version, 1);
  assert.deepEqual(s.controls.map((c) => c.type), ['color', 'slider', 'toggle', 'select']);
  assert.equal(s.controls[0].default, '#2f6f4f', 'colours are normalised');
  assert.deepEqual(s.controls[3].options.map((o) => o.value), ['grid', 'list']);
  const messy = tweaks.validateSchema({
    version: 1,
    controls: [
      { var: '--ok', type: 'color' },
      { var: '--ok', type: 'slider', min: 0, max: 1 },
      { var: 'accent', type: 'color' },
      { var: '--x;}body{', type: 'color' },
      { var: '--knob', type: 'knob' },
      { var: '--flat', type: 'slider', min: 5, max: 5 },
      { var: '--bad-unit', type: 'slider', min: 0, max: 9, unit: 'px;}' },
      { var: '--one', type: 'select', options: ['only'] },
      ...Array.from({ length: 12 }, (_, i) => ({ var: `--c${i}`, type: 'color', default: '#123456' })),
    ],
  });
  assert.equal(messy.controls.length, tweaks.MAX_CONTROLS, 'clamped to eight');
  assert.equal(messy.controls.filter((c) => c.var === '--ok').length, 1, 'a repeated variable keeps its first control');
  assert.ok(messy.controls.every((c) => /^--[a-zA-Z][\w-]*$/.test(c.var)), 'only --custom-property names');
  assert.ok(messy.controls.every((c) => tweaks.TYPES.includes(c.type)), 'unknown types dropped');
  assert.equal(tweaks.validateSchema({ version: 2, controls: SCHEMA.controls }), null, 'another protocol version is refused');
  assert.equal(tweaks.validateSchema('not json'), null);
  assert.equal(tweaks.validateSchema({ controls: [{ var: '--a', type: 'knob' }] }), null, 'nothing left is no schema');
});

test('values are sanitised against their control', () => {
  const [color, slider, toggle, select] = tweaks.validateSchema(SCHEMA).controls;
  assert.equal(tweaks.sanitize(color, '#ABCDEF'), '#abcdef');
  assert.equal(tweaks.sanitize(color, 'red;}'), null);
  assert.equal(tweaks.sanitize(slider, '200'), '96px', 'clamped to max');
  assert.equal(tweaks.sanitize(slider, '-5px'), '24px', 'clamped to min');
  assert.equal(tweaks.sanitize(toggle, '0.75'), '0.75');
  assert.equal(tweaks.sanitize(toggle, 'anything'), '1');
  assert.equal(tweaks.sanitize(select, 'grid'), 'grid');
  assert.equal(tweaks.sanitize(select, 'table'), null);
});

test('defaults persist between the marker comments, replaced never stacked', () => {
  assert.deepEqual(tweaks.readDefaults(PAGE), { '--accent': '#a63a24', '--size': '40px' });
  const schema = tweaks.schemaFromHtml(PAGE);
  assert.equal(schema.controls.length, 4);
  const init = tweaks.initialValues(schema, PAGE);
  assert.equal(init['--accent'], '#a63a24', 'the saved value wins over the default');
  assert.equal(init['--size'], '40px');
  assert.equal(init['--layout'], 'list', 'an unsaved control shows its default');
  const next = tweaks.writeDefaults(PAGE, { '--accent': '#123456', '--evil;}': 'x', '--size': '1px;}</style><script>' });
  assert.equal(next.split(tweaks.START).length, 2, 'one marker block');
  assert.equal(tweaks.readDefaults(next)['--accent'], '#123456');
  assert.ok(!next.includes('--evil'));
  assert.ok(!/<\/style><script>/.test(next.slice(next.indexOf(tweaks.START), next.indexOf(tweaks.END))), 'a value cannot close the block');
  const fresh = tweaks.writeDefaults('<html><head><title>x</title></head><body></body></html>', { '--a': '1px' });
  assert.ok(fresh.indexOf(tweaks.START) < fresh.indexOf('</head>'), 'a page without markers gets a marked block in its head');
  const msg = tweaks.message(schema, { '--accent': '#fff000', '--size': '999', '--not-in-schema': '#000' });
  assert.equal(msg.type, 'neura:set-tweaks');
  assert.equal(msg.version, tweaks.VERSION);
  assert.equal(msg.vars['--size'], '96px');
  assert.ok(!('--not-in-schema' in msg.vars), 'only the schema\'s variables are sent');
});

test('the host script speaks the versioned tweaks protocol and the deck protocol', () => {
  const host = artifact.HOST_SCRIPT;
  assert.doesNotThrow(() => new Function(host), 'the host script parses');
  assert.match(host, /neura:tweaks-available/);
  assert.match(host, /application\/neura-tweaks\+json/);
  assert.match(host, /style\.setProperty\(k,v\)/, 'tweaks are applied as custom properties on :root');
  assert.match(host, /copy\.style\.removeProperty\(k\)/, 'and the inline copy never reaches the saved page');
  assert.match(host, /neura-tweaks"\+":start/, 'the markers are written back so a version keeps them');
  assert.ok(!host.includes('/* neura-tweaks:start */'), 'the host script carries no literal marker');
  assert.match(host, /neura:deck-go/);
  assert.match(host, /type:"neura:deck",index:slide,count:n/);
  assert.match(host, /section\.slide/);
  assert.match(host, /ArrowRight/);
  assert.match(host, /neura:size/);
  assert.match(host, /e\.source!==parent/, 'still only the parent is listened to');
});

test('the prompt asks for a tweaks schema block and the markers', () => {
  const msgs = prompt.buildMessages({ brief: 'a pricing page', system: systems.PRESETS[0], tier: 'local' });
  assert.match(msgs[0].content, /application\/neura-tweaks\+json/);
  assert.match(msgs[0].content, /neura-tweaks:start/);
  assert.match(msgs[0].content, /3 to 8 controls/);
  assert.match(prompt.TWEAKS_RULES, /"slider".*"color".*"toggle".*"select"/s);
});

// ---- 4.9 device frames, viewports, deck mode ----------------------------------

test('the presets are the agreed sizes, with a browser frame and a deck stage', () => {
  assert.deepEqual([stage.PRESETS.phone.width, stage.PRESETS.phone.height], [390, 844]);
  assert.deepEqual([stage.PRESETS.tablet.width, stage.PRESETS.tablet.height], [834, 1194]);
  assert.deepEqual([stage.PRESETS.desktop.width, stage.PRESETS.desktop.height], [1440, 900]);
  assert.equal(stage.PRESETS.browser.frame, 'browser');
  assert.equal(stage.device('browser').outerHeight, 900 + stage.CHROME_HEIGHT, 'the chrome is drawn outside the page');
  assert.deepEqual(stage.deckSize(null), { width: 1920, height: 1080 });
  assert.deepEqual(stage.deckSize({ width: 1080, height: 1350, unit: 'px' }), { width: 1080, height: 1350 });
  assert.deepEqual(stage.deckSize({ width: 210, height: 297, unit: 'mm' }), { width: 1920, height: 1080 }, 'a print size is not a stage');
  assert.equal(stage.device('nope').id, 'desktop');
});

test('the deck is letterboxed to fit and paged within bounds', () => {
  const dev = stage.device('deck');
  const s = stage.fitScale({ w: 1000, h: 1000 }, dev);
  assert.ok(Math.abs(s - (1000 - stage.GUTTER) / 1920) < 1e-9, 'width-bound stage scales by width');
  assert.equal(stage.fitScale({ w: 5000, h: 5000 }, dev), 1, 'never scaled up');
  assert.equal(stage.fitScale({ w: 10, h: 10 }, dev), 0.1, 'never below 10%');
  assert.equal(stage.clampSlide(0, 5, -1), 0);
  assert.equal(stage.clampSlide(4, 5, 1), 4);
  assert.equal(stage.clampSlide(2, 5, 1), 3);
  assert.equal(stage.clampSlide(3, 0, 1), 0);
  assert.equal(stage.counter(2, 12), '3 / 12');
  assert.equal(stage.countSlides('<section class="slide">a</section><section class="slide title">b</section><section>c</section>'), 2);
});

test('deck prompts require the print block, at the stage or the platform size', () => {
  const talk = prompt.buildMessages({ brief: 'b', tier: 'cloud', format: { label: 'Deck', width: 1920, height: 1080, unit: 'px', deck: true } });
  assert.match(talk[0].content, /@media print/);
  assert.match(talk[0].content, /1920x1080/);
  assert.match(talk[0].content, /<section class="slide">/);
  const carousel = prompt.deckRules({ width: 1080, height: 1350, unit: 'px' });
  assert.match(carousel, /1080x1350px/);
  assert.match(carousel, /@media print \{ @page \{ size: 1080px 1350px/);
});

// ---- 4.11 the deterministic gate, extended ------------------------------------

const ids = (html) => slop.lint(html).map((f) => f.id);

test('the gate catches the new finished-page sins', () => {
  assert.ok(ids('<html><style>:root{--font-display:Poppins, sans-serif}</style><h1>x</h1></html>').includes('banned-display-font'));
  assert.ok(ids('<html><style>h1{font-family:"Montserrat"}</style><h1>x</h1></html>').includes('banned-display-font'));
  assert.ok(!ids('<html><style>h1{font-family:Georgia, serif}</style><h1>x</h1></html>').includes('banned-display-font'));
  assert.ok(ids('<html><body><button>🚀 Launch</button></body></html>').includes('emoji-icons'), 'an emoji leading a label is an icon');
  assert.ok(ids('<html><body><li>✅ Fast</li></body></html>').includes('emoji-icons'));
  assert.ok(!ids('<html><body><p>We shipped it 🚀 on Friday.</p></body></html>').includes('emoji-icons'), 'running text is not an icon');
  assert.ok(ids('<html><style>.hero{background:linear-gradient(135deg,#6d28d9,#db2777)}</style></html>').includes('purple-wash'));
  assert.ok(!ids('<html><style>.hero{background:linear-gradient(#f6f5f1,#e9e6dd)}</style></html>').includes('purple-wash'));
  assert.ok(ids('<html><body><a href="#">x</a></body><style>a:focus{outline:1px solid}</style></html>').includes('no-focus-style'), ':focus alone is not :focus-visible');
});

test('WCAG contrast is resolved through tokens for simple pairs', () => {
  const fail = slop.lint('<html><style>:root{--paper:#f6f5f1;--ink:#1b1c1a;--faint:#c9c6bd}.note{color:var(--faint);background:var(--paper)}</style></html>');
  const hit = fail.find((f) => f.id === 'contrast-fail');
  assert.ok(hit, 'light grey on paper fails');
  assert.match(hit.detail, /\.note \d\.\d+:1/, 'the finding names the selector and ratio');
  assert.ok(ids('<html><style>:root{--paper:#fafafa;--ink:#bbbbbb}</style></html>').includes('contrast-fail'), 'the system\'s own ink on paper is checked');
  assert.ok(!ids('<html><style>h1{color:#777777;background:#ffffff}</style></html>').includes('contrast-fail'), 'a heading only needs 3:1');
  assert.ok(ids('<html><style>p{color:#777777;background:#ffffff}</style></html>').includes('contrast-fail'), 'body text at 4.48:1 misses AA');
  const r = slop.contrastFailures('p{color:#767676;background:#ffffff}');
  assert.deepEqual(r, [], '#767676 on white is 4.54, AA');
  assert.equal(slop.contrastFailures('p{color:#999;background:url(x.png)}').length, 0, 'an image background is not resolvable');
  // The linter's maths agrees with the brand engine's.
  const ratio = slop.contrastFailures('p{color:#aaaaaa;background:#ffffff}')[0].ratio;
  assert.ok(Math.abs(ratio - brand.contrastRatio('#aaaaaa', '#ffffff')) < 0.01);
});

test('a token fallback is traceable, and the existing clean fixtures stay clean', () => {
  assert.ok(!ids('<html><style>:root{--a:#111}.a{color:var(--a,#123)}.b{fill:var(--a,#234)}.c{stroke:var(--a,#345)}.d{color:var(--a,#456)}</style></html>').includes('untokened-colour'));
  assert.deepEqual(slop.lint(PAGE), [], 'a tokened page with a tweaks block is clean');
  for (const f of slop.RULES) assert.ok(f.fix.length > 10, f.id);
});

test('the critique is optional, tolerant and clamped, and drawn as a radar', () => {
  assert.equal(critique.defaultOn('cloud', false), true, 'on for a cloud provider');
  assert.equal(critique.defaultOn('local', false), false, 'off for a model on this PC');
  assert.equal(critique.defaultOn('cloud', true), false, 'off for a saved provider');
  const msgs = critique.messages({ html: '<html></html>', findings: [{ label: 'Pure black', detail: 'body' }] });
  assert.match(msgs[0].content, /hierarchy, typography, color, spacing, originality/);
  assert.match(msgs[0].content, /quickWins/);
  assert.match(msgs[1].content, /Pure black \(body\)/, 'the gate\'s findings are passed along');
  const parsed = critique.parse('Sure!\n```json\n{"scores":{"hierarchy":7,"typography":12,"colour":0,"spacing":"6","originality":4.4},"keep":["the grid"],"fix":["x","y","z","a","b","c"],"quick_wins":["tighten h1"]}\n```');
  assert.deepEqual(parsed.scores, { hierarchy: 7, typography: 10, color: 1, spacing: 6, originality: 4 });
  assert.equal(parsed.fix.length, critique.MAX_ITEMS);
  assert.deepEqual(parsed.quickWins, ['tighten h1']);
  assert.equal(critique.parse('no json here'), null);
  assert.equal(critique.parse('{"scores":{"hierarchy":5}}'), null, 'too few scores is not a critique');
  const r = critique.radar(parsed.scores, 200);
  assert.equal(r.axes.length, 5);
  assert.equal(r.polygon.split(' ').length, 5);
  assert.ok(r.axes[0].y < 100, 'the first axis points up');
});

// ---- 4.12 diagrams ------------------------------------------------------------

test('Mermaid flowcharts parse into the graph JSON', () => {
  const g = diagram.parseMermaid('flowchart LR\n  A[Client] -->|HTTPS| B(API)\n  B-- reads -->C[(Database)]\n  B --> D{Cache?}\n  %% a comment\n  classDef x fill:#f00\n  D-->A; E-.->B');
  assert.deepEqual(g.nodes.map((n) => [n.id, n.label]), [['A', 'Client'], ['B', 'API'], ['C', 'Database'], ['D', 'Cache?'], ['E', 'E']]);
  assert.deepEqual(g.edges, [
    { from: 'A', to: 'B', label: 'HTTPS' },
    { from: 'B', to: 'C', label: 'reads' },
    { from: 'B', to: 'D' },
    { from: 'D', to: 'A' },
    { from: 'E', to: 'B' },
  ]);
  assert.deepEqual(diagram.parseMermaid('graph TD\nX --> Y --> Z').edges.map((e) => e.from + e.to), ['XY', 'YZ'], 'chains');
});

test('graphs are normalised, capped at nine nodes with a message', () => {
  const big = diagram.normalize({ nodes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` })), edges: [{ from: 'n0', to: 'n11' }, { from: 'n0', to: 'n1' }] });
  assert.equal(big.nodes.length, diagram.MAX_NODES);
  assert.equal(big.trimmed, true);
  assert.match(big.message, /12 nodes; drew the first 9/);
  assert.deepEqual(big.edges, [{ from: 'n0', to: 'n1' }], 'edges to trimmed nodes go too');
  const g = diagram.normalize({ nodes: [{ id: 'a b<' }, { id: 'a b<' }, 'c'], edges: [{ from: 'a b<', to: 'a b<' }, { from: 'c', to: 'zz' }] });
  assert.deepEqual(g.nodes.map((n) => n.id), ['a_b_', 'c'], 'ids cleaned and unique');
  assert.deepEqual(g.edges, [], 'no self-loops, no dangling edges');
  const fromReply = diagram.extractGraph('Here:\n<diagram>{"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"from":"a","to":"b"}]}</diagram>');
  assert.equal(fromReply.edges.length, 1);
  assert.equal(diagram.extractGraph('```mermaid\nflowchart LR\nA-->B\n```').nodes.length, 2);
  assert.equal(diagram.extractGraph('no graph'), null);
});

test('the layout is layered left to right with orthogonal, rounded connectors', () => {
  const g = diagram.normalize(diagram.parseMermaid('flowchart LR\nA-->B\nB-->C\nA-->C\nC-->A'));
  const lay = diagram.layout(g);
  const byId = Object.fromEntries(lay.nodes.map((n) => [n.id, n]));
  assert.deepEqual([byId.A.layer, byId.B.layer, byId.C.layer], [0, 1, 2], 'longest-path layering');
  assert.ok(byId.A.x < byId.B.x && byId.B.x < byId.C.x);
  for (const e of lay.edges) {
    for (let i = 1; i < e.points.length; i += 1) {
      const [p, q] = [e.points[i - 1], e.points[i]];
      assert.ok(p[0] === q[0] || p[1] === q[1], `${e.from}->${e.to} segment ${i} is orthogonal`);
    }
  }
  const back = lay.edges.find((e) => e.from === 'C' && e.to === 'A');
  assert.equal(back.back, true, 'the cycle closes underneath');
  // A skipping edge (A->C) does not cross B.
  const skip = lay.edges.find((e) => e.from === 'A' && e.to === 'C');
  const b = byId.B;
  for (let i = 1; i < skip.points.length; i += 1) {
    const [p, q] = [skip.points[i - 1], skip.points[i]];
    if (p[1] === q[1] && Math.min(p[0], q[0]) < b.x + b.w && Math.max(p[0], q[0]) > b.x) {
      assert.ok(p[1] < b.y || p[1] > b.y + b.h, 'the skipping edge passes clear of B');
    }
  }
  assert.equal(diagram.roundedPath([[0, 0], [50, 0], [50, 40]], 8), 'M0 0 L42 0 A8 8 0 0 1 50 8 L50 40', 'r=8 bends');
  assert.equal(diagram.roundedPath([[0, 0], [10, 0], [10, 6]], 8), 'M0 0 L7 0 A3 3 0 0 1 10 3 L10 6', 'a short leg shrinks the radius');
});

test('the drawing keeps the house rules: two accents at most, no shadows', () => {
  const g = diagram.normalize({
    nodes: [{ id: 'a', group: 'core' }, { id: 'b', group: 'edge' }, { id: 'c', group: 'third' }, { id: 'd' }],
    edges: [{ from: 'a', to: 'b', label: 'calls' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }],
  });
  const svg = diagram.toSvg(g);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal((svg.match(/class="dg-node dg-a1"/g) || []).length, 1);
  assert.equal((svg.match(/class="dg-node dg-a2"/g) || []).length, 1);
  assert.ok(!/dg-a3/.test(svg), 'a third group is neutral');
  assert.ok(!/filter|drop-shadow|box-shadow|gradient/i.test(svg), 'no shadows, no gradients');
  assert.match(svg, / A8 8 0 0 [01] /, 'rounded bends');
  assert.match(svg, />calls</);
  const page = diagram.toPage(g, { title: 'Flow <x>', tokens: systems.PRESETS[1].tokens });
  assert.deepEqual(slop.lint(page), [], 'a diagram page passes the gate');
  assert.ok(tweaks.schemaFromHtml(page), 'and offers its own tweaks');
  assert.match(page, /Flow &lt;x&gt;/);
  assert.deepEqual(diagram.graphFromHtml(page).nodes.map((n) => n.id), ['a', 'b', 'c', 'd'], 'the graph can be read back and redrawn');
});

// ---- 4.13 exports and handoff -------------------------------------------------

const DECK = `<!DOCTYPE html><html><head><style>:root{--paper:#fbf8f3;--ink:#221f1a}
body{margin:0;background:var(--paper)} html{font-size:16px} .slide{width:100vw;aspect-ratio:16/9}</style></head>
<body><section class="slide"><h1>Q3 &amp; beyond</h1><p>Revenue up 12%.</p></section>
<section class="slide"><h2>Plan</h2><ul><li>Hire two</li><li>Ship v2</li></ul><section class="note">nested</section></section></body></html>`;

test('tokens.css is what the page declares, tweaks included', () => {
  const css = exportsLib.tokensCss(PAGE, 'FALLBACK');
  assert.match(css, /--accent: #a63a24;/, 'the tweak value wins');
  assert.match(css, /--paper: #f6f5f1;/);
  assert.equal(exportsLib.tokensCss('<html></html>', 'FALLBACK'), 'FALLBACK');
});

test('artboards: one per slide, else the page; SVG through foreignObject', () => {
  assert.equal(exportsLib.slidesOf(DECK).length, 2, 'nested sections stay inside their slide');
  assert.match(exportsLib.slidesOf(DECK)[1], /nested<\/section><\/section>$/);
  const boards = exportsLib.artboards(DECK, { width: 1920, height: 1080 }, { width: 1440, height: 900 });
  assert.deepEqual(boards.map((b) => [b.name, b.width, b.height]), [['slide-01', 1920, 1080], ['slide-02', 1920, 1080]]);
  assert.deepEqual(exportsLib.artboards(PAGE, { width: 1920, height: 1080 }, { width: 1440, height: 2400 }).map((b) => b.name), ['page']);
  const scoped = exportsLib.scopeCss(':root{--a:1} body{margin:0} html{x:1} .body{y:1}', 'ab');
  assert.equal(scoped, '.ab{--a:1} .ab{margin:0} .ab{x:1} .body{y:1}', ':root, html and body move to the wrapper; a class named body does not');
  const svg = exportsLib.artboardSvg({ css: ':root{--a:#111}', xhtml: '<p xmlns="http://www.w3.org/1999/xhtml">Hi</p>', width: 1080, height: 1350 });
  assert.match(svg, /<foreignObject x="0" y="0" width="1080" height="1350">/);
  assert.match(svg, /<!\[CDATA\[\.neura-artboard\{--a:#111\}\]\]>/);
});

test('PPTX slides carry each slide\'s text', () => {
  assert.deepEqual(exportsLib.slideTexts(DECK), ['Q3 & beyond\nRevenue up 12%.', 'Plan\n• Hire two\n• Ship v2']);
  assert.deepEqual(exportsLib.slideTexts(PAGE), [], 'no slides, no deck');
});

test('the handoff bundle and the project ZIP', () => {
  const files = exportsLib.handoffFiles({ name: 'Field notes', html: PAGE, designMd: '# DESIGN.md', fallbackTokens: ':root{}' });
  assert.deepEqual(files.map((f) => f[0]), ['index.html', 'tokens.css', 'DESIGN.md', 'README.md']);
  const readme = files[3][1];
  assert.match(readme, /implementation handoff/);
  assert.match(readme, /`--accent`: `#a63a24`/);
  assert.match(readme, /:focus-visible/);
  const brief = exportsLib.handoffBrief({ name: 'Field notes', dir: 'design-handoff/field-notes' });
  assert.match(brief, /design-handoff\/field-notes\/README\.md/);
  const zipFiles = exportsLib.projectFiles({ name: 'Field notes', html: PAGE, designMd: 'x', versions: [{ label: 'AI: first', html: '<p>1</p>', ts: 1 }], now: 0 });
  assert.ok(zipFiles.some(([n]) => n === 'field-notes/history/01-ai-first.html'));
  assert.equal(JSON.parse(zipFiles.find(([n]) => n.endsWith('project.json'))[1]).versions[0].label, 'AI: first');
});

// ---- 4.15 social templates ----------------------------------------------------

test('the social templates have their platform sizes and our own briefs', () => {
  const byId = Object.fromEntries(social.TEMPLATES.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(byId), ['x-thread', 'linkedin-carousel', 'tiktok-script', 'instagram-carousel']);
  assert.deepEqual([byId['linkedin-carousel'].width, byId['linkedin-carousel'].height], [1080, 1350]);
  assert.deepEqual([byId['instagram-carousel'].width, byId['instagram-carousel'].height], [1080, 1080]);
  for (const t of social.TEMPLATES) {
    assert.equal(t.deck, true, `${t.id} renders as deck slides`);
    assert.match(t.prompt, /<section class="slide">/, `${t.id} asks for slides`);
    assert.ok(t.prompt.length > 200, `${t.id} has a real platform brief`);
  }
  const merged = social.merge([{ id: 'social-post', label: 'Social', category: 'social', width: 1080, height: 1080, unit: 'px', description: '' }, { id: 'x-thread', label: 'Engine thread' }]);
  assert.equal(merged[0].id, 'social-post');
  assert.equal(merged.filter((t) => t.id === 'x-thread').length, 1, 'an engine template of the same id wins');
  assert.equal(merged.find((t) => t.id === 'x-thread').label, 'Engine thread');
  assert.ok(!('prompt' in merged.find((t) => t.id === 'linkedin-carousel')), 'the picker rows carry no prompt');
  const msgs = prompt.buildMessages({ brief: 'launch post', tier: 'cloud', format: { label: 'LinkedIn carousel', width: 1080, height: 1350, unit: 'px', deck: true }, platform: social.promptFor('linkedin-carousel') });
  assert.match(msgs[0].content, /LinkedIn document carousel/);
  assert.match(msgs[0].content, /1080x1350px/);
});

// ---- the screens --------------------------------------------------------------

test('the studio wires the Phase 9 modules without loosening the sandbox', () => {
  assert.match(SCREEN, /sandbox="allow-scripts"/);
  assert.ok(!/allow-same-origin/.test(SCREEN), 'model HTML never shares the app origin');
  assert.match(SCREEN, /data\.type === 'neura:tweaks-available'/);
  assert.match(SCREEN, /data\.version !== tweaksLib\.VERSION/, 'the protocol is versioned');
  assert.match(SCREEN, /tweaksLib\.validateSchema\(data\.schema\)/, 'a schema from the frame is validated before it is rendered');
  assert.match(SCREEN, /post\(tweaksLib\.message\(tweakSchema, next\)\)/);
  assert.match(SCREEN, /data\.type === 'neura:deck'/);
  assert.match(SCREEN, /type: 'neura:deck-go'/);
  assert.match(SCREEN, /stageLib\.device\(viewport, stageFormat\)/);
  assert.match(SCREEN, /className="browser-chrome"/);
  assert.match(SCREEN, /className="deck-nav"/);
  assert.match(SCREEN, /ArrowRight/);
  assert.ok(!/<select[\s>]/.test(SCREEN), 'no native select');
});

test('the gate shows first; the critique is a button, auto only for the cloud', () => {
  assert.match(SCREEN, /critiqueLib\.defaultOn\(promptLib\.tierOf\(provider\), isSavedProvider\(provider\)\)/);
  assert.match(SCREEN, /if \(critiqueOn\) runCritique\(/);
  assert.match(SCREEN, /<CritiqueRadar scores=/);
  // In the draft card the findings come before the directions.
  const card = SCREEN.slice(SCREEN.indexOf('className="approval-card draft-bar"'));
  assert.ok(card.indexOf('draft.findings.slice(0, 3)') < card.indexOf('className="variant-row"'));
  // In the Checks tab, the score and findings come before the critique.
  const checksTab = SCREEN.slice(SCREEN.indexOf("tab === 'checks'"));
  assert.ok(checksTab.indexOf('checks-score') < checksTab.indexOf('className="critique"'));
});

test('diagrams, exports, social templates and the handoff are wired', () => {
  assert.match(SCREEN, /promptLib\.diagramMessages\(/);
  assert.match(SCREEN, /diagramLib\.extractGraph\(reply\)/);
  assert.match(SCREEN, /diagramLib\.parseMermaid\(mermaidText\)/);
  assert.match(SCREEN, /diagramLib\.toPage\(/);
  assert.match(SCREEN, /social\.merge\(templates\)/);
  assert.match(SCREEN, /platform: socialTpl \? socialTpl\.prompt : ''/);
  assert.match(SCREEN, /office\.writePptx\(/, 'PPTX reuses the in-repo office writer');
  assert.match(SCREEN, /exportsLib\.artboardSvg\(/);
  assert.match(SCREEN, /svgToPng\(/);
  assert.match(SCREEN, /new DOMParser\(\)\.parseFromString\(html, 'text\/html'\)/, 'exports parse an inert copy, never the live frame');
  assert.match(SCREEN, /exportsLib\.projectFiles\(/);
  assert.match(SCREEN, /saveFile\(/, 'files go through the existing save path');
  assert.match(SCREEN, /sessionStorage\.setItem\(CODE_HANDOFF_KEY/);
  assert.match(SCREEN, /detail: \{ view: 'code' \}/);
  assert.match(CODE, /export const CODE_HANDOFF_KEY = 'freeai4u\.codeHandoff'/);
  assert.match(CODE, /sessionStorage\.getItem\(CODE_HANDOFF_KEY\)/);
  assert.match(CODE, /sessionStorage\.removeItem\(CODE_HANDOFF_KEY\)/, 'read once');
});
