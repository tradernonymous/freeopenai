// Local MCP servers over stdio (docs/adr/0001: the MCP host lives in the shell).
//
// A server on this PC is a program -- `npx -y @scope/server`, `uvx thing`, an
// .exe -- that the shell spawns directly (no shell in between), shakes hands
// with, and keeps until Stop or Quit. The rules for the rows the person saves,
// the argument line they type and the config they paste are pure and live in
// tools.js; the process side is mcp.rs, asserted here as source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../desktop/src/tools.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');

function memoryStorage() {
  const rows = new Map();
  return {
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    setItem: (k, v) => rows.set(k, String(v)),
    removeItem: (k) => rows.delete(k),
  };
}

// ---- rows ----------------------------------------------------------------------

test('a local server needs a name and a command, and no address', () => {
  assert.equal(tools.validateStdioServer({ name: '', command: 'npx' }).ok, false);
  assert.equal(tools.validateStdioServer({ name: 'files', command: '  ' }).ok, false);
  assert.match(tools.validateStdioServer({ name: 'files' }).reason, /command/);
  assert.equal(tools.validateStdioServer({ name: 'files', command: 'npx\nrm -rf /' }).ok, false, 'a command is one line');
  const ok = tools.validateStdioServer({ name: ' Files ', command: ' npx ', args: ['-y', 3, null, { x: 1 }], env: { TOKEN: 'abc', 'bad key': 'x', N: 5, O: {} }, cwd: ' C:\\work ' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.server, {
    name: 'Files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '3'],
    env: { TOKEN: 'abc', N: '5' },
    tools: [],
    cwd: 'C:\\work',
  });
});

test('local and remote servers share one list, and remote is still https only', () => {
  const store = memoryStorage();
  assert.equal(tools.addMcpServer('docs', 'http://x.example/mcp', [], store).ok, false, 'remote still needs https');
  assert.equal(tools.addMcpServer('docs', 'https://x.example/mcp', [{ name: 'search' }], store).ok, true);
  assert.equal(tools.addStdioServer({ name: 'files', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }, store).ok, true);
  assert.equal(tools.addStdioServer({ name: 'nothing' }, store).ok, false);

  const rows = tools.mcpServers(store);
  assert.deepEqual(rows.map((s) => s.name), ['docs', 'files']);
  assert.equal(tools.isStdio(rows[0]), false);
  assert.equal(tools.isStdio(rows[1]), true);
  assert.equal(rows[1].url, undefined, 'a local server has no address');

  // Its tools are cached on the row, like a remote server's, and routed by name.
  assert.equal(tools.setMcpTools('files', [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: {} } }], store), true);
  assert.equal(tools.setMcpTools('nope', [], store), false);
  assert.ok(tools.mcpDefs(store).some((d) => d.function.name === 'mcp__files__read_file'));
  const target = tools.mcpTarget('mcp__files__read_file', store);
  assert.equal(target.tool, 'read_file');
  assert.equal(tools.isStdio(target.server), true);
  assert.equal(target.server.command, 'npx');
  assert.ok(tools.needsApproval('mcp__files__read_file', store), 'a local MCP tool asks like any other');

  // Same name replaces; remove works across transports.
  assert.equal(tools.addStdioServer({ name: 'FILES', command: 'uvx', args: ['mcp-files'] }, store).ok, true);
  assert.deepEqual(tools.mcpServers(store).filter(tools.isStdio).map((s) => s.command), ['uvx']);
  assert.equal(tools.removeMcpServer('FILES', store), true);
  assert.deepEqual(tools.mcpServers(store).map((s) => s.name), ['docs']);

  // A hand-edited store cannot smuggle in a stdio row without a command.
  store.setItem(tools.MCP_KEY, '[{"name":"x","transport":"stdio"},{"name":"y","transport":"stdio","command":"node","args":"notalist"}]');
  assert.deepEqual(tools.mcpServers(store).map((s) => [s.name, s.args]), [['y', []]]);
});

// ---- the argument line -------------------------------------------------------------

