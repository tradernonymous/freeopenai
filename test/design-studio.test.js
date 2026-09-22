// Phase 4: the Design studio. The contract with the model (artifact.js), the
// design systems and their variants (systems.js), the prompts by tier
// (prompt.js), the version timeline (versions.js) and the extended anti-slop
// gate are pure, so they are tested here; DesignScreen.tsx is held to using
// them the way the security and local-first decisions require.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// systems.js first: prompt.js reads its global at call time, as in the app.
const systems = require('../desktop/src/design/systems.js');
const prompt = require('../desktop/src/design/prompt.js');
const artifact = require('../desktop/src/design/artifact.js');
const versions = require('../desktop/src/design/versions.js');
const brand = require('../desktop/src/design/brand.js');
const slop = require('../desktop/src/design/slop.js');

const SCREEN = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'src', 'screens', 'DesignScreen.tsx'), 'utf8');

function memoryStore(limit = Infinity) {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      const size = Object.entries(data).reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0) + String(v).length;
      if (size > limit) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      data[k] = String(v);
    },
    removeItem: (k) => { delete data[k]; },
  };
}

const PAGE = `<!DOCTYPE html><html><head><style>:root{--paper:#f6f5f1;--ink:#1b1c1a;--accent:#2f6f4f;--space:8px}
body{background:var(--paper);color:var(--ink)} a:focus-visible{outline:2px solid var(--accent)}</style></head>
<body><main><h1>Quarterly field notes</h1><p>Forty-two sites visited.</p><a href="#more">More</a></main></body></html>`;

// ---- the model contract ----------------------------------------------------

test('the artifact tag is the contract, and a missing tag is tolerated', () => {
  const tagged = artifact.extract(`Here it is.\n<artifact type="text/html">${PAGE}</artifact>`);
  assert.equal(tagged.tagged, true);
  assert.match(tagged.html, /^<!DOCTYPE html>/);
  const fenced = artifact.extract('Sure:\n```html\n' + PAGE + '\n```');
  assert.equal(fenced.tagged, false);
  assert.match(fenced.html, /Quarterly field notes/);
  const bare = artifact.extract('Sure! ' + PAGE + ' Hope that helps.');
  assert.match(bare.html, /<\/html>$/, 'bare text around a page is dropped');
  assert.equal(artifact.extract('I cannot help with that.').html, null);
});

test('a page cut off mid-stream is closed rather than lost', () => {
  const cut = PAGE.slice(0, PAGE.indexOf('</main>'));
  const out = artifact.extract(`<artifact type="text/html">${cut}`);
  assert.match(out.html, /<\/html>$/);
});

test('question forms are read, capped at five, and never mistaken for the page', () => {
  const qs = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, label: `Question ${i}?`, options: ['a', 'b'] }));
  const out = artifact.extract(`<question-form>${JSON.stringify({ questions: qs })}</question-form>`);
  assert.equal(out.html, null);
  assert.equal(out.questions.length, artifact.MAX_QUESTIONS);
  assert.deepEqual(out.questions[0].options, ['a', 'b']);
  assert.equal(artifact.extract('<question-form>not json</question-form>').questions, null);
  const withAssumptions = artifact.extract(`<assumptions>\n- audience is engineers\n- one page\n</assumptions>\n<artifact type="text/html">${PAGE}</artifact>`);
  assert.deepEqual(withAssumptions.assumptions, ['audience is engineers', 'one page']);
  assert.ok(withAssumptions.html);
});

test('a comment edit comes back as one element', () => {
  assert.equal(artifact.extractFragment('<artifact type="text/html-fragment"><h1 class="t">New title</h1></artifact>'), '<h1 class="t">New title</h1>');
  assert.equal(artifact.extractFragment('Done:\n```html\n<p>Short.</p>\n```'), '<p>Short.</p>');
  assert.equal(artifact.extractFragment('no element here'), null);
});

// ---- the preview host ------------------------------------------------------

