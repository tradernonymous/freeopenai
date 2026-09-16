const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODELS,
  DEFAULT_MODEL,
  isValidModel,
  escapeHtml,
  renderMarkdownLite,
  highlightCode,
  detectCodeLanguage,
  detectsImageIntent,
  isVisionCapable,
  DEFAULT_VISION_MODEL,
  isRateLimitError,
  isRetryableStatus,
  safeJson,
  isToolsRejection,
  parseSseChunk,
  describeAttachmentCost,
  HISTORY_TOKEN_BUDGET,
  imageMediaType,
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

test('renderMarkdownLite renders a fenced code block with a language label and highlighting', () => {
  // The fence used to come out as a bare <pre><code>; a coding answer wants
  // the ChatGPT/GitHub shape -- a labelled, highlighted block -- so the
  // language rides along as data-lang/language-* and the inside is lit.
  const out = renderMarkdownLite('```js\nconst x = "<b>";\n```');
  assert.equal(
    out,
    '<pre data-lang="js"><code class="language-js"><span class="tok-k">const</span> x = ' +
      '<span class="tok-s">&quot;&lt;b&gt;&quot;</span>;</code></pre>',
  );
});

test('renderMarkdownLite leaves an unknown language unhighlighted but labelled', () => {
  assert.equal(
    renderMarkdownLite('```brainfuck\n++[->+<]\n```'),
    '<pre data-lang="brainfuck"><code class="language-brainfuck">++[-&gt;+&lt;]</code></pre>',
  );
});

