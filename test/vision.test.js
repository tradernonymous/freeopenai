// An attached image used to reach Puter only. On every direct provider it was
// dropped without a word: the send path never carried it, and DEFAULT_VISION_MODEL
// is a Puter id that no other provider would accept.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  acceptsImages,
  modelForImage,
  isSendableImageUrl,
  withImageTurn,
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_IMAGE_EDGE,
} = require('../chatlib.js');
const { createRequestHandler, clearModelCache } = require('../server.js');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('only a model the catalogue marks as vision-capable counts as capable', () => {
  assert.equal(acceptsImages({ id: 'a', vision: true }), true);
  // Absent and false are different facts -- "the provider does not say" versus
  // "the catalogue says text-only" -- but neither one may be sent an image.
  assert.equal(acceptsImages({ id: 'a' }), false);
  assert.equal(acceptsImages({ id: 'a', vision: false }), false);
  assert.equal(acceptsImages(null), false);
  assert.equal(acceptsImages(undefined), false);
  assert.equal(acceptsImages({ id: 'a', vision: 'yes' }), false);
});

test('an image turn keeps a model that can already see', () => {
  const models = [{ id: 'text-only' }, { id: 'sees', vision: true }, { id: 'other', vision: true }];
  assert.equal(modelForImage(models, 'sees'), 'sees');
  // And picks the first one that can when the selection cannot.
  assert.equal(modelForImage(models, 'text-only'), 'sees');
});

test('a provider with nothing that sees images yields null, not a text-only turn', () => {
  // null is the caller's signal to explain and stop. Returning the requested
  // model instead is how the picture got silently ignored before.
  assert.equal(modelForImage([{ id: 'a' }, { id: 'b', vision: false }], 'a'), null);
  assert.equal(modelForImage([], 'a'), null);
  assert.equal(modelForImage(null, 'a'), null);
  // Junk in the list must not crash a turn in progress.
  assert.equal(modelForImage([null, {}, { id: 'sees', vision: true }], 'x'), 'sees');
});

test('only an inline image or a plain http(s) link may be sent', () => {
  assert.equal(isSendableImageUrl(PNG), true);
  assert.equal(isSendableImageUrl('https://example.com/a.png'), true);
  assert.equal(isSendableImageUrl('http://example.com/a.png'), true);
  // A provider must never be handed a script or a page dressed up as an image.
  assert.equal(isSendableImageUrl('javascript:alert(1)'), false);
  assert.equal(isSendableImageUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSendableImageUrl('data:image/svg+xml;base64,PHN2Zz4='), true);
  assert.equal(isSendableImageUrl(''), false);
  assert.equal(isSendableImageUrl(null), false);
  assert.equal(isSendableImageUrl(undefined), false);
});

test('the image is carried as content parts on the last user message', () => {
  const convo = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'what is this?' },
  ];
  const out = withImageTurn(convo, PNG, 'what is this?');
  assert.equal(out.length, convo.length);
  assert.deepEqual(out.slice(0, 3), convo.slice(0, 3), 'earlier turns are untouched');
  assert.deepEqual(out[3].content, [
    { type: 'text', text: 'what is this?' },
    { type: 'image_url', image_url: { url: PNG } },
  ]);
});

test('building the image turn does not touch the conversation it is given', () => {
  // The same conversation is re-sent when a model refuses, so mutating it here
  // would attach the picture to turns that follow.
  const convo = [{ role: 'user', content: 'hi' }];
  const before = JSON.parse(JSON.stringify(convo));
  withImageTurn(convo, PNG, 'hi');
  assert.deepEqual(convo, before);
});

test('an image with no words still carries a usable prompt', () => {
  // A bare image part with empty text is rejected by some providers.
  const out = withImageTurn([{ role: 'user', content: '' }], PNG, '');
  assert.equal(out[0].content[0].type, 'text');
  assert.ok(out[0].content[0].text.length > 0);
});

test('an unsendable image URL throws instead of quietly going out as text', () => {
  // Silently returning a text-only turn is precisely the bug being fixed, so
  // this must be loud.
  assert.throws(() => withImageTurn([{ role: 'user', content: 'hi' }], 'javascript:alert(1)', 'hi'), /Refusing to send/);
});

test('the image turn leaves a conversation that is already multimodal alone', () => {
  const convo = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
  assert.equal(withImageTurn(convo, PNG, 'hi')[0].content.length, 1);
});

test('nothing is attached when the last message is not the user turn', () => {
  const convo = [{ role: 'assistant', content: 'sure' }];
  assert.deepEqual(withImageTurn(convo, PNG, 'hi'), convo);
  assert.deepEqual(withImageTurn([], PNG, 'hi'), []);
});

// The client cap only works if it stays under the server's body limit. Lowering
// the limit without lowering this turns every photo into a 400 the user cannot
// explain, so the two numbers are checked against each other rather than by eye.
test('the image cap leaves room inside the chat endpoint body limit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf('function llmChat(');
  assert.notEqual(at, -1, 'server.js no longer defines llmChat() -- re-point this test');
  const scope = src.slice(at, src.indexOf('\nfunction ', at + 1));
  const match = scope.match(/readJsonBody\(req,\s*([\d\s*]+),/);
  assert.ok(match, 'llmChat no longer reads a body with an explicit limit -- re-point this test');
  const bodyLimit = match[1].split('*').reduce((total, part) => total * Number(part.trim()), 1);
  assert.ok(
    MAX_IMAGE_DATA_URL_CHARS < bodyLimit,
    `MAX_IMAGE_DATA_URL_CHARS (${MAX_IMAGE_DATA_URL_CHARS}) must stay under the chat body limit (${bodyLimit})`,
  );
  // And the re-encode has to actually shrink something, so the edge must exist.
  assert.ok(Number.isInteger(MAX_IMAGE_EDGE) && MAX_IMAGE_EDGE > 0);
});

// The catalogue is the only place that knows which models can see, so the
// served list has to carry that through -- the client cannot guess it.
const CATALOGUE = {
  object: 'list',
  data: [
    { id: 'inclusionai/ling-3.0-flash-vl:free', architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0', completion: '0' } },
    { id: 'cohere/north-mini-code:free', architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
    { id: 'poolside/laguna-s-2.1:free', pricing: { prompt: '0', completion: '0' } },
  ],
};

async function withCatalogue(run) {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(CATALOGUE));
  });
  await new Promise((r) => upstream.listen(0, r));
  const savedKey = process.env.OPENROUTER_API_KEY;
  const savedBase = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  clearModelCache();
  try {
    await run(`http://127.0.0.1:${app.address().port}`);
  } finally {
    app.close();
    upstream.close();
    clearModelCache();
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = savedBase;
  }
}

test('the served model list says which models can read images', async () => {
  await withCatalogue(async (base) => {
    const res = await fetch(base + '/api/llm/models?provider=openrouter');
    assert.equal(res.status, 200);
    const served = await res.json();
    const byId = new Map(served.map((m) => [m.id, m]));
    assert.equal(byId.get('inclusionai/ling-3.0-flash-vl:free').vision, true);
    assert.equal(byId.get('cohere/north-mini-code:free').vision, false);
    // A provider that publishes no modalities must leave the field absent, so
    // "unknown" stays distinguishable from "cannot" rather than reading as a
    // capability the model does not have.
    assert.equal('vision' in byId.get('poolside/laguna-s-2.1:free'), false);
  });
});
