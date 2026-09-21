// MCP (Model Context Protocol) client: the server-side JSON-RPC relay
// (server.js) and the client-side tool specs (chatlib.js). The relay is
// SSRF-guarded exactly like /api/llm/fetch (see test/web.test.js) since it
// also reads a user-supplied URL and reaches out on the server's behalf --
// these tests pin that guard without ever reaching a real MCP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler } = require('../server.js');
const { mcpTool, MCP_LIST_TOOLS, isMcpTool, TOOL_GROUPS } = require('../chatlib.js');

async function startApp() {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  return app;
}

async function postJson(app, path, body) {
  return fetch(`http://127.0.0.1:${app.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('isMcpTool recognises exactly the two MCP tool names', () => {
  assert.ok(isMcpTool('mcp_call'));
  assert.ok(isMcpTool('mcp_list_tools'));
  assert.ok(!isMcpTool('web_fetch'));
  assert.ok(!isMcpTool(''));
});

test('mcp_call and mcp_list_tools are in the research group, offered in every mode', () => {
  assert.ok(TOOL_GROUPS.research.includes('mcp_call'));
  assert.ok(TOOL_GROUPS.research.includes('mcp_list_tools'));
});

test('mcpTool names no servers when none are registered, and lists them when they are', () => {
  const empty = mcpTool([]);
  assert.equal(empty.type, 'function');
  assert.equal(empty.function.name, 'mcp_call');
  assert.match(empty.function.description, /No MCP servers are registered/);

  const withServers = mcpTool([
    { name: 'github', tools: [{ name: 'search_issues' }, { name: 'create_issue' }] },
    { name: 'docs', tools: [] },
  ]);
  assert.match(withServers.function.description, /github: search_issues, create_issue/);
  assert.match(withServers.function.description, /docs \(tools not loaded yet\)/);
});

test('MCP_LIST_TOOLS is a well-formed tool spec requiring a server name', () => {
  assert.equal(MCP_LIST_TOOLS.function.name, 'mcp_list_tools');
  assert.deepEqual(MCP_LIST_TOOLS.function.parameters.required, ['server']);
});

test('mcp/tools without a url is a 400', async () => {
  const app = await startApp();
  try {
    const res = await postJson(app, '/api/mcp/tools', {});
    assert.equal(res.status, 400);
  } finally {
    app.close();
  }
});

test('mcp/tools rejects non-http schemes without touching the network', async () => {
  const app = await startApp();
  try {
    const res = await postJson(app, '/api/mcp/tools', { url: 'file:///etc/passwd' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /http\(s\)/);
  } finally {
    app.close();
  }
});

test('mcp/tools refuses loopback and private hosts', async () => {
  const app = await startApp();
  try {
    for (const url of ['http://127.0.0.1:9/', 'http://10.0.0.1/', 'http://localhost:3000/']) {
      const res = await postJson(app, '/api/mcp/tools', { url });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /not reachable from here/);
    }
  } finally {
    app.close();
  }
});

test('mcp/call without a url is a 400', async () => {
  const app = await startApp();
  try {
    const res = await postJson(app, '/api/mcp/call', { tool: 'search' });
    assert.equal(res.status, 400);
  } finally {
    app.close();
  }
});

test('mcp/call without a tool name is a 400 before any network reach', async () => {
  const app = await startApp();
  try {
    // A real, resolvable-looking host: proves the tool-name check runs
    // before the SSRF check even gets a chance to reject it for another
    // reason, so the error names the actual missing field.
    const res = await postJson(app, '/api/mcp/call', { url: 'https://example.com/mcp' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /tool is required/);
  } finally {
    app.close();
  }
});

test('mcp/call refuses loopback and private hosts', async () => {
  const app = await startApp();
  try {
    const res = await postJson(app, '/api/mcp/call', { url: 'http://169.254.169.254/', tool: 'x' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not reachable from here/);
  } finally {
    app.close();
  }
});
