// The Android app opens the page with a fragment: "#new" from the launcher
// shortcut and Quick Settings tile, "#share=<text>" from the share sheet.
// "#fork=<id>" is the same idea from the other direction: the read-only
// /s/<id> reader page hands its own id back in here so a "Fork" tap can
// become a chat of the reader's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseAppLink, MAX_SHARED_TEXT_CHARS } = require('../chatlib.js');

const SHARE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('#new starts a chat', () => {
  assert.deepEqual(parseAppLink('#new'), { action: 'new' });
});

test('#fork= reads a well-formed share id', () => {
  assert.deepEqual(parseAppLink('#fork=' + SHARE_ID), { action: 'fork', id: SHARE_ID });
  assert.deepEqual(parseAppLink('#fork=' + SHARE_ID.toUpperCase()), { action: 'fork', id: SHARE_ID.toUpperCase() },
    'server.js hands out lowercase hex, but the check itself is case-insensitive');
});

test('#fork= refuses anything that is not exactly the share id shape', () => {
  for (const bad of ['#fork=', '#fork=short', '#fork=' + SHARE_ID + 'x', '#fork=../etc/passwd', '#fork=<script>']) {
    assert.equal(parseAppLink(bad), null, bad);
  }
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
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(appJs, /applyAppLink\(\);\s*window\.addEventListener\('hashchange', applyAppLink\);/);
  const body = appJs.slice(appJs.indexOf('function applyAppLink()'), appJs.indexOf('function initializeApp()'));
  assert.match(body, /history\.replaceState/);
  assert.match(body, /chatInput\.value =/);
  assert.doesNotMatch(body, /innerHTML|insertAdjacentHTML|eval\(/);
});
