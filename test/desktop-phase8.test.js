// Phase 8: chat parity -- Mermaid diagrams, pictures (file, paste, screen
// capture) for vision models, dictation through Whisper, and Ollama's own
// `think` switch with its reasoning folded like every other provider's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const composer = require('../desktop/src/composer.js');

test('a mermaid block offers a Diagram button and draws in strict mode, lazily', () => {
  const md = read('desktop', 'src', 'markdown.ts');
  assert.match(md, /\/\^mermaid\$\/i\.test\(lang\)/);
  assert.match(md, /code-diagram/);
  const diagram = read('desktop', 'src', 'diagram.ts');
  assert.match(diagram, /import\('mermaid'\)/, 'loaded on first use, never at start');
  assert.match(diagram, /securityLevel: 'strict'/);
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /renderMermaid\(block\?\.querySelector\('pre'\)/);
  const pkg = JSON.parse(read('desktop', 'package.json'));
  assert.ok(pkg.dependencies.mermaid, 'mermaid is a dependency');
});

test('pictures go out as OpenAI image parts, and Ollama gets bare base64', () => {
  const attach = read('desktop', 'src', 'attach-image.ts');
  assert.match(attach, /type: 'image_url', image_url: \{ url \}/);
  assert.match(attach, /MAX_SIDE = 1568/, 'scaled to what vision models read');
  assert.match(attach, /getDisplayMedia/, 'screen capture uses the system picker');
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /withImages\(m\.content, m\.images\)/);
  assert.match(chat, /window\.addEventListener\('paste', onPaste\)/, 'Ctrl+V attaches a picture');
  assert.match(chat, /case 'screenshot': clear\(\); screenshot\(\); return;/);
  assert.match(chat, /KEEP_IMAGES_LAST/, 'saved chats do not fill storage with pictures');
  const run = read('desktop', 'src', 'run-model.ts');
  assert.match(run, /replace\(\/\^data:\[\^,\]\*,\/, ''\)/, 'the data: prefix is stripped for Ollama');
  assert.match(run, /return ollamaImages\(message\);/);
});

test('/screenshot and /attach for pictures are in the slash menu', () => {
  const ids = composer.SLASH.map((c) => c.id);
  assert.ok(ids.includes('screenshot'));
  const attach = composer.SLASH.find((c) => c.id === 'attach');
  assert.ok(attach.aliases.includes('image'));
});

test('dictation records the mic and asks Whisper with the Hugging Face token', async () => {
  const dictate = read('desktop', 'src', 'dictate.ts');
  assert.match(dictate, /getUserMedia\(\{ audio: true \}\)/);
  assert.match(dictate, /router\.huggingface\.co\/hf-inference\/models\/\$\{WHISPER_MODEL\}/);
  assert.match(dictate, /MAX_SECONDS = 120/);
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /Win\+H/, 'without a token it points at Windows dictation');
  assert.match(chat, /onDictate=\{dictate\}/);
  const box = read('desktop', 'src', 'components', 'Composer.tsx');
  assert.match(box, /aria-pressed=\{dictation === 'recording'\}/);
});

// ---- thread sidebar (2.7) ----------------------------------------------------

const threads = require('../desktop/src/threads.js');

test('auto-titles are 2-4 words, filler and code dropped', () => {
  assert.equal(threads.autoTitle('Can you please write a poem about the ocean at night'), 'Poem ocean night');
  assert.equal(threads.autoTitle('fix ```js\nconst a = 1\n``` this bug in my parser'), 'Fix bug parser');
  assert.equal(threads.autoTitle('hi'), 'Hi');
  assert.equal(threads.autoTitle(''), 'New chat');
  assert.equal(threads.autoTitle('Summarise\n--- attached ---\nhuge document text'), 'Summarise');
  const words = threads.autoTitle('Explain Kubernetes pods deployments services ingress controllers').split(' ');
  assert.ok(words.length >= 2 && words.length <= 4);
});