test('renderMarkdownLite never lets a fence language smuggle in a live tag', () => {
  // ```<img> cannot even open a fence (the language slot is \w*), so the
  // whole thing stays literal text -- which the escape then neutralizes.
  const out = renderMarkdownLite('```<img>\ncode\n```');
  assert.ok(!out.includes('<img'));
  assert.match(out, /&lt;img&gt;/);
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

test('renderMarkdownLite renders [title](url) as a link', () => {
  const out = renderMarkdownLite('See [the docs](https://example.com/docs).');
  assert.equal(
    out,
    'See <a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">the docs</a>.',
  );
});

test('renderMarkdownLite renders a link inside a list item', () => {
  const out = renderMarkdownLite('- [Docs](https://example.com)');
  assert.equal(
    out,
    '<ul><li><a href="https://example.com" target="_blank" rel="noopener noreferrer">Docs</a></li></ul>',
  );
});

test('renderMarkdownLite formats a link label with the other inline rules', () => {
  const out = renderMarkdownLite('[**Bold** and `code`](https://example.com)');
  assert.equal(
    out,
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">' +
      '<strong>Bold</strong> and <code>code</code></a>',
  );
});

test('renderMarkdownLite renders headings, and leaves a hash without a space alone', () => {
  assert.equal(renderMarkdownLite('## Title'), '<h2>Title</h2>');
  assert.equal(renderMarkdownLite('#hashtag stays'), '#hashtag stays');
});

test('renderMarkdownLite renders blockquotes and horizontal rules', () => {
  assert.equal(renderMarkdownLite('> hello\n> world'), '<blockquote>hello<br>world</blockquote>');
  assert.equal(renderMarkdownLite('---'), '<hr>');
});

test('renderMarkdownLite renders a GFM table with alignment', () => {
  assert.equal(
    renderMarkdownLite('| a | b |\n|:---|---:|\n| c | d |'),
    '<div class="table-wrap"><table><thead><tr><th>a</th><th style="text-align: right">b</th></tr></thead>' +
      '<tbody><tr><td>c</td><td style="text-align: right">d</td></tr></tbody></table></div>',
  );
});

test('renderMarkdownLite leaves pipe text without a delimiter row alone', () => {
  assert.equal(renderMarkdownLite('| a | b |\nno delimiter here'), '| a | b |<br>no delimiter here');
});

test('renderMarkdownLite formats table cells with the same rules as prose', () => {
  // Raw formatting tags render everywhere prose does, including cells -- the
  // refusal cases below (script, handlers, bad schemes) are what stay escaped.
  const out = renderMarkdownLite('| a | b |\n|---|---|\n| <b>x</b> | **c** |');
  assert.match(out, /<td><b>x<\/b><\/td><td><strong>c<\/strong><\/td>/);
});

test('renderMarkdownLite renders an allowlisted HTML subset and escapes the rest', () => {
  assert.equal(
    renderMarkdownLite('<details><summary>Why</summary>Because.</details>'),
    '<details><summary>Why</summary>Because.</details>',
  );
  assert.equal(renderMarkdownLite('Press <kbd>Ctrl</kbd> + <kbd>P</kbd>'), 'Press <kbd>Ctrl</kbd> + <kbd>P</kbd>');
  assert.equal(renderMarkdownLite('<B>loud</B>'), '<b>loud</b>');
  assert.equal(
    renderMarkdownLite('<a href="https://example.com">Docs</a>'),
    '<a href="https://example.com">Docs</a>',
  );
  // Refusals stay visible as text: a script tag, a hostile scheme, an event
  // handler, a tracking pixel, and an unclosed bracket never become elements.
  // (The words survive escaped -- `&lt;a onclick=...` -- which is exactly the
  // safe outcome; what must never appear is the live element itself.)
  const refusals = [
    ['<script>alert(1)</script>', '<script'],
    ['<a href="javascript:alert(1)">x</a>', '<a '],
    ['<a onclick="alert(1)" href="https://example.com">x</a>', '<a '],
    ['<img src="https://example.com/p.png">', '<img'],
    ['<b oops', '<b'],
    ['<!-- hidden -->', '<!--'],
    ['<a title="t" href="https://example.com">x</a>', '<a '],
  ];
  for (const [source, liveBit] of refusals) {
    const out = renderMarkdownLite(source);
    assert.ok(!out.includes(liveBit), `${source} grew a live element`);
  }
  assert.match(renderMarkdownLite('<details open>Hi</details>'), /<details open>Hi<\/details>/);
});

test('renderMarkdownLite leaves allowlisted tags inside code alone', () => {
  assert.equal(renderMarkdownLite('`<b>`'), '<code>&lt;b&gt;</code>');
});

test('renderMarkdownLite renders task lists as disabled checkboxes', () => {
  assert.equal(
    renderMarkdownLite('- [ ] todo\n- [x] done'),
    '<ul><li class="task"><input type="checkbox" disabled> todo</li>' +
      '<li class="task"><input type="checkbox" disabled checked> done</li></ul>',
  );
});

test('renderMarkdownLite renders strikethrough', () => {
  assert.equal(renderMarkdownLite('~~gone~~ stays'), '<del>gone</del> stays');
});

test('renderMarkdownLite keeps a continued ordered list numbered from its start', () => {
  assert.equal(renderMarkdownLite('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
});

test('renderMarkdownLite nests a two-space-indented list inside its parent', () => {
  assert.equal(
    renderMarkdownLite('- a\n  - b\n- c'),
    '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>',
  );
});

test('renderMarkdownLite autolinks a bare URL and leaves trailing punctuation outside', () => {
  assert.equal(
    renderMarkdownLite('See https://example.com/a.'),
    'See <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>.',
  );
});

test('renderMarkdownLite keeps balanced parens inside an autolinked URL', () => {
  assert.match(
    renderMarkdownLite('(see https://en.wikipedia.org/wiki/Foo_(bar))'),
    /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/,
  );
});

test('renderMarkdownLite never autolinks inside code', () => {
  assert.equal(renderMarkdownLite('`https://example.com`'), '<code>https://example.com</code>');
});

test('highlightCode lights keywords, strings, numbers, calls and comments', () => {
  assert.equal(
    highlightCode('const x = foo(42); // hi', 'js'),
    '<span class="tok-k">const</span> x = <span class="tok-f">foo</span>(<span class="tok-n">42</span>); <span class="tok-c">// hi</span>',
  );
  assert.match(highlightCode('SELECT * FROM t WHERE a = 1', 'sql'), /<span class="tok-k">SELECT<\/span>/);
  assert.match(
    highlightCode('<div class="a">x</div>', 'html'),
    /<span class="tok-k">&lt;div class=&quot;a&quot;<\/span>&gt;/,
  );
  assert.equal(highlightCode('x = 1', 'cobol'), 'x = 1');
});

test('detectCodeLanguage names an obvious language and stays quiet otherwise', () => {
  // Conservative by design: the winner needs two points and a clear margin,
  // so ties (import x from "y" reads as both JS and Python) and whispers
  // stay plain rather than guessing wrong.
  assert.equal(detectCodeLanguage('def foo():\n    return None'), 'py');
  assert.equal(detectCodeLanguage('const x = () => 1;'), 'js');
  assert.equal(detectCodeLanguage('{"a": 1}'), 'json');
  assert.equal(detectCodeLanguage('SELECT *\nFROM users'), 'sql');
  assert.equal(detectCodeLanguage('#!/bin/bash\necho hi'), 'sh');
  assert.equal(detectCodeLanguage('<div class="a">x</div>'), 'html');
  assert.equal(detectCodeLanguage('#include <stdio.h>\nint main() { }'), 'c');
  assert.equal(detectCodeLanguage('import x from "y";'), null);
  assert.equal(detectCodeLanguage('npm test'), null);
  assert.equal(detectCodeLanguage('x = 1'), null);
  assert.equal(detectCodeLanguage('hello world'), null);
  assert.equal(detectCodeLanguage('done'), null);
});

test('renderMarkdownLite highlights a bare fence when the language is obvious, without labelling it', () => {
  // Detection colours the inside only: no data-lang is ever guessed, so an
  // uncertain block stays exactly the plain <pre><code> it always was.
  assert.equal(
    renderMarkdownLite('```\nconst x = 1;\n```'),
    '<pre><code><span class="tok-k">const</span> x = <span class="tok-n">1</span>;</code></pre>',
  );
  assert.equal(renderMarkdownLite('```\nnpm test\n```'), '<pre><code>npm test</code></pre>');
});

test('renderMarkdownLite refuses link schemes that could execute script', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/plain,hi', 'vbscript:msgbox(1)']) {
    const source = `[click](${url})`;
    const out = renderMarkdownLite(source);
    assert.equal(out.includes('<a '), false, `${url} must not become an anchor`);
    assert.equal(out, source);
  }
});

test('renderMarkdownLite does not let a url break out of the href attribute', () => {
  const out = renderMarkdownLite('[x](https://example.com " onmouseover=alert(1) x=")');
  assert.equal(out.includes('<a '), false);
  assert.equal(out, '[x](https://example.com &quot; onmouseover=alert(1) x=&quot;)');
});

test('renderMarkdownLite keeps a url intact when it contains markdown characters', () => {
  // Regression, and the reason links are held behind a token: if the emphasis
  // passes ran over the finished anchor, _x_ and *b* inside the url would be
  // rewritten as <em> and corrupt the href.
  assert.equal(
    renderMarkdownLite('[x](https://example.com/_x_)'),
    '<a href="https://example.com/_x_" target="_blank" rel="noopener noreferrer">x</a>',
  );
  assert.equal(
    renderMarkdownLite('[x](https://example.com/a*b*c)'),
    '<a href="https://example.com/a*b*c" target="_blank" rel="noopener noreferrer">x</a>',
  );
});

test('renderMarkdownLite keeps balanced parentheses in a url', () => {
  const out = renderMarkdownLite('[W](https://en.wikipedia.org/wiki/Foo_(bar))');
  assert.match(out, /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
});

test('renderMarkdownLite leaves a link inside code alone', () => {
  assert.equal(
    renderMarkdownLite('`[x](https://example.com)`'),
    '<code>[x](https://example.com)</code>',
  );
  assert.equal(
    renderMarkdownLite('```\n[x](https://example.com)\n```'),
    '<pre><code>[x](https://example.com)</code></pre>',
  );
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

test('isRetryableStatus marks quotas, server failures and silence as worth another try', () => {
  assert.equal(isRetryableStatus(429), true, 'a rate limit is a transient refusal');
  for (const status of [500, 502, 503, 504, 524, 599]) {
    assert.equal(isRetryableStatus(status), true, `${status} is a server-side failure`);
  }
  assert.equal(isRetryableStatus(0), true, 'no response at all is retried');
  assert.equal(isRetryableStatus(undefined), false);
  assert.equal(isRetryableStatus(null), false);
  assert.equal(isRetryableStatus('429'), false, 'a string status is not a status');
  for (const status of [200, 400, 401, 402, 403, 404, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} is a fixed outcome, not retried`);
  }
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

test('an attachment says what it costs before it is sent', () => {
  // A pasted file is the one thing in a prompt that nothing trims: the history
  // behind it is budgeted, and the attachment arrives whole. So the number is
  // shown, in the same estimate the history budget is spent in, and one that
  // outweighs the entire trim is flagged rather than silently sent.
  assert.equal(describeAttachmentCost({ kind: 'text', content: 'x'.repeat(400) }).label, '~100 tokens');
  assert.equal(describeAttachmentCost({ kind: 'text', content: 'x'.repeat(4000) }).label, '~1.0k tokens');
  assert.equal(describeAttachmentCost({ kind: 'text', content: 'x'.repeat(HISTORY_TOKEN_BUDGET * 4) }).heavy, false);
  const heavy = describeAttachmentCost({ kind: 'text', content: 'x'.repeat(HISTORY_TOKEN_BUDGET * 4 + 4) });
  assert.equal(heavy.heavy, true);
  assert.equal(heavy.tokens, HISTORY_TOKEN_BUDGET + 1);
  // Nothing to show, rather than a made-up number: an empty file costs nothing,
  // and a picture is bytes no character estimate can speak for.
  assert.equal(describeAttachmentCost({ kind: 'text', content: '' }), null);
  assert.equal(describeAttachmentCost({ kind: 'image', name: 'shot.png' }), null);
  assert.equal(describeAttachmentCost(null), null);
});

test('a picture is labelled with the type its service named', () => {
  // The label is not decoration: an edit sends the picture back as a data URL
  // and the server reads the type out of it. Labelling a JPEG as PNG made every
  // edit of a drawn picture carry a type its bytes contradict.
  assert.equal(imageMediaType({ media_type: 'image/jpeg' }), 'image/jpeg');
  assert.equal(imageMediaType({ mime_type: 'image/webp' }), 'image/webp');
  assert.equal(imageMediaType({ media_type: 'IMAGE/JPEG' }), 'image/jpeg');
  // A response that names none is what an OpenAI-shaped endpoint returns.
  assert.equal(imageMediaType({ b64_json: 'x' }), 'image/png');
  // Anything that is not an image type is not allowed to become the label.
  assert.equal(imageMediaType({ media_type: 'text/html' }), 'image/png');
  assert.equal(imageMediaType({ media_type: 'image/png; charset=x' }), 'image/png');
  assert.equal(imageMediaType(null), 'image/png');
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
