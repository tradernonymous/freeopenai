// Phase 1: Chat is an agent.
//
// A model can now ask for things -- search the web, read a repository, edit a
// file in the folder that is open -- and the app does them and hands back the
// result. The rule the whole feature stands on: reading is free, and anything
// that CHANGES something (a file, a command, a commit, somebody's MCP server)
// waits for an Allow on a card in the conversation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../desktop/src/tools.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function memoryStorage() {
  const rows = new Map();
  return {
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    setItem: (k, v) => rows.set(k, String(v)),
    removeItem: (k) => rows.delete(k),
  };
}

const names = (defs) => defs.map((d) => d.function.name);

// ---- what is offered ---------------------------------------------------------

test('every tool is a well-formed function definition with a unique name', () => {
  const all = [...tools.WEB, ...tools.GITHUB, ...tools.LOCAL];
  assert.equal(new Set(names(all)).size, all.length);
  for (const def of all) {
    assert.equal(def.type, 'function');
    assert.match(def.function.name, /^[a-z_]+$/);
    assert.ok(def.function.description.length > 10, `${def.function.name} says what it does`);
    assert.equal(def.function.parameters.type, 'object');
    for (const key of def.function.parameters.required) {
      assert.ok(key in def.function.parameters.properties, `${def.function.name} requires a property it declares (${key})`);
    }
  }
});

test('tools are offered for what is actually connected, and nothing else', () => {
  const store = memoryStorage();
  assert.deepEqual(names(tools.catalogue({}, store)), ['web_search', 'web_fetch'], 'the web, always');
  assert.ok(names(tools.catalogue({ github: true }, store)).includes('github_commit_file'));
  assert.ok(!names(tools.catalogue({ github: false }, store)).some((n) => n.startsWith('github_')));
  // A folder with no shell to reach it is not a folder the model can use.
  assert.ok(!names(tools.catalogue({ localRoot: 'C:\\p', shell: false }, store)).includes('read_file'));
  assert.ok(names(tools.catalogue({ localRoot: 'C:\\p', shell: true }, store)).includes('run_command'));
  assert.ok(!names(tools.catalogue({ localRoot: '', shell: true }, store)).includes('read_file'));
});

test('the same GitHub tools as the web app, so a connection means the same thing in both', () => {
  const web = read('chatlib.js');
  for (const name of names(tools.GITHUB)) {
    assert.ok(web.includes(`name: '${name}'`), `${name} exists in the web app too`);
  }
});

// ---- asking first --------------------------------------------------------------

test('every write, command and commit asks; every read does not', () => {
  for (const name of ['write_file', 'edit_file', 'run_command', 'github_commit_file', 'github_delete_file', 'github_create_branch']) {
    assert.ok(tools.needsApproval(name), `${name} must ask`);
  }
  for (const name of ['web_search', 'web_fetch', 'list_files', 'read_file', 'github_list_repos', 'github_read_file', 'github_search_code', 'github_list_commits', 'github_list_branches', 'github_list_files']) {
    assert.equal(tools.needsApproval(name), '', `${name} is a read`);
  }
  // The rule is a rule: a write can never be "always allowed".
  assert.equal(tools.alwaysKey('write_file'), '');
  assert.equal(tools.alwaysKey('run_command'), '');
  assert.equal(tools.setAlways('github_commit_file', memoryStorage()), false);
});

test('an MCP tool asks until its server is trusted, and trust is per server', () => {
  const store = memoryStorage();
  assert.ok(tools.needsApproval('mcp__docs__search', store));
  assert.equal(tools.setAlways('mcp__docs__search', store), true);
  assert.equal(tools.needsApproval('mcp__docs__search', store), '');
  assert.equal(tools.needsApproval('mcp__docs__other_tool', store), '', 'the same server');
  assert.ok(tools.needsApproval('mcp__billing__charge', store), 'another server still asks');
});

// ---- MCP servers -----------------------------------------------------------------