test('the host script goes in before </body> and comes out without a trace', () => {
  const live = artifact.inject(PAGE);
  assert.ok(live.indexOf('id="neura-host"') < live.indexOf('</body>'));
  assert.equal(artifact.inject(live).split('id="neura-host"').length, 2, 'injecting twice does not stack');
  const messy = live.replace('<main>', '<main data-nid="0" data-neura-pin="1">');
  assert.equal(artifact.strip(messy), PAGE);
});

test('the host only listens to its parent and cleans what it serialises', () => {
  const host = artifact.HOST_SCRIPT;
  assert.match(host, /e\.source!==parent/, 'messages from anything but the studio are ignored');
  assert.match(host, /removeAttribute\("data-nid"\)/);
  assert.match(host, /neura:pick/);
  assert.match(host, /neura:replace/);
  assert.match(host, /neura:set-tweaks/);
  assert.match(host, /\[;\{\}<\]/, 'tweak values cannot break out of the style block');
  assert.doesNotThrow(() => new Function(host), 'the host script parses');
});

// ---- tweaks ------------------------------------------------------------------

test(':root tokens become controls, and tweaks live in one block', () => {
  const vars = artifact.cssVars(PAGE);
  assert.deepEqual(vars.map((v) => v.name), ['--paper', '--ink', '--accent', '--space']);
  assert.equal(artifact.controlFor('--accent', '#2f6f4f').kind, 'color');
  const len = artifact.controlFor('--space', '8px');
  assert.equal(len.kind, 'length');
  assert.equal(len.unit, 'px');
  assert.equal(artifact.controlFor('--font-body', 'Georgia, serif').kind, 'text');
  const once = artifact.setTweaks(PAGE, { '--accent': '#a63a24' });
  const twice = artifact.setTweaks(once, { '--accent': '#123456', '--bad;}': 'x' });
  assert.equal(twice.split('id="neura-tweaks"').length, 2, 'replaced, never stacked');
  assert.ok(!twice.includes('--bad'), 'only real custom-property names are written');
  assert.equal(artifact.cssVars(twice).find((v) => v.name === '--accent').value, '#123456', 'the tweak wins');
  assert.ok(!artifact.setTweaks(twice, {}).includes('neura-tweaks'), 'an empty set removes the block');
  assert.ok(!artifact.setTweaks(PAGE, { '--x': 'red;}</style><script>' }).includes('</style><script>'));
});

// ---- design systems -------------------------------------------------------------

