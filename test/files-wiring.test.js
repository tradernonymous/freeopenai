// The Files & Office surface: the engine must run in node (it does -- the
// file-engine tests prove the logic), so here we assert the *wiring*: the
// screen really calls these modules, the Rust shell really exposes the save
// command, and the chat attachment handoff really lands in the composer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.join(__dirname, '..', 'desktop');
const read = (...p) => fs.readFileSync(path.join(DESKTOP, ...p), 'utf8');

test('FilesScreen drives the UMD office/pdf engines and the save bridge', () => {
  const src = read('src', 'screens', 'FilesScreen.tsx');
  assert.match(src, /FreeOffice/, 'the office engine is picked up off globalThis');
  assert.match(src, /FreePdf/, 'the pdf engine is picked up off globalThis');
  assert.match(src, /office\.extractDocxText/, 'docx extraction wired');
  assert.match(src, /pdf\.extractPdfText/, 'pdf extraction wired');
  assert.match(src, /office\.writeDocx[\s\S]*office\.writeXlsx[\s\S]*office\.writePptx/, 'all three writers wired');
  assert.match(src, /saveFile\(/, 'saving goes through the bridge');
  assert.match(src, /freeai4u\.pendingAttachment/, 'extract hands off to chat');
  assert.match(src, /image_url/, 'the image-describe bridge sends a content array');
});

test('the Rust shell registers the save dialog command', () => {
  const main = read('src-tauri', 'src', 'main.rs');
  assert.match(main, /mod save;/, 'the save module is compiled in');
  assert.match(main, /save::save_file_dialog/, 'the command is registered on the builder');
  const save = read('src-tauri', 'src', 'save.rs');
  assert.match(save, /rfd::FileDialog/, 'the dialog is a real native one');
  assert.match(save, /write_all/, 'the bytes actually land on disk');
  const cargo = read('src-tauri', 'Cargo.toml');
  assert.match(cargo, /base64/, 'the payload codec is a declared dependency');
});

test('the chat composer consumes staged attachments', () => {
  const chat = read('src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /freeai4u\.pendingAttachment/, 'the staged key matches what FilesScreen writes');
  assert.match(chat, /freeai4u-attach/, 'the event name matches');
  assert.match(chat, /attach-chip/, 'the user can see and drop the attachment');
  assert.match(chat, /--- attached ---/, 'the attachment rides the message body');
});

test('Files is navigable', () => {
  const sidebar = read('src', 'Sidebar.tsx');
  assert.match(sidebar, /id: 'files'/, 'the sidebar has the item');
  const app = read('src', 'App.tsx');
  assert.match(app, /FilesScreen/, 'the app renders the screen');
  assert.match(app, /'files'/, 'the view type includes it');
});
