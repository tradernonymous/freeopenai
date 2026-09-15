#!/usr/bin/env node
'use strict';
// The thing standing between the open internet and an Atlassian allowance.
//
// The shim behind this strips Authorization on purpose: Rovo is authenticated by
// the container's own `acli` session, not by a bearer token. That is fine while
// nothing but localhost can reach it, and dangerous the moment it is tunnelled,
// because then a URL is the only secret and tunnel URLs end up in logs, shell
// history and screenshots. Anyone who finds one spends 5 million tokens a day
// that belong to somebody else.
//
// So: one required bearer token, checked before anything is forwarded, and a
// refusal to start at all without one. Failing closed is the whole point -- a
// gate that quietly lets everything through when misconfigured is worse than no
// gate, because it looks like protection.
//
// Node's http only, no dependencies, matching the rest of this repo.
const http = require('http');

const PORT = Number(process.env.PORT || 4000);
const UPSTREAM_HOST = process.env.ROVO_SHIM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.ROVO_SHIM_PORT || 4100);
const KEY = String(process.env.ROVO_API_KEY || '');
const ALLOW_NO_KEY = process.env.ROVO_ALLOW_NO_KEY === '1';

if (!KEY && !ALLOW_NO_KEY) {
  console.error(
    'ROVO_API_KEY is not set. Refusing to start: without it this port is an ' +
      'unauthenticated door to your Atlassian allowance.\n' +
      'Set ROVO_API_KEY to a long random string, or set ROVO_ALLOW_NO_KEY=1 if ' +
      'you are certain nothing outside this machine can reach the port.',
  );
  process.exit(1);
}

// Timing-safe where it matters. A plain === leaks the length of the shared
// secret through response timing; it is a small leak and a smaller fix.
const crypto = require('crypto');
function keyMatches(presented) {
  const a = Buffer.from(presented);
  const b = Buffer.from(KEY);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authorised(req) {
  if (!KEY) return true;
  const header = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  // The key is accepted bare as well: some clients send the token with no
  // scheme, and rejecting those produces a 401 that looks like a wrong key.
  const presented = bearer ? bearer[1].trim() : header.trim();
  return !!presented && keyMatches(presented);
}

const server = http.createServer((req, res) => {
  // Unauthenticated, and deliberately uninformative: a health check that
  // answered with the upstream's state would tell a stranger whether they had
  // found something worth attacking.
  if (req.url === '/gate/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (!authorised(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: send Authorization: Bearer <ROVO_API_KEY>' }));
    // Drain, so a large body on a refused request does not sit in the socket.
    req.resume();
    return;
  }

  const headers = { ...req.headers, host: UPSTREAM_HOST + ':' + UPSTREAM_PORT };
  // The shim ignores it, but forwarding our own shared secret to anything
  // downstream is a habit worth not having.
  delete headers.authorization;

  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
    (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      // Piped rather than buffered: this carries server-sent events, and a
      // buffered proxy turns a streaming reply into one long pause.
      answer.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Could not reach the Rovo shim on ' + UPSTREAM_HOST + ':' + UPSTREAM_PORT +
        ' (' + error.message + '). It starts after `acli rovodev serve`, so this ' +
        'usually means the Rovo session is not up yet.',
    }));
  });

  req.pipe(upstream);
});

// A generation is slow and the shim answers one request at a time, so a queued
// request can legitimately sit here for minutes. Node's 2-minute default would
// cut it off and report it as the provider failing.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.setTimeout(0);

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    'rovo gate listening on 0.0.0.0:' + PORT +
      ' -> ' + UPSTREAM_HOST + ':' + UPSTREAM_PORT +
      (KEY ? ' (key required)' : ' (NO KEY -- local use only)'),
  );
});
