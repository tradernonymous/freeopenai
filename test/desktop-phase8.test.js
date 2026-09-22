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
