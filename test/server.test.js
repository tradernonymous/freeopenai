const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { resolveSafePath, isAssetPath, createRequestHandler } = require('../server.js');

const root = path.join(__dirname, '..');

test('resolveSafePath maps / to index.html', () => {
  assert.equal(resolveSafePath(root, '/'), path.join(root, 'index.html'));
});

test('resolveSafePath contains a rooted "../" traversal attempt within root', () => {
  // req.url always starts with '/', so path.normalize collapses leading
  // ".." segments before the containment check ever runs.
  const result = resolveSafePath(root, '/../../../etc/passwd');
  assert.ok(result.startsWith(root));
});

test('resolveSafePath rejects a non-rooted relative traversal', () => {
  // Defense-in-depth: even if a caller ever passes a path without a
  // leading slash, the containment guard must still catch it.
  assert.equal(resolveSafePath(root, '../../../etc/passwd'), null);
});

test('resolveSafePath keeps normal asset paths inside root', () => {
  assert.equal(resolveSafePath(root, '/chatlib.js'), path.join(root, 'chatlib.js'));
});

test('isAssetPath detects file extensions', () => {
  assert.equal(isAssetPath('/app.js'), true);
  assert.equal(isAssetPath('/chatlib.js?x=1'), true);
  assert.equal(isAssetPath('/chat'), false);
  assert.equal(isAssetPath('/'), false);
});

test('server returns 405 for unsupported methods', async () => {
  const server = http.createServer(createRequestHandler(root));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const status = await new Promise((resolve) => {
    const req = http.request({ port, method: 'POST', path: '/' }, (res) => resolve(res.statusCode));
    req.end();
  });
  server.close();
  assert.equal(status, 405);
});

test('server returns real 404 for a missing asset', async () => {
  const server = http.createServer(createRequestHandler(root));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const status = await new Promise((resolve) => {
    http.get({ port, path: '/does-not-exist.js' }, (res) => resolve(res.statusCode));
  });
  server.close();
  assert.equal(status, 404);
});

test('server falls back to index.html for extensionless routes', async () => {
  const server = http.createServer(createRequestHandler(root));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const status = await new Promise((resolve) => {
    http.get({ port, path: '/settings' }, (res) => resolve(res.statusCode));
  });
  server.close();
  assert.equal(status, 200);
});

test('static responses are never cached', async () => {
  // The UI ships in index.html + chatlib.js; a cached copy would silently
  // run yesterday's code after a deploy, with yesterday's bugs.
  const server = http.createServer(createRequestHandler(root));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const headers = await new Promise((resolve) => {
    http.get({ port, path: '/' }, (res) => resolve(res.headers));
  });
  const jsHeaders = await new Promise((resolve) => {
    http.get({ port, path: '/chatlib.js' }, (res) => resolve(res.headers));
  });
  server.close();
  assert.equal(headers['cache-control'], 'no-cache');
  assert.equal(jsHeaders['cache-control'], 'no-cache');
});