test('the presets are original, complete and readable (AA on their paper)', () => {
  assert.deepEqual(systems.PRESETS.map((p) => p.id), ['neutral-minimal', 'editorial', 'terminal']);
  for (const preset of systems.PRESETS) {
    for (const token of systems.TOKENS) assert.ok(preset.tokens[token], `${preset.id} defines ${token}`);
    for (const role of ['--ink', '--muted', '--accent']) {
      const ratio = brand.contrastRatio(preset.tokens[role], preset.tokens['--paper']);
      assert.ok(ratio >= 4.5, `${preset.id} ${role} is ${ratio}:1 on paper`);
    }
    assert.ok(!/#000(000)?\b|#fff(fff)?\b/i.test(JSON.stringify(preset.tokens)), `${preset.id} has no pure black or white`);
  }
});

test('DESIGN.md has the nine sections and the tokens, and tokens.css declares them', () => {
  const md = systems.designMd(systems.PRESETS[1]);
  for (let i = 1; i <= 9; i += 1) assert.match(md, new RegExp(`^## ${i}\\. `, 'm'), `section ${i}`);
  assert.match(md, /`--accent` \| `#a63a24`/);
  const css = systems.tokensCss(systems.PRESETS[1]);
  assert.match(css, /^:root \{/);
  assert.match(css, /--measure: 64ch;/);
});

test('a brand and an imported file fold into the same shape', () => {
  const fromBrand = systems.fromBrand({ url: 'https://x.test', roles: { paper: '#fafafa', ink: '#222222', accent: '#c2410c', muted: '#666666' } }, 'Acme');
  assert.equal(fromBrand.id, 'brand');
  assert.equal(fromBrand.tokens['--accent'], '#c2410c');
  assert.ok(fromBrand.tokens['--font-display'], 'the rest comes from the neutral base');
  const imported = systems.importSystem('# DESIGN.md — Harbour\n| `--accent` | `#0b7285` |\n:root { --radius: 4px; }');
  assert.equal(imported.name, 'Harbour');
  assert.equal(imported.tokens['--accent'], '#0b7285');
  assert.equal(imported.tokens['--radius'], '4px');
  assert.equal(systems.importSystem('no tokens here'), null);
});

test('three directions are token swaps, ordered by the book -> refined -> novel', () => {
  const base = systems.PRESETS[0].tokens;
  const list = systems.variants(base);
  assert.deepEqual(list.map((v) => v.id), ['book', 'refined', 'novel']);
  assert.deepEqual(list[0].vars, base, 'by the book is the system itself');
  assert.notEqual(list[1].vars['--accent'], base['--accent']);
  assert.equal(list[1].vars['--radius'], '3px');
  assert.equal(list[2].vars['--ink'], base['--paper'], 'novel inverts the surface');
  for (const v of list) {
    assert.ok(v.caption.length > 10, `${v.id} is captioned`);
    const ratio = brand.contrastRatio(v.vars['--ink'], v.vars['--paper']);
    assert.ok(ratio >= 4.5, `${v.id} keeps body text AA (${ratio}:1)`);
  }
});

test('hex <-> hsl round-trips', () => {
  for (const hex of ['#2f6f4f', '#a63a24', '#0f1411', '#fbf8f3']) {
    assert.equal(systems.hslToHex(systems.hexToHsl(hex)), hex);
  }
});

// ---- prompts by tier ----------------------------------------------------------

test('every tier gets the charter; only the cloud may ask, only local lists assumptions', () => {
  assert.match(prompt.CHARTER, /self-contained/);
  assert.match(prompt.CHARTER, /WCAG AA/);
  assert.match(prompt.CHARTER, /no lorem ipsum/i);
  assert.match(prompt.CHARTER, /<artifact type="text\/html">/);
  assert.ok(prompt.CHARTER.length < 12000, 'the core charter stays well under 3k tokens');
  const cloud = prompt.buildMessages({ brief: 'a pricing page', system: systems.PRESETS[0], tier: 'cloud' });
  const local = prompt.buildMessages({ brief: 'a pricing page', system: systems.PRESETS[0], tier: 'local' });
  assert.match(cloud[0].content, /<question-form>/);
  assert.ok(!/<question-form>/.test(local[0].content), 'a local model is never invited to ask');
  assert.match(local[0].content, /<assumptions>/);
  assert.match(cloud[1].content, /DESIGN\.md contract/);
  assert.match(cloud[1].content, /--accent: #2f6f4f;/, 'the tokens ride along');
  assert.equal(prompt.tierOf('ollama-local'), 'local');
  assert.equal(prompt.tierOf('unsloth-local'), 'local');
  assert.equal(prompt.tierOf('groq'), 'cloud');
});

test('local gets a tighter slice of the current page; decks get their rules', () => {
  const big = '<html>' + 'x'.repeat(50000) + '</html>';
  const local = prompt.buildMessages({ brief: 'b', tier: 'local', html: big });
  const cloud = prompt.buildMessages({ brief: 'b', tier: 'cloud', html: big });
  assert.ok(local[1].content.length < cloud[1].content.length);
  assert.match(local[1].content, /\[truncated\]/);
  const deck = prompt.buildMessages({ brief: 'b', tier: 'cloud', format: { label: 'Deck', deck: true } });
  assert.match(deck[0].content, /break-after: page/);
});

test('a comment edit sends one element, not the page', () => {
  const msgs = prompt.commentMessages({ outer: '<h1>Old</h1>', comment: 'shorter', tokens: { '--accent': '#111' } });
  assert.match(msgs[0].content, /ONE element/);
  assert.match(msgs[0].content, /text\/html-fragment/);
  assert.match(msgs[1].content, /<h1>Old<\/h1>/);
  assert.match(msgs[1].content, /Request: shorter/);
});

// ---- versions -------------------------------------------------------------------

test('versions are newest first, deduplicated, and capped by count', () => {
  const store = memoryStore();
  versions.push('p1', { html: '<p>1</p>', label: 'one' }, store);
  versions.push('p1', { html: '<p>1</p>', label: 'same' }, store);
  versions.push('p1', { html: '<p>2</p>', label: 'two' }, store);
  const rows = versions.list('p1', store);
  assert.deepEqual(rows.map((r) => r.label), ['two', 'one']);
  assert.equal(versions.get('p1', rows[1].id, store).html, '<p>1</p>');
  for (let i = 0; i < 40; i += 1) versions.push('p1', { html: `<p>${i}x</p>` }, store);
  assert.equal(versions.list('p1', store).length, versions.MAX_ENTRIES);
  assert.deepEqual(versions.list('p2', store), [], 'projects do not share a timeline');
});

test('a full store drops the oldest versions, never the newest', () => {
  const store = memoryStore(3000);
  for (let i = 0; i < 10; i += 1) versions.push('p', { html: 'y'.repeat(500) + i }, store);
  const rows = versions.list('p', store);
  assert.ok(rows.length >= 1 && rows.length < 10);
  assert.ok(rows[0].html.endsWith('9'), 'the newest survived');
});

// ---- the quality gate -----------------------------------------------------------

test('the gate catches the finished-page sins, and a clean page passes', () => {
  assert.deepEqual(slop.lint(PAGE), [], 'a tokened, focus-styled page is clean');
  const ids = (html) => slop.lint(html).map((f) => f.id);
  assert.ok(ids('<html><style>body{color:#000;background:#fff}</style></html>').includes('pure-black-white'));
  assert.ok(ids('<html><body><button>Go</button></body></html>').includes('no-focus-style'));
  assert.ok(ids('<html><style>:root{--a:#111}.a{color:#123}.b{color:#234}.c{color:#345}.d{color:#456}</style></html>').includes('untokened-colour'));
  assert.ok(ids('<html><style>.card{border-left:4px solid var(--accent)}</style></html>').includes('left-bar-card'));
  assert.ok(ids('<html><style>.a{margin:13px}.b{padding:22px}.c{gap:37px}.d{margin:5px}.e{padding:7px}</style></html>').includes('off-scale-spacing'));
  assert.deepEqual(ids('.a{color:#000}'), [], 'a CSS snippet is not graded as a page');
});

// ---- the screen ---------------------------------------------------------------

test('the studio is three panes around a sandboxed canvas', () => {
  assert.match(SCREEN, /className="studio-left"/);
  assert.match(SCREEN, /className="studio-centre"/);
  assert.match(SCREEN, /className="studio-right"/);
  assert.match(SCREEN, /sandbox="allow-scripts"/);
  assert.ok(!/allow-same-origin/.test(SCREEN), 'the canvas never shares the app origin');
  assert.match(SCREEN, /e\.source !== iframeRef\.current\.contentWindow/, 'only the canvas frame is listened to');
});

test('the studio uses the tested modules for every decision', () => {
  assert.match(SCREEN, /promptLib\.buildMessages\(/);
  assert.match(SCREEN, /promptLib\.commentMessages\(/);
  assert.match(SCREEN, /artifact\.extract\(/);
  assert.match(SCREEN, /systemsLib\.variants\(/);
  assert.match(SCREEN, /versionsLib\.push\(/);
  assert.match(SCREEN, /artifact\.setTweaks\(/);
  assert.match(SCREEN, /nidOrder\(b\.nid, a\.nid\)/, 'comments apply last-first so paths stay valid');
  assert.match(SCREEN, /DESIGN_BRIEF_KEY/, 'a brief handed over from Chat is picked up');
});

test('handoff ships the page with its system', () => {
  assert.match(SCREEN, /\['tokens\.css', systemsLib\.tokensCss\(system\)\]/);
  assert.match(SCREEN, /\['DESIGN\.md', systemsLib\.designMd\(system\)\]/);
  assert.match(SCREEN, /design-handoff\//);
  assert.match(SCREEN, /zip\.writeZip\(/, 'without an open folder it is a ZIP');
});
