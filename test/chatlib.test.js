const test = require('node:test');
const assert = require('node:assert/strict');
const { MODELS, DEFAULT_MODEL, isValidModel, escapeHtml, isAttachableFile } = require('../chatlib.js');

test('DEFAULT_MODEL is one of the known models', () => {
  assert.ok(isValidModel(DEFAULT_MODEL));
});

test('isValidModel rejects ids outside the curated list', () => {
  assert.equal(isValidModel('gpt-7-nova'), false);
  assert.equal(isValidModel('made-up-model'), false);
  assert.equal(isValidModel(''), false);
  assert.equal(isValidModel(undefined), false);
});

test('isValidModel accepts every curated model id', () => {
  for (const m of MODELS) {
    assert.equal(isValidModel(m.id), true);
  }
});

test('MODELS is non-empty and every entry has an id/name', () => {
  assert.ok(MODELS.length > 0);
  for (const m of MODELS) {
    assert.equal(typeof m.id, 'string');
    assert.equal(typeof m.name, 'string');
  }
});

test('escapeHtml neutralizes an XSS payload', () => {
  const out = escapeHtml('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'));
  assert.match(out, /&lt;img/);
});

test('escapeHtml escapes all five reserved characters', () => {
  assert.equal(escapeHtml(`& < > " '`), '&amp; &lt; &gt; &quot; &#39;');
});

test('isAttachableFile allows text-like extensions and rejects binaries', () => {
  assert.equal(isAttachableFile('notes.txt'), true);
  assert.equal(isAttachableFile('data.CSV'), true);
  assert.equal(isAttachableFile('photo.png'), false);
  assert.equal(isAttachableFile('app.exe'), false);
});
