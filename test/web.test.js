const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  createRequestHandler,
  extractPageText,
  normalizeDdG,
  normalizeWiki,
  normalizeWikiFull,
  isPrivateIp,
} = require('../server.js');

async function startApp() {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  return app;
}

test('extractPageText drops scripts and decodes entities', () => {
  const { title, text } = extractPageText(
    '<html><head><title>T &amp; Co</title><style>.x{}</style></head>' +
    '<body><nav>menu</nav><script>alert(1)</script><h1>Hello&nbsp;world</h1><!-- c --></body></html>'
  );
  assert.equal(title, 'T & Co');
  assert.equal(text, 'Hello world');
});

test('extractPageText survives junk', () => {
  assert.deepEqual(extractPageText(''), { title: '', text: '' });
  assert.deepEqual(extractPageText(null), { title: '', text: '' });
  assert.ok(extractPageText('<p>a<br>b</p>').text.includes('a'));
});

test('normalizeDdG reads abstracts and topic lists', () => {
  const out = normalizeDdG({
    AbstractText: 'Deno is a runtime',
    AbstractURL: 'https://deno.com/',
    AbstractSource: 'Wikipedia',
    RelatedTopics: [
      { Text: 'Deno Deploy stuff', FirstURL: 'https://deno.com/deploy' },
      { Topics: [{ Text: 'Nested topic here', FirstURL: 'https://example.com/n' }] },
      { Text: 'no url here' },
    ],
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].url, 'https://deno.com/');
  assert.match(out[0].snippet, /Wikipedia/);
});

test('normalizeDdG rejects junk and non-http urls', () => {
  assert.deepEqual(normalizeDdG(null), []);
  assert.deepEqual(normalizeDdG({ RelatedTopics: [{ Text: 'x', FirstURL: 'javascript:void(0)' }] }), []);
});

test('normalizeWiki reads the opensearch shape', () => {
  const out = normalizeWiki(['q', ['Deno (software)'], ['A runtime'], ['https://en.wikipedia.org/wiki/Deno']]);
  assert.deepEqual(out, [{ title: 'Deno (software)', url: 'https://en.wikipedia.org/wiki/Deno', snippet: 'A runtime' }]);
  assert.deepEqual(normalizeWiki({}), []);
});

test('normalizeWikiFull reads full-text hits and strips snippet tags', () => {
  const out = normalizeWikiFull({ query: { search: [
    { title: 'Deno (software)', snippet: 'open-source <span class="searchmatch">Deno</span> project' },
    { title: '', snippet: 'junk' },
  ] } });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://en.wikipedia.org/wiki/Deno_(software)');
  assert.equal(out[0].snippet, 'open-source Deno project');
  assert.deepEqual(normalizeWikiFull({}), []);
});

test('isPrivateIp blocks loopback, private and link-local', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '', null]) {
    assert.ok(isPrivateIp(ip), `${ip} must be blocked`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.0.1']) {
    assert.ok(!isPrivateIp(ip), `${ip} must pass`);
  }
});

test('websearch without q is a 400', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/websearch`);
    assert.equal(res.status, 400);
  } finally {
    app.close();
  }
});

test('fetch without a url is a 400', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/fetch`);
    assert.equal(res.status, 400);
  } finally {
    app.close();
  }
});

test('fetch rejects non-http schemes without touching the network', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/fetch?url=` + encodeURIComponent('file:///etc/passwd'));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /http\(s\)/);
  } finally {
    app.close();
  }
});

test('fetch refuses loopback and private hosts', async () => {
  const app = await startApp();
  try {
    for (const url of ['http://127.0.0.1:9/', 'http://10.0.0.1/', 'http://localhost:3000/']) {
      const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/fetch?url=` + encodeURIComponent(url));
      assert.ok(res.status === 403 || res.status === 502, `${url} got ${res.status}`);
      if (res.status === 403) assert.match((await res.json()).error, /not readable/);
    }
  } finally {
    app.close();
  }
});
