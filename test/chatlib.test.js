const test = require('node:test');
const assert = require('node:assert/strict');
const { MODELS, DEFAULT_MODEL, isValidModel, escapeHtml, isAttachableFile, renderMarkdownLite } = require('../chatlib.js');

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

test('renderMarkdownLite renders bold, italic, and inline code', () => {
  const out = renderMarkdownLite('**bold** and *italic* and `code`');
  assert.equal(out, '<strong>bold</strong> and <em>italic</em> and <code>code</code>');
});

test('renderMarkdownLite renders unordered and ordered lists', () => {
  const ul = renderMarkdownLite('- one\n- two');
  assert.equal(ul, '<ul><li>one</li><li>two</li></ul>');

  const ol = renderMarkdownLite('1. one\n2. two');
  assert.equal(ol, '<ol><li>one</li><li>two</li></ol>');
});

test('renderMarkdownLite renders a fenced code block and escapes its contents', () => {
  const out = renderMarkdownLite('```js\nconst x = "<b>";\n```');
  assert.equal(out, '<pre><code>const x = &quot;&lt;b&gt;&quot;;</code></pre>');
});

test('renderMarkdownLite mixes prose, a list, and a code block in one message', () => {
  const out = renderMarkdownLite('Steps:\n- **first** step\n- second step\n\n```\nnpm test\n```');
  assert.match(out, /<ul><li><strong>first<\/strong> step<\/li><li>second step<\/li><\/ul>/);
  assert.match(out, /<pre><code>npm test<\/code><\/pre>/);
});

test('renderMarkdownLite never lets markdown syntax smuggle in a live tag', () => {
  const out = renderMarkdownLite('**<img src=x onerror=alert(1)>**');
  assert.ok(!out.includes('<img'));
  assert.equal(out, '<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
});

test('renderMarkdownLite still escapes raw HTML with no markdown involved', () => {
  const out = renderMarkdownLite('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'));
  assert.match(out, /&lt;script&gt;/);
});
