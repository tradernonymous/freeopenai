// MCP Apps (roadmap 6.9): a tool that names a `ui://` resource gets its own UI
// drawn under the call in Chat, in a sandboxed frame that talks to the host
// over postMessage JSON-RPC. The rules for finding and decoding the app are
// pure and live in tools.js; the frame and its bridge are McpAppFrame.tsx,
// asserted here as source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../desktop/src/tools.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');

test('uiResourceOf reads both _meta shapes', () => {
  assert.equal(tools.uiResourceOf({ name: 'a', _meta: { ui: { resourceUri: 'ui://weather/card' } } }), 'ui://weather/card');
  assert.equal(tools.uiResourceOf({ name: 'a', _meta: { 'ui/resourceUri': 'ui://old/draft' } }), 'ui://old/draft');
  assert.equal(tools.uiResourceOf({ name: 'a', _meta: { ui: { resourceUri: '  ui://trim/me  ' } } }), 'ui://trim/me');
});

test('uiResourceOf accepts only ui:// URIs', () => {
  assert.equal(tools.uiResourceOf({ _meta: { ui: { resourceUri: 'https://evil.example/app.html' } } }), '');
  assert.equal(tools.uiResourceOf({ _meta: { ui: { resourceUri: 'file:///C:/x.html' } } }), '');
  assert.equal(tools.uiResourceOf({ _meta: { 'ui/resourceUri': 'javascript:alert(1)' } }), '');
  assert.equal(tools.uiResourceOf({ _meta: { ui: { resourceUri: 'ui://' } } }), '');
  assert.equal(tools.uiResourceOf({ name: 'plain' }), '');
  assert.equal(tools.uiResourceOf(null), '');
  assert.equal(tools.uiResourceOf({ _meta: { ui: { resourceUri: 42 } } }), '');
});

test('isAppHtml takes text/html with or without the mcp-app profile', () => {
  assert.equal(tools.isAppHtml({ mimeType: 'text/html;profile=mcp-app', text: 'x' }), true);
  assert.equal(tools.isAppHtml({ mimeType: 'text/html; profile=mcp-app' }), true);
  assert.equal(tools.isAppHtml({ mimeType: 'text/html' }), true);
  assert.equal(tools.isAppHtml({ mimeType: 'TEXT/HTML' }), true);
  assert.equal(tools.isAppHtml({ mimeType: 'text/plain' }), false);
  assert.equal(tools.isAppHtml({ mimeType: 'text/htmlx' }), false);
  assert.equal(tools.isAppHtml(null), false);
});

test('appHtmlFrom returns text content', () => {
  const out = tools.appHtmlFrom({ contents: [{ uri: 'ui://a', mimeType: 'text/html;profile=mcp-app', text: '<p>hi</p>' }] });
  assert.deepEqual(out, { html: '<p>hi</p>', reason: '' });
});

test('appHtmlFrom decodes a base64 blob (UTF-8)', () => {
  const html = '<p>héllo ✓</p>';
  const blob = Buffer.from(html, 'utf8').toString('base64');
  assert.equal(tools.appHtmlFrom({ contents: [{ mimeType: 'text/html', blob }] }).html, html);
});

test('appHtmlFrom skips non-HTML entries and explains a miss', () => {
  const out = tools.appHtmlFrom({ contents: [{ mimeType: 'text/plain', text: 'no' }, { mimeType: 'text/html', text: '<b>yes</b>' }] });
  assert.equal(out.html, '<b>yes</b>');
  const none = tools.appHtmlFrom({ contents: [{ mimeType: 'application/json', text: '{}' }] });
  assert.equal(none.html, '');
  assert.match(none.reason, /HTML/);
  assert.equal(tools.appHtmlFrom(null).html, '');
  assert.match(tools.appHtmlFrom({ contents: [{ mimeType: 'text/html', text: '' }] }).reason, /empty/);
});

test('appHtmlFrom caps an app at 2 MB (text and blob)', () => {
  assert.equal(tools.MAX_APP_HTML_BYTES, 2 * 1024 * 1024);
  const big = 'a'.repeat(tools.MAX_APP_HTML_BYTES + 1);
  const text = tools.appHtmlFrom({ contents: [{ mimeType: 'text/html', text: big }] });
  assert.equal(text.html, '');
  assert.match(text.reason, /2 MB/);
  const blob = tools.appHtmlFrom({ contents: [{ mimeType: 'text/html', blob: Buffer.from(big).toString('base64') }] });
  assert.equal(blob.html, '');
  assert.match(blob.reason, /2 MB/);
  const exact = 'a'.repeat(tools.MAX_APP_HTML_BYTES);
  assert.equal(tools.appHtmlFrom({ contents: [{ mimeType: 'text/html', text: exact }] }).html.length, exact.length);
});

