const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler, fetchFailureReason } = require('../server.js');

// The reported symptom this covers: "Could not reach Antigravity: fetch failed".
// Three unrelated problems produce that sentence -- a name that does not
// resolve, a host with nothing listening, a connection that times out -- and
// they have three different fixes. undici puts the distinguishing part in
// `cause`, which the message used to drop on the floor.

test('a failure with no cause stays as bare as it was', () => {
  assert.equal(fetchFailureReason(new TypeError('fetch failed')), '');
  assert.equal(fetchFailureReason(undefined), '');
  assert.equal(fetchFailureReason(null), '');
});

test('the cause is named, with what it means', () => {
  assert.equal(
    fetchFailureReason({ cause: { code: 'ENOTFOUND' } }),
    ' (ENOTFOUND: the host name did not resolve)',
  );
  assert.equal(
    fetchFailureReason({ cause: { code: 'ECONNREFUSED' } }),
    ' (ECONNREFUSED: the host resolved but nothing is listening on that port)',
  );
});

test('an unknown code is still reported, just without a gloss', () => {
  assert.equal(fetchFailureReason({ cause: { code: 'EWEIRD' } }), ' (EWEIRD)');
});

test('every address is read, because one may refuse while another times out', () => {
  // autoSelectFamily tries each address a name resolves to and reports them
  // together. Reading only the first would have reported the wrong half.
  const aggregate = { cause: { errors: [{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }] } };
  assert.equal(
    fetchFailureReason(aggregate),
    ' (ECONNREFUSED: the host resolved but nothing is listening on that port; ETIMEDOUT: the connection timed out)',
  );
});

// Either bound in the walker stops a cycle, so this pins the property -- it
// cannot return, or crash, on a loop -- rather than one particular line:
// removing either guard alone still passes this, removing both does not.
test('a cause chain that loops does not hang', () => {
  const looping = {};
  looping.cause = looping;
  assert.equal(fetchFailureReason(looping), '');
});

// A keyless provider is one the operator runs. The vendor hint ("this is on
// their side, not your key") points at a key that does not exist -- and the
// localhost trap is real: the server making the call is not the browser.
async function chatWith(providerId, env) {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/api/llm/chat?provider=${providerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'antigravity-claude-opus-4-6-thinking-high', messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    app.close();
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

// A port that was open a moment ago and is now closed: a real connection
// refusal, without waiting out a timeout.
function closedPort() {
  const server = http.createServer();
  const port = new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
  return port.then((p) => {
    server.close();
    return p;
  });
}

test('a refused connection says so, and says it is your own endpoint', async () => {
  const port = await closedPort();
  const { status, body } = await chatWith('antigravity', { ANTIGRAVITY_BASE_URL: `http://127.0.0.1:${port}` });

  assert.equal(status, 502);
  assert.match(body.error, /Could not reach Antigravity/, 'still names the provider');
  assert.match(
    body.error,
    /the host resolved but nothing is listening on that port|the connection was closed as soon as it opened|the connection timed out/,
    'the cause is described, not dropped',
  );
  assert.match(body.error, /the endpoint you configured/, 'the self-hosted hint, not the vendor one');
  assert.doesNotMatch(body.error, /not your key/, 'there is no key for this provider');
});

test('a vendor provider gets the cause and no operator advice', async () => {
  const port = await closedPort();
  const { status, body } = await chatWith('nara', {
    NARA_API_KEY: 'k',
    NARA_BASE_URL: `http://127.0.0.1:${port}/v1`,
  });

  assert.equal(status, 502);
  assert.match(body.error, /Could not reach Nara/);
  assert.match(body.error, /nothing is listening on that port|closed as soon as it opened|timed out/);
  // The generic "this is on their side, not your key" hint used to be appended
  // here. Naming the cause is strictly more useful, and an explained message is
  // deliberately left alone -- so the assertion is that we did not fall back to
  // the advice written for the operator's own endpoint.
  assert.doesNotMatch(body.error, /the endpoint you configured/);
});
