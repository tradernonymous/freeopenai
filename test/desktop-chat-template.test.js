// A local model's own chat template (NEURA-055).
//
// A GGUF carries the Jinja template it was trained with; the shell's header
// reader now hands it to the page (src-tauri/src/gguf.rs, unit-tested there
// because it only compiles on CI), chat-template.js renders it under caps, and
// run-model.ts sends the result as the prompt -- falling back to the message
// list whenever anything about the template is not right.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tpl = require('../desktop/src/chat-template.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');

/** A stand-in for localStorage, so the cache is tested without a browser. */
function store() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

// Qwen/ChatML, as the real template is written: no bos_token, no eos_token,
// literal <|im_start|> markers and a system turn that must stay first.
const CHATML = [
  '{%- for message in messages %}',
  "{{- '<|im_start|>' + message.role + '\\n' + message.content + '<|im_end|>' + '\\n' }}",
  '{%- endfor %}',
  '{%- if add_generation_prompt %}',
  "{{- '<|im_start|>assistant\\n' }}",
  '{%- endif %}',
].join('\n');

// Llama 3 style: the template writes the BOS token itself, which the runtime
// would then write a second time.
const LLAMA3 = [
  '{{- bos_token }}',
  '{%- for message in messages %}',
  "{{- '<|start_header_id|>' + message.role + '<|end_header_id|>\\n\\n' + message.content | trim + '<|eot_id|>' }}",
  '{%- endfor %}',
  "{{- '<|start_header_id|>assistant<|end_header_id|>\\n\\n' }}",
].join('\n');

const CHAT = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi.' },
  { role: 'user', content: 'Again?' },
];

test('a ChatML template renders the exact prompt the model was trained on', () => {
  const out = tpl.render(CHATML, CHAT);
  assert.equal(out.reason, '');
  assert.equal(
    out.prompt,
    '<|im_start|>system\nYou are terse.<|im_end|>\n' +
      '<|im_start|>user\nHello<|im_end|>\n' +
      '<|im_start|>assistant\nHi.<|im_end|>\n' +
      '<|im_start|>user\nAgain?<|im_end|>\n' +
      '<|im_start|>assistant\n',
  );
  // The system turn keeps the place the template gives it -- first, inside the
  // model's own markers, which is the whole point of rendering the template.
  assert.ok(out.prompt.startsWith('<|im_start|>system'));
  // Nothing is left behind of the sentinels the renderer uses internally.
  assert.ok(!/\u0000/.test(out.prompt));
});

test('addGenerationPrompt off stops before the answer', () => {
  const out = tpl.render(CHATML, [{ role: 'user', content: 'Hi' }], { addGenerationPrompt: false });
  assert.equal(out.reason, '');
  assert.equal(out.prompt, '<|im_start|>user\nHi<|im_end|>\n');
});

test('a template that writes BOS itself does not write it twice', () => {
  // llama-server prepends the model's BOS when it tokenizes the prompt, so the
  // template's leading one is dropped rather than sent as text.
  const out = tpl.render(LLAMA3, [{ role: 'user', content: 'Hello' }]);
  assert.equal(out.reason, '');
  assert.ok(out.prompt.startsWith('<|start_header_id|>user<|end_header_id|>'));
  assert.ok(out.prompt.endsWith('<|start_header_id|>assistant<|end_header_id|>\n\n'));
  assert.ok(!/\u0000/.test(out.prompt));

  // Mid-prompt, the same token cannot be dropped: that render is refused.
  const midway = tpl.render('{% for m in messages %}{{ m.content }}{{ bos_token }}{% endfor %}', CHAT);
  assert.equal(midway.prompt, '');
  assert.match(midway.reason, /begin-of-text/);
});

test('a template that needs the end-of-sequence token falls back', () => {
  // Mistral-style: the header gives the token's id, never its text, so the
  // prompt cannot be built faithfully and the generic path is used instead.
  const out = tpl.render("{% for m in messages %}[INST] {{ m.content }} [/INST]{{ eos_token }}{% endfor %}", CHAT);
  assert.equal(out.prompt, '');
  assert.match(out.reason, /end-of-sequence/);
});

test('a model with no template falls back, and says so', () => {
  for (const none of ['', '   ', null, undefined, 42]) {
    const out = tpl.render(none, CHAT);
    assert.equal(out.prompt, '');
    assert.match(out.reason, /no chat template/);
  }
  // The same answer comes out of a header with no template key.
  assert.equal(tpl.templateOf({ architecture: 'llama', context_length: 8192 }), '');
  assert.equal(tpl.templateOf(null), '');
  assert.equal(tpl.templateOf({ chat_template: CHATML }), CHATML);
  // A header carrying something absurd is treated as no template at all.
  assert.equal(tpl.templateOf({ chat_template: 'x'.repeat(tpl.LIMITS.template + 1) }), '');
});

test('a broken template falls back with the reason, and never throws', () => {
  const unclosed = tpl.render('{% for m in messages %}{{ m.content }}', CHAT);
  assert.equal(unclosed.prompt, '');
  assert.match(unclosed.reason, /did not render/);

  const nonsense = tpl.render('{% for m in nowhere %}{{ m }}{% endfor %}', CHAT);
  assert.equal(nonsense.prompt, '');
  assert.match(nonsense.reason, /did not render/);

  // A template that renders to nothing is a fallback, not an empty prompt.
  const empty = tpl.render('{% if false %}never{% endif %}', CHAT);
  assert.equal(empty.prompt, '');
  assert.ok(empty.reason);
});

