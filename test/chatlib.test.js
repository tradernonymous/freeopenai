const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODELS,
  DEFAULT_MODEL,
  isValidModel,
  escapeHtml,
  isAttachableFile,
  renderMarkdownLite,
  detectsImageIntent,
  isVisionCapable,
  DEFAULT_VISION_MODEL,
  isDocumentFile,
  isRateLimitError,
  safeJson,
  isToolsRejection,
  parseSseChunk,
} = require('../chatlib.js');

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

test('detectsImageIntent recognizes plain-language image requests', () => {
  assert.equal(detectsImageIntent('generate an image of a fox'), true);
  assert.equal(detectsImageIntent('create a picture of a sunset'), true);
  assert.equal(detectsImageIntent('draw me a logo for my coffee shop'), true);
  assert.equal(detectsImageIntent('Make an illustration of a robot'), true);
  assert.equal(detectsImageIntent('please design a poster for the concert'), true);
});

test('detectsImageIntent ignores prose that merely mentions an image-ish word', () => {
  assert.equal(detectsImageIntent('explain how image compression works'), false);
  assert.equal(detectsImageIntent('make a plan for my image website'), false);
  assert.equal(detectsImageIntent('what can you do for me?'), false);
  assert.equal(detectsImageIntent('create a budget spreadsheet'), false);
});

test('isVisionCapable accepts only confirmed vision models', () => {
  assert.equal(isVisionCapable('gpt-4o'), true);
  assert.equal(isVisionCapable('gpt-5.4-nano'), true);
  assert.equal(isVisionCapable('gpt-5.6-luna'), true);
  assert.equal(isVisionCapable('gpt-6-astra'), false);
  assert.equal(isVisionCapable('made-up-model'), false);
});

test('DEFAULT_VISION_MODEL is itself vision-capable and a known model', () => {
  assert.equal(isVisionCapable(DEFAULT_VISION_MODEL), true);
  assert.equal(isValidModel(DEFAULT_VISION_MODEL), true);
});

test('isDocumentFile recognizes pdf and docx only', () => {
  assert.equal(isDocumentFile('report.pdf'), true);
  assert.equal(isDocumentFile('resume.DOCX'), true);
  assert.equal(isDocumentFile('notes.txt'), false);
  assert.equal(isDocumentFile('photo.png'), false);
});

test('isRateLimitError recognizes the shapes a 429 actually arrives in', () => {
  assert.equal(isRateLimitError('429: {"status":429,"title":"Too Many Requests"} — rate limited, wait a moment'), true);
  assert.equal(isRateLimitError('too many requests'), true);
  assert.equal(isRateLimitError('Rate limit exceeded'), true);
  assert.equal(isRateLimitError({ message: 'You are being rate limited.' }), true);
  assert.equal(isRateLimitError('500: internal error'), false);
  assert.equal(isRateLimitError('402: Payment required'), false);
  assert.equal(isRateLimitError(''), false);
  assert.equal(isRateLimitError(null), false);
  assert.equal(isRateLimitError(undefined), false);
});

test('parseSseChunk extracts JSON payloads from data lines', () => {
  const chunk = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
  const parts = parseSseChunk(chunk);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].choices[0].delta.content, 'Hi');
  assert.equal(parts[1], '[DONE]');
});

test('parseSseChunk ignores comment lines and empty lines', () => {
  const chunk = ': heartbeat\ndata: {"id":"1"}\n\n\ndata: {"id":"2"}\n\n';
  const parts = parseSseChunk(chunk);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].id, '1');
  assert.equal(parts[1].id, '2');
});

test('parseSseChunk returns empty array for null or empty input', () => {
  assert.deepEqual(parseSseChunk(null), []);
  assert.deepEqual(parseSseChunk(''), []);
});

test('parseSseChunk skips unparseable data lines silently', () => {
  const chunk = 'data: {broken\ndata: {"ok":true}\n\n';
  const parts = parseSseChunk(chunk);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].ok, true);
});

test('safeJson passes a real body through untouched', async () => {
  const payload = { ok: true, choices: [] };
  const res = { json: async () => payload };
  const out = await safeJson(res);
  assert.deepEqual(out, payload);
  assert.ok(!out.parseFailed);
});

test('safeJson degrades an unreadable body into a retryable error, not a crash', async () => {
  const res = { json: async () => { throw new SyntaxError("Unexpected token 'u'"); } };
  const out = await safeJson(res);
  assert.equal(out.parseFailed, true);
  assert.match(out.error, /retry/i);
  assert.match(out.error, /unreadable/);
});

test('isToolsRejection flags shape failures only', () => {
  assert.equal(isToolsRejection(new Error("Unknown field 'tools'")), true);
  assert.equal(isToolsRejection(Object.assign(new Error('x'), { parseFailed: true })), true);
  assert.equal(isToolsRejection(Object.assign(new Error('bad'), { statusCode: 400 })), true);
  assert.equal(isToolsRejection(Object.assign(new Error('bad'), { statusCode: 422 })), true);
  assert.equal(isToolsRejection(Object.assign(new Error('forbidden'), { statusCode: 403 })), false);
  assert.equal(isToolsRejection(Object.assign(new Error('slow'), { statusCode: 429 })), false);
  assert.equal(isToolsRejection({ name: 'AbortError' }), false);
  assert.equal(isToolsRejection(null), false);
  assert.equal(isToolsRejection(undefined), false);
});