test('an argument line splits on spaces and respects quotes', () => {
  assert.deepEqual(tools.splitArgs(''), []);
  assert.deepEqual(tools.splitArgs('   '), []);
  assert.deepEqual(tools.splitArgs('-y @modelcontextprotocol/server-filesystem .'), ['-y', '@modelcontextprotocol/server-filesystem', '.']);
  assert.deepEqual(tools.splitArgs('  a   b  '), ['a', 'b']);
  assert.deepEqual(tools.splitArgs('"C:\\My Folder" \'single quoted\''), ['C:\\My Folder', 'single quoted']);
  assert.deepEqual(tools.splitArgs('--name="two words" x'), ['--name=two words', 'x']);
  assert.deepEqual(tools.splitArgs('"say \\"hi\\"" ""'), ['say "hi"', ''], 'an escaped quote, and an empty argument');
  assert.deepEqual(tools.splitArgs('C:\\tools\\bin'), ['C:\\tools\\bin'], 'Windows backslashes survive');
  assert.deepEqual(tools.splitArgs('"unterminated arg'), ['unterminated arg']);
  const back = ['-y', 'C:\\My Folder', 'say "hi"', ''];
  assert.deepEqual(tools.splitArgs(tools.joinArgs(back)), back, 'join and split round-trip');
});

test('environment lines are KEY=VALUE, and anything else is reported', () => {
  const parsed = tools.parseEnvLines('GITHUB_TOKEN=abc=def\n\n# a comment\n  API_URL = https://x \nnot a pair\n1BAD=x');
  assert.deepEqual(parsed.env, { GITHUB_TOKEN: 'abc=def', API_URL: ' https://x' });
  assert.deepEqual(parsed.bad, ['not a pair', '1BAD=x']);
  assert.deepEqual(tools.parseEnvLines('').env, {});
});

// ---- a pasted config ------------------------------------------------------------------

test('a Claude-Desktop-style config becomes rows, and nothing is saved by parsing', () => {
  const config = JSON.stringify({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\work'] },
      github: { command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'x' } },
      remote: { url: 'https://mcp.example.com/mcp' },
      plain: { url: 'http://insecure.example/mcp' },
      broken: { args: ['no command'] },
      odd: 'not an object',
    },
  });
  const out = tools.parseMcpConfig(config);
  assert.deepEqual(out.servers.map((s) => s.name), ['filesystem', 'github', 'remote']);
  assert.equal(out.servers[0].transport, 'stdio');
  assert.deepEqual(out.servers[0].args, ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\work']);
  assert.deepEqual(out.servers[1].env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'x' });
  assert.equal(out.servers[2].url, 'https://mcp.example.com/mcp');
  assert.equal(tools.isStdio(out.servers[2]), false);
  assert.equal(out.errors.length, 3);
  assert.ok(out.errors.some((e) => /^plain: .*https:\/\//.test(e)));
  assert.ok(out.errors.some((e) => /^broken: .*command/.test(e)));
  assert.ok(out.errors.some((e) => /^odd: /.test(e)));

  // The inner map by itself is accepted too.
  assert.deepEqual(tools.parseMcpConfig('{"x":{"command":"uvx","args":["mcp-x"]}}').servers.map((s) => s.command), ['uvx']);
  assert.match(tools.parseMcpConfig('not json').errors[0], /not valid JSON/);
  assert.equal(tools.parseMcpConfig('[1,2]').servers.length, 0);
  assert.match(tools.parseMcpConfig('{"mcpServers":{}}').errors[0], /No servers/);
});

// ---- results and errors -----------------------------------------------------------------

test('a tools/call result is its text parts, and a shell error carries the stderr tail', () => {
  assert.equal(tools.mcpResultText({ content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'x' }, { type: 'text', text: 'two' }] }), 'one\ntwo');
  assert.equal(tools.mcpResultText({ content: [], structuredContent: { a: 1 } }), '{"a":1}');
  assert.equal(tools.mcpResultText(null), '{}');
  assert.deepEqual(tools.splitStderr('initialize failed'), { message: 'initialize failed', stderr: '' });
  assert.deepEqual(
    tools.splitStderr("The MCP server 'files' exited before answering initialize.\n\nstderr:\nnpm ERR! 404\nnot found"),
    { message: "The MCP server 'files' exited before answering initialize.", stderr: 'npm ERR! 404\nnot found' },
  );
});

// ---- the shell --------------------------------------------------------------------------

