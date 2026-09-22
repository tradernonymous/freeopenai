// Phase 12f: local dictation through the user's whisper.cpp (whisper.rs, wav.js,
// the engine choice in dictate.ts, the Dictation card), the Design component
// palette (design/components.js) and the framework exports (design/exports.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const wav = require('../desktop/src/wav.js');
const components = require('../desktop/src/design/components.js');
const slop = require('../desktop/src/design/slop.js');
const exportsLib = require('../desktop/src/design/exports.js');

const WHISPER = read('desktop', 'src-tauri', 'src', 'whisper.rs');
const MAIN = read('desktop', 'src-tauri', 'src', 'main.rs');
const CHAT = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
const BRIDGE = read('desktop', 'src', 'bridge.ts');
const SETTINGS = read('desktop', 'src', 'screens', 'SettingsScreen.tsx');
const DESIGN = read('desktop', 'src', 'screens', 'DesignScreen.tsx');

const loadDictate = () => import(pathToFileURL(path.join(ROOT, 'desktop', 'src', 'dictate.ts')).href);

// ---- wav.js -----------------------------------------------------------------------

function header(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at, n) => String.fromCharCode(...bytes.slice(at, at + n));
  return {
    riff: ascii(0, 4),
    size: view.getUint32(4, true),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    align: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true),
    view,
  };
}

test('wav: the header is canonical 16 kHz mono 16-bit PCM', () => {
  const samples = new Float32Array(1600).fill(0.25);
  const bytes = wav.encodeWav(samples, 16000);
  const h = header(bytes);
  assert.equal(h.riff, 'RIFF');
  assert.equal(h.wave, 'WAVE');
  assert.equal(h.fmt, 'fmt ');
  assert.equal(h.fmtSize, 16);
  assert.equal(h.format, 1);
  assert.equal(h.channels, 1);
  assert.equal(h.rate, 16000);
  assert.equal(h.byteRate, 32000);
  assert.equal(h.align, 2);
  assert.equal(h.bits, 16);
  assert.equal(h.data, 'data');
  assert.equal(h.dataSize, 3200);
  assert.equal(h.size, 36 + 3200);
  assert.equal(bytes.length, 44 + 3200);
});

test('wav: samples are clamped and scaled to int16', () => {
  const bytes = wav.encodeWav(new Float32Array([1, -1, 0, 2, -3]), 16000);
  const { view } = header(bytes);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
  assert.equal(view.getInt16(48, true), 0);
  assert.equal(view.getInt16(50, true), 32767);
  assert.equal(view.getInt16(52, true), -32768);
});

test('wav: resampling keeps the duration (48 kHz and 44.1 kHz to 16 kHz)', () => {
  assert.equal(wav.resample(new Float32Array(48000), 48000, 16000).length, 16000);
  assert.equal(wav.resample(new Float32Array(44100 * 2), 44100, 16000).length, 32000);
  assert.equal(wav.resample(new Float32Array(441), 44100, 16000).length, 160);
  const same = new Float32Array([0.1, 0.2]);
  assert.equal(wav.resample(same, 16000, 16000), same);
  // Linear: a ramp stays a ramp.
  const ramp = wav.resample(new Float32Array([0, 1, 2, 3, 4, 5]), 3, 2);
  assert.deepEqual(Array.from(ramp), [0, 1.5, 3, 4.5]);
});

test('wav: toWhisperWav mixes stereo to mono and lands at 16 kHz', () => {
  const left = new Float32Array(48000).fill(0.5);
  const right = new Float32Array(48000).fill(-0.5);
  const bytes = wav.toWhisperWav([left, right], 48000);
  const h = header(bytes);
  assert.equal(h.channels, 1);
  assert.equal(h.rate, wav.TARGET_RATE);
  assert.equal(h.dataSize, 16000 * 2);
  assert.equal(h.view.getInt16(44, true), 0);
});

test('wav: toBase64 matches Buffer', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 44, 1001]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255);
    assert.equal(wav.toBase64(bytes), Buffer.from(bytes).toString('base64'), `length ${n}`);
  }
});

// ---- whisper.rs -------------------------------------------------------------------