test('an MCP server is https, named, replaceable and removable', () => {
  const store = memoryStorage();
  assert.equal(tools.addMcpServer('', 'https://x.example/mcp', [], store).ok, false);
  assert.equal(tools.addMcpServer('docs', 'http://x.example/mcp', [], store).ok, false, 'the engine refuses anything but https');
  assert.equal(tools.addMcpServer('Docs Server', 'https://x.example/mcp', [{ name: 'search', description: 'Search docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }], store).ok, true);
  assert.equal(tools.addMcpServer('docs server', 'https://y.example/mcp', [{ name: 'search' }], store).ok, true, 'same name replaces');
  assert.deepEqual(tools.mcpServers(store).map((s) => s.url), ['https://y.example/mcp']);

  const defs = tools.mcpDefs(store);
  assert.deepEqual(names(defs), ['mcp__docs_server__search']);
  assert.match(defs[0].function.description, /^\[docs server\]/);
  const target = tools.mcpTarget('mcp__docs_server__search', store);
  assert.equal(target.tool, 'search');
  assert.equal(target.server.url, 'https://y.example/mcp');
  assert.equal(tools.mcpTarget('mcp__docs_server__nope', store), null);
  assert.equal(tools.mcpTarget('web_search', store), null);
  assert.ok(names(tools.catalogue({}, store)).includes('mcp__docs_server__search'));

  assert.equal(tools.removeMcpServer('docs server', store), true);
  assert.deepEqual(tools.mcpServers(store), []);
  store.setItem(tools.MCP_KEY, '[{"name":"x","url":"ftp://bad"}, 7, null]');
  assert.deepEqual(tools.mcpServers(store), [], 'a hand-edited store cannot add a bad server');
});

test('tools can be switched off, and are on by default', () => {
  const store = memoryStorage();
  assert.equal(tools.enabled(store), true);
  tools.setEnabled(false, store);
  assert.equal(tools.enabled(store), false);
  tools.setEnabled(true, store);
  assert.equal(tools.enabled(store), true);
});

// ---- reading calls out of a stream ---------------------------------------------------

test('an OpenAI stream sends a call in pieces; they become one call', () => {
  let state = [];
  state = tools.collect(state, [{ index: 0, id: 'call_a', type: 'function', function: { name: 'web_search', arguments: '' } }]);
  state = tools.collect(state, [{ index: 0, function: { arguments: '{"que' } }]);
  state = tools.collect(state, [{ index: 0, function: { arguments: 'ry":"tauri"}' } }]);
  state = tools.collect(state, [{ index: 1, id: 'call_b', function: { name: 'web_fetch', arguments: '{"url":"https://x"}' } }]);
  const calls = tools.finish(state);
  assert.deepEqual(calls, [
    { id: 'call_a', name: 'web_search', arguments: '{"query":"tauri"}' },
    { id: 'call_b', name: 'web_fetch', arguments: '{"url":"https://x"}' },
  ]);
  assert.deepEqual(tools.parseArgs(calls[0].arguments), { query: 'tauri' });
});

test('Ollama sends a call whole, with an object and no id; it becomes the same thing', () => {
  const calls = tools.finish(tools.collect([], [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.ok(calls[0].id, 'an id is made up so the result can be matched to it');
  assert.deepEqual(tools.parseArgs(calls[0].arguments), { path: 'a.txt' });
});

test('broken arguments are an empty object, never a throw; a nameless call is dropped', () => {
  assert.deepEqual(tools.parseArgs('{not json'), {});
  assert.deepEqual(tools.parseArgs('[1,2]'), {});
  assert.deepEqual(tools.parseArgs(''), {});
  assert.deepEqual(tools.finish([{ id: 'x', name: '', arguments: '{}' }, null]), []);
});

test('the conversation goes back in the shape the next request needs, results clipped', () => {
  const call = { id: 'call_a', name: 'web_fetch', arguments: '{"url":"https://x"}' };
  assert.deepEqual(tools.assistantMessage('Let me look.', [call]), {
    role: 'assistant',
    content: 'Let me look.',
    tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://x"}' } }],
  });
  const long = 'x'.repeat(tools.MAX_RESULT_CHARS + 500);
  const message = tools.toolMessage(call, long);
  assert.equal(message.role, 'tool');
  assert.equal(message.tool_call_id, 'call_a');
  assert.ok(message.content.length < long.length);
  assert.match(message.content, /500 more characters not shown/);
});

test('a card says in words what is being asked', () => {
  assert.match(tools.summarise('run_command', { command: 'npm test' }), /^Run: npm test$/);
  assert.match(tools.summarise('write_file', { path: 'a.txt', content: 'hello' }), /Write a\.txt \(5 characters\)/);
  assert.match(tools.summarise('github_commit_file', { repo: 'me/app', path: 'README.md', branch: 'dev' }), /Commit README\.md to me\/app \(dev\)/);
  assert.match(tools.summarise('web_search', { query: 'tauri deep link' }), /tauri deep link/);
  assert.equal(tools.summarise('mcp__docs__search', {}), 'docs: search');
});

test('a refusal that is about tools is recognised, and an ordinary failure is not', () => {
  assert.equal(tools.isToolsRefusal('400: this model does not support tools'), true);
  assert.equal(tools.isToolsRefusal('Invalid request: unknown field "tools"'), true);
  assert.equal(tools.isToolsRefusal('function calling is not enabled'), true);
  assert.equal(tools.isToolsRefusal('429 rate limit exceeded'), false);
  assert.equal(tools.isToolsRefusal('Could not reach the engine'), false);
});

// ---- the wiring ----------------------------------------------------------------------

test('the turn loops: stream, ask, run, hand back -- and a Deny is an answer, not an error', () => {
  const turn = read('desktop', 'src', 'agent-turn.ts');
  assert.match(turn, /for \(let round = 0; round < tools\.MAX_ROUNDS; round \+= 1\)/);
  assert.match(turn, /tools\.needsApproval\(call\.name\)/);
  assert.match(turn, /await options\.approve\(/);
  assert.match(turn, /The user declined this action\./);
  assert.match(turn, /tools\.isToolsRefusal\(message\)/, 'a model that cannot take tools still answers');
  assert.match(turn, /tools\.toolMessage\(call, result\)/);
});

test('every tool goes where it lives, and only an allowed call reaches the shell', () => {
  const runner = read('desktop', 'src', 'tool-run.ts');
  for (const route of ['/api/llm/websearch', '/api/llm/fetch', '/api/github/repos', '/api/github/tree', '/api/github/file', '/api/github/search', '/api/github/commits', '/api/github/branches', '/api/github/branch', '/api/mcp/call']) {
    assert.ok(runner.includes(route), `${route} is used`);
  }
  for (const call of ['listLocalDir(', 'readLocalFile(', 'writeLocalFile(', 'editLocalFile(', 'runLocal(']) {
    assert.ok(runner.includes(call), `${call} is used`);
  }
  // Every engine route it calls exists on the server.
  const server = read('server.js');
  for (const route of ['/api/github/status', '/api/github/disconnect', '/api/github/authorize', '/api/mcp/tools', '/api/mcp/call']) {
    assert.ok(server.includes(`'${route}'`), `the engine serves ${route}`);
  }
});

test('Chat offers tools on every provider, draws the cards, and Allow / Deny is in the conversation', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /await runTurn\(\{/);
  assert.match(chat, /toolsLib\.catalogue\(\{ github: githubConnected, localRoot: root, shell: hasShell\(\) \}\)/);
  assert.match(chat, /hfInference\.streamChat\(model, messages, onFrame, signal, hfToken \|\| undefined, offered\)/);
  assert.match(chat, /streamSaved\(provider, model, messages, onFrame, signal, .*, offered, active\.reasoning\);/);
  assert.match(chat, /\.\.\.\(offered \? \{ tools: offered \} : \{\}\)/, 'the engine route is handed the tools');
  assert.match(chat, /<ToolCards events=\{msg\.tools\}/);
  const cards = read('desktop', 'src', 'components', 'ToolCards.tsx');
  assert.match(cards, />Allow</);
  assert.match(cards, />Deny</);
  assert.match(cards, /Always for this server/);
  const api = read('desktop', 'src', 'api.ts');
  assert.match(api, /delta\.tool_calls/);
  assert.match(api, /toolCalls\?: any\[\]/);
});

test('Ollama gets a replayed call as an object, and the tool named on its result', () => {
  const runner = read('desktop', 'src', 'run-model.ts');
  assert.match(runner, /export function forOllama\(message: any\)/);
  assert.match(runner, /\.map\(forOllama\)/);
  assert.match(runner, /tool_name: message\.name/);
  assert.match(runner, /row\.message\.tool_calls/);
});

test('GitHub connects in a window of this app, and only the engine\'s sign-in opens one', () => {
  const card = read('desktop', 'src', 'components', 'ConnectorsCard.tsx');
  assert.match(card, /\/api\/github\/authorize/);
  assert.match(card, /authWindowOpen\(page\)/);
  assert.match(card, /\/api\/github\/disconnect\?account=/);
  assert.match(card, /\/api\/mcp\/tools/);
  assert.match(read('desktop', 'src', 'screens', 'SettingsScreen.tsx'), /<ConnectorsCard \/>/);
  const shell = read('desktop', 'src-tauri', 'src', 'net.rs');
  assert.match(shell, /pub fn is_connect_url\(url: &str\)/);
  assert.match(shell, /path == "api\/github\/authorize"/);
  assert.match(shell, /WebviewWindowBuilder::new\(&app, "connect"/);
  assert.match(shell, /"connect-finished"/);
  const main = read('desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /net::auth_window_open/);
  assert.match(main, /window\.label\(\) != "main"/, 'only the main window hides to the tray');
});