test('the shell registers the four commands, and reaps servers on Quit', () => {
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /^mod mcp;$/m);
  for (const name of ['mcp_stdio_start', 'mcp_stdio_request', 'mcp_stdio_stop', 'mcp_stdio_list']) {
    assert.ok(main.includes(`mcp::${name},`) || main.includes(`mcp::${name}\n`), `main.rs registers ${name}`);
  }
  const quit = main.slice(main.indexOf('"quit" => {'));
  assert.ok(quit.indexOf('mcp::shutdown();') > 0 && quit.indexOf('mcp::shutdown();') < quit.indexOf('app.exit(0)'), 'Quit stops every local server before exiting');
});

test('mcp.rs spawns the program directly and does the MCP handshake', () => {
  const rs = read('desktop', 'src-tauri', 'src', 'mcp.rs');
  assert.match(rs, /pub const PROTOCOL_VERSION: &str = "2025-06-18";/);
  assert.match(rs, /"initialize",\n\s+serde_json::json!\(\{\n\s+"protocolVersion": PROTOCOL_VERSION,/);
  assert.match(rs, /"clientInfo": \{ "name": "NeuraOS"/);
  assert.match(rs, /"method": "notifications\/initialized"/);
  assert.ok(rs.indexOf('"initialize",') < rs.indexOf('"method": "notifications/initialized"'), 'initialized comes after initialize');
  // No shell in between: the program itself, with its arguments as arguments.
  assert.match(rs, /Command::new\(resolve_program\(program, &env\)\)/);
  assert.match(rs, /\.args\(&args\)/);
  assert.ok(!/Command::new\("cmd"\)|Command::new\("sh"\)/.test(rs), 'never through cmd or sh');
  assert.match(rs, /CREATE_NO_WINDOW/);
  // Responses are matched by id; notifications and non-JSON lines are skipped.
  assert.match(rs, /recv_timeout\(timeout\)/);
  assert.match(rs, /Err\(_\) => continue,/);
  // stderr is a ring buffer, and it rides the error.
  assert.match(rs, /const STDERR_LINES: usize = \d+;/);
  assert.match(rs, /const STDERR_MARK: &str = "\\n\\nstderr:\\n";/);
  assert.match(rs, /pub fn shutdown\(\)/);
  // Env values never reach a log.
  assert.ok(!/crash::log/.test(rs), 'mcp.rs logs nothing');
  // Only crates the manifest already has.
  const cargo = read('desktop', 'src-tauri', 'Cargo.toml');
  assert.ok(!/tokio/.test(rs) || /tokio/.test(cargo));
});

test('the bridge, the runner and the Connectors card use the local path', () => {
  const bridge = read('desktop', 'src', 'bridge.ts');
  for (const name of ['mcp_stdio_start', 'mcp_stdio_request', 'mcp_stdio_stop', 'mcp_stdio_list']) {
    assert.ok(bridge.includes(`'${name}'`), `bridge.ts invokes ${name}`);
  }
  assert.match(bridge, /export async function mcpStdioList\(\): Promise<string\[\]> \{\n\s+if \(!hasShell\(\)\) return \[\];/, 'no shell: nothing is running');
  const runner = read('desktop', 'src', 'tool-run.ts');
  assert.match(runner, /if \(tools\.isStdio\(target\.server\)\) return mcpStdio\(/);
  assert.match(runner, /mcpStdioRequest\(id, 'tools\/call', \{ name: tool, arguments: a \}/);
  assert.match(runner, /mcpStdioRequest\(id, 'tools\/list'/);
  assert.match(runner, /tools\.mcpResultText\(result\)/);
  assert.match(runner, /tools\.setMcpTools\(server\.name, list\)/);
  const card = read('desktop', 'src', 'components', 'ConnectorsCard.tsx');
  assert.match(card, /Paste config JSON/);
  assert.match(card, /tools\.parseMcpConfig\(pasteText\)/);
  assert.match(card, /tools\.splitArgs\(argsLine\)/);
  assert.match(card, /tools\.parseEnvLines\(envText\)/);
  assert.match(card, /tools\.splitStderr\(/);
  assert.match(card, /className="mcp-stderr"/);
  assert.match(card, />Stop</);
});