test('whisper.rs spawns the binary directly with argv, never a shell', () => {
  assert.match(WHISPER, /Command::new\(&binary\)/);
  assert.match(WHISPER, /\.args\(args_for\(/);
  assert.doesNotMatch(WHISPER, /cmd\.exe|"cmd"|\/C|"sh"|"-c"|raw_arg|shell_command/);
  assert.match(WHISPER, /CREATE_NO_WINDOW/);
});

test('whisper.rs uses exactly the documented whisper.cpp flags', () => {
  for (const flag of ['"-m"', '"-f"', '"-otxt"', '"-of"', '"-nt"', '"-l"']) {
    assert.ok(WHISPER.includes(`OsString::from(${flag})`), flag);
  }
  assert.match(WHISPER, /fn valid_language/);
});

test('whisper.rs times out at 120 s, kills the child, and always removes its temp folder', () => {
  assert.match(WHISPER, /TIMEOUT_SECS: u64 = 120/);
  assert.match(WHISPER, /try_wait\(\)/);
  assert.match(WHISPER, /child\.kill\(\)/);
  assert.match(WHISPER, /impl Drop for TempDir/);
  assert.match(WHISPER, /remove_dir_all/);
  // stderr to a file, not an unread pipe.
  assert.doesNotMatch(WHISPER, /Stdio::piped/);
});

test('whisper.rs checks the model and the WAV before running anything', () => {
  assert.match(WHISPER, /eq_ignore_ascii_case\("bin"\)/);
  assert.match(WHISPER, /b"RIFF"/);
  assert.match(WHISPER, /b"WAVE"/);
  assert.match(WHISPER, /MAX_WAV_BYTES/);
  assert.match(WHISPER, /rfd::FileDialog/);
  assert.match(WHISPER, /whisper-models/);
});

test('main.rs registers the module and the four commands, and bridge.ts calls them', () => {
  assert.match(MAIN, /^mod whisper;$/m);
  for (const cmd of ['whisper_find', 'whisper_use', 'whisper_pick_binary', 'whisper_transcribe']) {
    assert.ok(MAIN.includes(`whisper::${cmd},`), cmd);
    assert.ok(BRIDGE.includes(`'${cmd}'`), `bridge ${cmd}`);
  }
});

// ---- dictate.ts engine choice -------------------------------------------------------

test('dictation engine: auto prefers this PC, then Hugging Face, then nothing', async () => {
  const d = await loadDictate();
  assert.equal(d.chooseEngine({ setting: 'auto', localReady: true, hfToken: true }), 'local');
  assert.equal(d.chooseEngine({ setting: 'auto', localReady: false, hfToken: true }), 'hf');
  assert.equal(d.chooseEngine({ setting: 'auto', localReady: false, hfToken: false }), 'none');
  assert.equal(d.chooseEngine({ setting: 'nonsense', localReady: true, hfToken: false }), 'local');
});

test('dictation engine: a forced engine is never silently swapped', async () => {
  const d = await loadDictate();
  assert.equal(d.chooseEngine({ setting: 'local', localReady: false, hfToken: true }), 'none');
  assert.equal(d.chooseEngine({ setting: 'local', localReady: true, hfToken: true }), 'local');
  assert.equal(d.chooseEngine({ setting: 'hf', localReady: true, hfToken: false }), 'none');
  assert.equal(d.chooseEngine({ setting: 'hf', localReady: true, hfToken: true }), 'hf');
  assert.equal(d.normalizeEngine(null), 'auto');
  assert.match(d.noEngineMessage('auto'), /Win\+H/);
});

test('dictation model: the saved model if still found, else the first', async () => {
  const d = await loadDictate();
  const models = [{ path: 'C:/m/ggml-base.bin' }, { path: 'C:/m/ggml-small.bin' }];
  assert.equal(d.pickModel('C:/m/ggml-small.bin', models), 'C:/m/ggml-small.bin');
  assert.equal(d.pickModel('C:/gone.bin', models), 'C:/m/ggml-base.bin');
  assert.equal(d.pickModel('', []), '');
});

test('ChatScreen changes only its transcribe call; Settings shows the Dictation card', () => {
  assert.match(CHAT, /await transcribeAuto\(await rec\.stop\(\), hfToken \|\| ''\)/);
  assert.doesNotMatch(CHAT, /await transcribe\(/);
  assert.match(SETTINGS, /import DictationCard from '\.\.\/components\/DictationCard'/);
  assert.match(SETTINGS, /<DictationCard \/>/);
  const card = read('desktop', 'src', 'components', 'DictationCard.tsx');
  assert.match(card, /github\.com\/ggml-org\/whisper\.cpp\/releases/);
  assert.match(card, /huggingface\.co\/ggerganov\/whisper\.cpp/);
  assert.doesNotMatch(card, /localModelDownload|download\(/);
});

// ---- design/components.js ---------------------------------------------------------

const TOKENS = ':root{--paper:#f6f5f1;--ink:#1b1c1a;--muted:#5d5f58;--accent:#2f6f4f;--line:#dcdad3;--font-display:Georgia,serif;--font-body:system-ui,sans-serif;--radius:6px;--space:8px}';
const page = (body) => `<!doctype html><html><head><style>${TOKENS}</style></head><body><main>${body}</main></body></html>`;

test('the palette has the ten components', () => {
  assert.deepEqual(components.COMPONENTS.map((c) => c.id),
    ['button', 'card', 'input', 'nav', 'hero', 'stat', 'table', 'modal', 'badge', 'footer']);
});

test('every component passes the anti-slop linter, alone and on a page', () => {
  for (const c of components.COMPONENTS) {
    assert.deepEqual(slop.lint(components.snippet(c.id)).map((f) => f.id), [], `${c.id} alone`);
    assert.deepEqual(slop.lint(page(components.snippet(c.id))).map((f) => f.id), [], `${c.id} on a page`);
  }
  const all = components.COMPONENTS.reduce((html, c) => components.insertInto(html, c.id), page('<h1>Title</h1>'));
  assert.deepEqual(slop.lint(all).map((f) => f.id), []);
});

test('components use only var(--token) colours (literals only as fallbacks)', () => {
  for (const c of components.COMPONENTS) {
    const outside = c.css.replace(/var\(\s*--[\w-]+\s*,[^)]*\)/g, '');
    assert.doesNotMatch(outside, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, c.id);
    assert.doesNotMatch(outside, /:\s*(black|white|red|blue|green|gray|grey)\b/i, c.id);
    assert.doesNotMatch(c.html, /style="/, `${c.id} has no inline styles`);
    for (const decl of c.css.match(/(?:^|[\s;{])(?:color|background|border(?:-[a-z]+)?)\s*:[^;}]+/g) || []) {
      if (/#[0-9a-f]{3,8}/i.test(decl)) assert.match(decl, /var\(--/, `${c.id}: ${decl}`);
    }
  }
});

test('insertInto adds the CSS once and the markup before the last </main>', () => {
  const base = page('<p>Intro</p>');
  const once = components.insertInto(base, 'button');
  const twice = components.insertInto(once, 'button');
  assert.equal((twice.match(/data-neura-component="button"/g) || []).length, 1);
  assert.equal((twice.match(/class="nx-actions"/g) || []).length, 2);
  assert.ok(once.indexOf('data-neura-component="button"') < once.indexOf('</head>'));
  assert.ok(once.indexOf('nx-actions') < once.indexOf('</main>'));
  const noMain = components.insertInto('<html><body><p>x</p></body></html>', 'badge');
  assert.ok(noMain.indexOf('nx-badge">In review') < noMain.indexOf('</body>'));
  assert.equal(components.insertInto(base, 'nope'), base);
});

test('DesignScreen has a Components tab that inserts through commit()', () => {
  assert.match(DESIGN, /import '\.\.\/design\/components\.js'/);
  assert.match(DESIGN, /'components'/);
  assert.match(DESIGN, /commit\(componentsLib\.insertInto\(/);
});

// ---- design/exports.js: React, Flutter, SwiftUI ------------------------------------

const SAMPLE = `<!doctype html><html><head><style>:root { --accent: #2f6f4f; --space: 8px; }
.hero { padding: var(--space); }</style></head>
<body><main class="hero" style="margin-top: 8px; --x: 1; -webkit-line-clamp: 2">
<!-- a comment -->
<label for="email" class="lbl">Email</label>
<input id="email" type="email" value="a@b.c" readonly>
<img src="a.png" alt="A"><br>
<select><option value="1" selected>One</option></select>
<p tabindex="0">Use {braces} &amp; 3 > 2</p>
<button onclick="go()">Go</button>
<svg viewBox="0 0 10 10"><path stroke-width="2" d="M0 0"/></svg>
<script>alert(1)</script>
</main></body></html>`;

test('toReact: class, for, style objects, void tags, handlers and scripts', () => {
  const out = exportsLib.toReact(SAMPLE, 'my landing page');
  assert.equal(out.name, 'MyLandingPage');
  const tsx = out.tsx;
  assert.match(tsx, /export default function MyLandingPage\(\)/);
  assert.match(tsx, /<main className="hero" style=\{\{ marginTop: '8px', '--x': '1', WebkitLineClamp: '2' \} as CSSProperties\}>/);
  assert.match(tsx, /^import type \{ CSSProperties \} from 'react';$/m);
  assert.match(tsx, /<label htmlFor="email" className="lbl">Email<\/label>/);
  assert.match(tsx, /<input id="email" type="email" defaultValue="a@b\.c" readOnly \/>/);
  assert.match(tsx, /<img src="a\.png" alt="A" \/><br \/>/);
  assert.match(tsx, /<option value="1" selected>One<\/option>/);
  assert.match(tsx, /<p tabIndex=\{0\}>Use \{'\{'\}braces\{'\}'\} &amp; 3 \{'>'\} 2<\/p>/);
  assert.match(tsx, /<button>Go<\/button>/);
  assert.match(tsx, /<path strokeWidth="2" d="M0 0" \/>/);
  assert.doesNotMatch(tsx, /alert\(1\)|onclick|<!--|class=/);
  assert.match(tsx, /1 <script> block\(s\), 1 inline event handler\(s\)/);
  assert.match(tsx, /import '\.\/tokens\.css';/);
  assert.match(tsx, /import '\.\/MyLandingPage\.css';/);
});

test('toReact: page CSS in <Name>.css, tokens in tokens.css, three files', () => {
  const out = exportsLib.toReact(SAMPLE, 'my landing page');
  assert.match(out.css, /\.hero \{ padding: var\(--space\); \}/);
  assert.doesNotMatch(out.css, /:root/);
  assert.match(out.tokens, /--accent: #2f6f4f;/);
  assert.deepEqual(out.files.map((f) => f[0]), ['MyLandingPage.tsx', 'MyLandingPage.css', 'tokens.css']);
  assert.equal(exportsLib.componentName('42 things'), 'Design42Things');
  assert.equal(exportsLib.componentName(''), 'Design');
});

test('toFlutter / toSwiftUI build a prompt with tokens as theme constants', () => {
  const f = exportsLib.toFlutter(SAMPLE, 'my landing page');
  assert.equal(f.language, 'dart');
  assert.equal(f.fileName, 'my_landing_page.dart');
  assert.equal(exportsLib.toFlutter(SAMPLE, 'pricing').fileName, 'pricing_page.dart');
  assert.equal(f.messages[0].role, 'system');
  assert.match(f.messages[0].content, /```dart/);
  assert.match(f.messages[1].content, /--accent: #2f6f4f/);
  assert.match(f.messages[1].content, /MyLandingPageTheme/);
  assert.doesNotMatch(f.messages[1].content, /alert\(1\)/);
  const s = exportsLib.toSwiftUI(SAMPLE, 'my landing page');
  assert.equal(s.language, 'swift');
  assert.equal(s.fileName, 'MyLandingPageView.swift');
  assert.match(s.messages[0].content, /SwiftUI/);
  assert.match(s.messages[1].content, /theme constants/);
});

test('codeFromReply takes the fenced block, preferring the language asked for', () => {
  const reply = 'Here:\n```text\nnot this one, it is longer than the code block\n```\n```dart\nclass A {}\n```\nDone.';
  assert.equal(exportsLib.codeFromReply(reply, 'dart'), 'class A {}\n');
  assert.equal(exportsLib.codeFromReply('struct V {}', 'swift'), 'struct V {}\n');
});

test('the Design Export menu offers the three framework exports', () => {
  assert.match(DESIGN, /React component \(\.tsx \+ \.css\)/);
  assert.match(DESIGN, /Flutter widget \(AI\)/);
  assert.match(DESIGN, /SwiftUI view \(AI\)/);
  assert.match(DESIGN, /exportsLib\.toReact\(/);
  assert.match(DESIGN, /exportsLib\.codeFromReply\(/);
});