test('sections: pinned first in pin order, folders A-Z, then the rest newest first', () => {
  const s = (id, t) => ({ id, title: id, updatedAt: t, messages: [{ role: 'user', content: 'about ' + id }] });
  const list = [s('a', 1), s('b', 5), s('c', 3), s('d', 4), s('e', 2)];
  let meta = threads.cleanMeta(null);
  meta = threads.togglePin(meta, 'c');
  meta = threads.togglePin(meta, 'e');
  meta = threads.setFolder(meta, 'a', 'Work');
  meta = threads.setFolder(meta, 'd', 'Alpha');
  const groups = threads.sections(list, meta, '');
  assert.deepEqual(groups.map((g) => g.title), ['Pinned', 'Alpha', 'Work', 'Recent']);
  assert.deepEqual(groups[0].items.map((x) => x.id), ['e', 'c'], 'latest pin on top');
  assert.deepEqual(groups[3].items.map((x) => x.id), ['b']);
  assert.deepEqual(threads.sections(list, meta, 'about d').map((g) => g.title), ['Alpha'], 'search spans messages');
  assert.deepEqual(threads.togglePin(meta, 'e').pinned, ['c'], 'a second toggle unpins');
  assert.equal(threads.setFolder(meta, 'a', '  ').folders.a, undefined, 'an empty name unfiles');
});

test('the hover card shows the last real message, without reasoning', () => {
  const session = { messages: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: '<think>hmm</think>The answer is 42.' },
    { role: 'assistant', content: 'note', note: true },
  ] };
  assert.equal(threads.preview(session), 'The answer is 42.');
  assert.equal(threads.preview({ messages: [] }), 'No messages yet.');
});

test('the History panel is live: it redraws on save and spins on busy chats', () => {
  const panel = read('desktop', 'src', 'components', 'SessionManager.tsx');
  assert.match(panel, /threads\.CHANGED_EVENT, load/);
  assert.match(panel, /thread-spinner/);
  assert.match(panel, /role="tooltip"/);
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /window\.dispatchEvent\(new Event\(threads\.CHANGED_EVENT\)\)/);
  assert.match(chat, /threads\.ACTIVITY_EVENT, \{ detail: \{ id: busyChat\.current, busy: false \} \}/);
  assert.match(chat, /threads\.autoTitle\(text\)/);
});

// ---- selection toolbar (5.8) --------------------------------------------------

test('the selection hotkey copies from the app in front and opens Quick with actions', () => {
  const rs = read('desktop', 'src-tauri', 'src', 'selection.rs');
  assert.match(rs, /DEFAULT_HOTKEY: &str = "alt\+shift\+space"/);
  assert.match(rs, /keybd_event\(VK_C, 0, 0, 0\)/, 'sends Ctrl+C');
  assert.match(rs, /GetClipboardSequenceNumber/, 'waits for the copy to land');
  assert.match(rs, /CF_UNICODETEXT/);
  const quick = read('desktop', 'src-tauri', 'src', 'quick.rs');
  assert.match(quick, /crate::selection::capture\(app\)/);
  assert.match(quick, /is already the Quick window hotkey/, 'the two hotkeys cannot collide');
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /selection::quick_take_selection/);
  assert.match(main, /quick::register_selection\(app\.handle\(\), selection::DEFAULT_HOTKEY\)/);
  const ask = read('desktop', 'src', 'screens', 'QuickAsk.tsx');
  for (const label of ['Explain', 'Summarise', 'Translate', 'Rewrite']) assert.ok(ask.includes(`label: '${label}'`), label);
  assert.match(ask, /quickTakeSelection\(\)/);
  const card = read('desktop', 'src', 'components', 'ShortcutsCard.tsx');
  assert.match(card, /Ask about selected text, in any app/);
});

test('Ollama think follows /reasoning, and its thinking is folded into <think>', () => {
  const run = read('desktop', 'src', 'run-model.ts');
  assert.match(run, /if \(reasoning === 'off'\) return false;/);
  assert.match(run, /\/gpt-oss\/i\.test\(model\) \? reasoning : true/);
  assert.match(run, /\.\.\.\(think !== undefined \? \{ think \} : \{\}\)/, 'unset leaves the model default');
  assert.match(run, /row\.message\.thinking/);
  assert.match(run, /onFrame\(\{ content: '<\/think>' \}\)/);
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /offered, active\.reasoning\);/);
});