test('a cached tool keeps its _meta through setMcpTools', () => {
  const rows = new Map();
  const storage = { getItem: (k) => (rows.has(k) ? rows.get(k) : null), setItem: (k, v) => rows.set(k, String(v)) };
  assert.equal(tools.addStdioServer({ name: 'Weather', command: 'npx', args: ['weather'] }, storage).ok, true);
  tools.setMcpTools('Weather', [{ name: 'forecast', inputSchema: {}, _meta: { ui: { resourceUri: 'ui://weather/forecast' } } }], storage);
  const target = tools.mcpTarget('mcp__weather__forecast', storage);
  const tool = target.server.tools.find((t) => t.name === 'forecast');
  assert.equal(tools.uiResourceOf(tool), 'ui://weather/forecast');
});

test('tool-run keeps _meta from tools/list and reads the app with resources/read', () => {
  const src = read('desktop', 'src', 'tool-run.ts');
  assert.match(src, /row\._meta = t\._meta/);
  assert.match(src, /'resources\/read', \{ uri: app\.uri \}/);
  assert.match(src, /appHtmlFrom\(result\)/);
  // Remote servers: the engine has no resources route, so it says so.
  assert.match(src, /local \(stdio\) servers for now/);
});

test('the app frame is sandboxed to scripts only', () => {
  const src = read('desktop', 'src', 'components', 'McpAppFrame.tsx');
  const sandbox = /sandbox="([^"]*)"/.exec(src);
  assert.ok(sandbox, 'iframe has a sandbox attribute');
  assert.equal(sandbox[1], 'allow-scripts');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /allow-same-origin/);
  assert.match(src, /referrerPolicy="no-referrer"/);
  assert.match(src, /srcDoc=\{html\}/);
});

test('the bridge only listens to its own frame', () => {
  const src = read('desktop', 'src', 'components', 'McpAppFrame.tsx');
  assert.match(src, /event\.source !== own/);
  assert.match(src, /msg\.jsonrpc !== '2\.0'/);
  for (const method of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-input', 'ui/notifications/tool-result', 'ui/notifications/size-changed', 'ui/message', 'ui/open-link', 'tools/call']) {
    assert.ok(src.includes(`'${method}'`), `handles ${method}`);
  }
});

test('tools/call from an app goes through the approval rule and executeTool, same server only', () => {
  const src = read('desktop', 'src', 'components', 'McpAppFrame.tsx');
  const body = src.slice(src.indexOf('const callTool'), src.indexOf('const openLink'));
  assert.match(body, /tools\.needsApproval\(full\)/);
  assert.match(body, /askPerson\(/);
  assert.match(body, /executeTool\(/);
  assert.match(body, /tools\.slug\(target\.server\.name\) !== tools\.slug\(app\.server\.name\)/);
  assert.ok(body.indexOf('needsApproval') < body.indexOf('executeTool('), 'asks before it runs');
});

test('open-link is http(s) only, confirmed, and opened by the shell', () => {
  const src = read('desktop', 'src', 'components', 'McpAppFrame.tsx');
  assert.match(src, /parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:'/);
  const body = src.slice(src.indexOf('const openLink'), src.indexOf('const insertMessage'));
  assert.match(body, /isWebLink\(url\)/);
  assert.ok(body.indexOf('askPerson(') < body.indexOf('openUrl(url)'), 'asks before opening');
});

test('ui/message fills the draft via an event and never sends; height is clamped', () => {
  const src = read('desktop', 'src', 'components', 'McpAppFrame.tsx');
  assert.match(src, /COMPOSER_INSERT_EVENT = 'freeai4u:composer-insert'/);
  assert.match(src, /const MIN_HEIGHT = 80;/);
  assert.match(src, /const MAX_HEIGHT = 900;/);
});

test('ToolCards draws the app under a finished call with a show/hide toggle', () => {
  const src = read('desktop', 'src', 'components', 'ToolCards.tsx');
  assert.match(src, /import McpAppFrame from '\.\/McpAppFrame'/);
  assert.match(src, /mcpAppFor\(event\.name\)/);
  assert.match(src, /event\.status === 'done'/);
  assert.match(src, /mcp-app-toggle/);
});
