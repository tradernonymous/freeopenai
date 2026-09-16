// The Android app opens the page with a fragment: "#new" from the launcher
// shortcut and Quick Settings tile, "#share=<text>" from the share sheet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseAppLink, MAX_SHARED_TEXT_CHARS } = require('../chatlib.js');

test('#new starts a chat', () => {
  assert.deepEqual(parseAppLink('#new'), { action: 'new' });
});

test('#share= decodes the shared text', () => {
  assert.deepEqual(parseAppLink('#share=' + encodeURIComponent('hello <b>world</b>\r\nline 2')), {
    action: 'share',
    text: 'hello <b>world</b>\nline 2',
  });
});

test('shared text is capped', () => {
  const link = parseAppLink('#share=' + encodeURIComponent('x'.repeat(MAX_SHARED_TEXT_CHARS + 50)));
  assert.equal(link.text.length, MAX_SHARED_TEXT_CHARS);
});

test('anything else is not an app link', () => {
  for (const hash of ['', '#', '#share=', '#share=%20%20', '#share=%E0%A4%A', '#newer', '#chat=1', null, undefined]) {
    assert.equal(parseAppLink(hash), null, String(hash));
  }
});

test('the page reads the link on load and on hashchange, as a value only', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /applyAppLink\(\);\s*window\.addEventListener\('hashchange', applyAppLink\);/);
  const body = html.slice(html.indexOf('function applyAppLink()'), html.indexOf('function initializeApp()'));
  assert.match(body, /history\.replaceState/);
  assert.match(body, /chatInput\.value =/);
  assert.doesNotMatch(body, /innerHTML|insertAdjacentHTML|eval\(/);
});