test('the size cap refuses a prompt that renders absurdly large', () => {
  // Four turns through four nested loops is 256 copies: 2560 characters.
  const big =
    '{% for a in messages %}{% for b in messages %}{% for c in messages %}{% for d in messages %}' +
    '0123456789' +
    '{% endfor %}{% endfor %}{% endfor %}{% endfor %}';
  const capped = tpl.render(big, CHAT, { maxOutput: 1024 });
  assert.equal(capped.prompt, '');
  assert.match(capped.reason, /rendered 2560 characters, past the 1024/);
  // One turn is one copy, and the same template renders.
  assert.equal(tpl.render(big, [{ role: 'user', content: 'hi' }], { maxOutput: 1024 }).prompt, '0123456789');
  // maxOutput never lifts the standing cap, it only lowers it.
  assert.ok(tpl.LIMITS.output >= 1024 * 1024);
});

test('a template that would loop on its own is refused before it runs', () => {
  // Jinja has no `while`, so the only loop the caller's own (capped) input does
  // not bound is range() over a constant: that template never runs.
  const bomb = tpl.render("{% for i in range(100000000) %}{{ 'x' }}{% endfor %}", CHAT);
  assert.equal(bomb.prompt, '');
  assert.match(bomb.reason, /loops over 100000000 steps/);

  // Ranging over the messages is normal and stays allowed.
  const fine = tpl.render('{% for i in range(messages | length) %}{{ messages[i].role }};{% endfor %}', CHAT);
  assert.equal(fine.reason, '');
  assert.equal(fine.prompt, 'system;user;assistant;user;');
});

test('the input caps refuse a chat too long to shape', () => {
  const many = Array.from({ length: tpl.LIMITS.messages + 1 }, () => ({ role: 'user', content: 'x' }));
  assert.match(tpl.render(CHATML, many).reason, /turns/);

  const huge = [{ role: 'user', content: 'x'.repeat(tpl.LIMITS.input + 1) }];
  assert.match(tpl.render(CHATML, huge).reason, /characters/);

  assert.match(tpl.render(CHATML, []).reason, /no messages/);
  assert.match(tpl.render('x'.repeat(tpl.LIMITS.template + 1), CHAT).reason, /past the/);
});

test('a picture turn renders as its text, because a prompt is text', () => {
  const out = tpl.render(CHATML, [
    { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
  ]);
  assert.equal(out.reason, '');
  assert.equal(out.prompt, '<|im_start|>user\nWhat is this?<|im_end|>\n<|im_start|>assistant\n');
});

test('tools reach a template that writes them, and are absent otherwise', () => {
  const template = '{% if tools %}TOOLS:{% for t in tools %}{{ t.function.name }};{% endfor %}{% endif %}{% for m in messages %}{{ m.content }}{% endfor %}';
  const offered = [{ type: 'function', function: { name: 'read_file' } }];
  assert.equal(tpl.render(template, [{ role: 'user', content: 'go' }], { tools: offered }).prompt, 'TOOLS:read_file;go');
  // No tools this turn: the template's tool branch must not be taken.
  assert.equal(tpl.render(template, [{ role: 'user', content: 'go' }], { tools: [] }).prompt, 'go');
  assert.equal(tpl.render(template, [{ role: 'user', content: 'go' }]).prompt, 'go');
});

test('a template is remembered per model, including "this file has none"', () => {
  const memory = store();
  assert.equal(tpl.cached('unsloth:a', memory), null, 'not asked yet');
  assert.ok(tpl.remember('unsloth:a', CHATML, memory));
  assert.equal(tpl.cached('unsloth:a', memory), CHATML);

  // '' is a real answer, so a model without a template is not re-read forever.
  assert.ok(tpl.remember('unsloth:b', '', memory));
  assert.equal(tpl.cached('unsloth:b', memory), '');
  assert.notEqual(tpl.cached('unsloth:b', memory), null);

  assert.ok(tpl.forget('unsloth:b', memory));
  assert.equal(tpl.cached('unsloth:b', memory), null);
  assert.equal(tpl.forget('unsloth:b', memory), false);

  // Damaged storage is not a crash: nothing is remembered, everything re-read.
  memory.setItem(tpl.CACHE_KEY, 'not json');
  assert.equal(tpl.cached('unsloth:a', memory), null);
});

test('the shell surfaces tokenizer.chat_template from the header', () => {
  const rust = read('desktop', 'src-tauri', 'src', 'gguf.rs');
  assert.match(rust, /pub chat_template: Option<String>/);
  assert.match(rust, /"tokenizer\.chat_template"/);
  // Kept only within the same cap every other kept string has.
  assert.match(rust, /"tokenizer\.chat_template" => info\.chat_template = Some\(s\)/);
});

test('run-model sends the rendered prompt, and falls back where it must', () => {
  const wiring = read('desktop', 'src', 'run-model.ts');
  assert.match(wiring, /from '@huggingface\/jinja'/);
  assert.match(wiring, /chatTemplate\.setEngine\(Template\)/);
  // The rendered prompt goes to the text-completion route; the message list
  // still goes to chat completions when anything falls back.
  assert.match(wiring, /\/v1\/completions/);
  assert.match(wiring, /return streamLocalChat\(/);
  // A turn with tools keeps the generic path: llama-server's --jinja is what
  // parses a tool call back out of the reply.
  assert.match(wiring, /if \(!\(offered && offered\.length\)\) \{/);
  // The header read that learns the context also learns the template.
  assert.match(wiring, /chatTemplate\.remember\(entry\.id, chatTemplate\.templateOf\(info\)\)/);
});

test('the dependency is declared where the desktop app is built', () => {
  const pkg = JSON.parse(read('desktop', 'package.json'));
  assert.ok(pkg.dependencies['@huggingface/jinja'], 'the renderer is a runtime dependency of the app');
  const lock = JSON.parse(read('desktop', 'package-lock.json'));
  assert.ok(lock.packages['node_modules/@huggingface/jinja'], 'the version is pinned in the lock file');
});
