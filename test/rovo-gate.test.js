// deploy/rovo-proxy/gate.js is the only thing between a public tunnel URL and an
// Atlassian account's 5M-token daily allowance. The shim behind it strips
// Authorization by design, so if this leaks, the allowance leaks.
//
// It ships in this repo, so it is tested here: started as a real process against
// a stub upstream, and asked the questions that matter — does it refuse to run
// unguarded, does it turn away a caller without the key, and does it stream.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');

const GATE = path.join(__dirname, '..', 'deploy', 'rovo-proxy', 'gate.js');

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Answers like the shim: a catalogue, and a chat that streams if asked.
function stubShim() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'claude-sonnet-4' }] }));
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 120);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  return { server, hits };
}

async function withGate({ key, allowNoKey } = {}, run) {
  const { server, hits } = stubShim();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const shimPort = server.address().port;
  const port = await freePort();

  const env = {
    ...process.env,
    PORT: String(port),
    ROVO_SHIM_HOST: '127.0.0.1',
    ROVO_SHIM_PORT: String(shimPort),
  };
  delete env.ROVO_API_KEY;
  if (key !== undefined) env.ROVO_API_KEY = key;
  if (allowNoKey) env.ROVO_ALLOW_NO_KEY = '1';
  else delete env.ROVO_ALLOW_NO_KEY;

  const child = spawn(process.execPath, [GATE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  // Either it listens, or it exits — whichever happens first.
  const listening = (async () => {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) return false;
      try {
        await fetch('http://127.0.0.1:' + port + '/gate/health');
        return true;
      } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    return false;
  })();
  const up = await listening;

  try {
    await run({ base: 'http://127.0.0.1:' + port, hits, up, child, exited, log: () => out });
  } finally {
    if (child.exitCode === null) child.kill();
    server.close();
  }
}

test('it refuses to start with no key, rather than standing open', async () => {
  await withGate({}, async ({ up, exited, log }) => {
    assert.equal(up, false, 'the gate came up unguarded');
    assert.equal(await exited, 1, 'an unguarded gate must exit non-zero');
    // The message has to say what to do, because this fires on someone's first
    // `docker compose up` and a bare stack trace teaches nothing.
    assert.match(log(), /ROVO_API_KEY is not set/);
    assert.match(log(), /ROVO_ALLOW_NO_KEY=1/);
  });
});

test('ROVO_ALLOW_NO_KEY is the deliberate way to run it open', async () => {
  await withGate({ allowNoKey: true }, async ({ base, up, log }) => {
    assert.equal(up, true);
    const res = await fetch(base + '/v1/models');
    assert.equal(res.status, 200, 'an explicitly unguarded gate still forwards');
    assert.match(log(), /NO KEY/, 'running open should be loud about it');
  });
});

test('a caller without the key is turned away before anything is forwarded', async () => {
  await withGate({ key: 'right-key' }, async ({ base, hits, up }) => {
    assert.equal(up, true);
    for (const headers of [{}, { Authorization: 'Bearer wrong-key' }, { Authorization: 'Bearer ' }]) {
      const res = await fetch(base + '/v1/models', { headers });
      assert.equal(res.status, 401, 'expected 401 for ' + JSON.stringify(headers));
      assert.match((await res.json()).error, /Unauthorized/);
    }
    assert.deepEqual(hits, [], 'a refused request must never reach the shim');
  });
});

test('a caller with the key is forwarded, and our secret is not passed on', async () => {
  await withGate({ key: 'right-key' }, async ({ base, hits }) => {
    const res = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer right-key' } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, [{ id: 'claude-sonnet-4' }]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].auth, '', 'the gate key should not travel downstream');
  });
});

test('a bare key is accepted too, so a missing scheme is not a mystery 401', async () => {
  await withGate({ key: 'right-key' }, async ({ base }) => {
    const res = await fetch(base + '/v1/models', { headers: { Authorization: 'right-key' } });
    assert.equal(res.status, 200);
  });
});

test('the health probe answers without the key, and tells a stranger nothing', async () => {
  await withGate({ key: 'right-key' }, async ({ base, hits }) => {
    const res = await fetch(base + '/gate/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(hits, [], 'the probe must not wake the shim');
  });
});

test('a streamed reply arrives in pieces, not as one buffered lump', async () => {
  await withGate({ key: 'right-key' }, async ({ base }) => {
    const res = await fetch(base + '/stream', { headers: { Authorization: 'Bearer right-key' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /event-stream/);
    const reader = res.body.getReader();
    const first = await reader.read();
    // The upstream holds the second chunk back for 120ms. Receiving the first
    // before then is the proof that this is piped rather than buffered -- a
    // buffering proxy turns a streaming reply into one long pause.
    assert.ok(new TextDecoder().decode(first.value).includes('one'));
    await reader.cancel();
  });
});

test('an upstream that is not there is reported as such, not as a hang', async () => {
  const port = await freePort();
  const dead = await freePort();
  const env = { ...process.env, PORT: String(port), ROVO_SHIM_PORT: String(dead), ROVO_API_KEY: 'k' };
  const child = spawn(process.execPath, [GATE], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) {
      try { await fetch('http://127.0.0.1:' + port + '/gate/health'); break; }
      catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    const res = await fetch('http://127.0.0.1:' + port + '/v1/models', {
      headers: { Authorization: 'Bearer k' },
    });
    assert.equal(res.status, 502);
    const { error } = await res.json();
    assert.match(error, /Could not reach the Rovo shim/);
    assert.match(error, /rovodev serve/, 'the message should name the likely cause');
  } finally {
    child.kill();
  }
});
