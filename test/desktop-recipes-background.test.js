// Phase 12a: scheduled / "Run now" recipes run with tools that never ask.
// Which calls a background run may make is pure and lives in recipes.js
// (backgroundServers, backgroundRefusal, backgroundOffer); RecipesScreen wires
// it into Chat's tool loop, asserted here as source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const recipes = require('../desktop/src/recipes.js');
const tools = require('../desktop/src/tools.js');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');

function memoryStorage() {
  const rows = new Map();
  return { getItem: (k) => (rows.has(k) ? rows.get(k) : null), setItem: (k, v) => rows.set(k, String(v)) };
}

const recipe = {
  id: 'brief', name: 'Brief', systemPrompt: '', prompt: 'x', params: [], extensions: ['Weather', 'browser', 'Remote Docs', 'gone'],
};

test('backgroundServers starts only local servers this recipe has consent for', () => {
  const storage = memoryStorage();
  recipes.grantConsent('brief', ['weather'], storage);
  const plan = recipes.backgroundServers(recipe, [
    { name: 'Weather', stdio: true, running: false },
    { name: 'browser', stdio: true, running: false },
    { name: 'Remote Docs', stdio: false, running: false },
    { name: 'other', stdio: true, running: true },
  ], storage);
  assert.deepEqual(plan, { start: ['Weather'], ready: ['Remote Docs'], skipped: ['browser'], missing: ['gone'] });
  // Already running needs no consent to be used (it is not started by the run).
  const running = recipes.backgroundServers(recipe, [{ name: 'browser', stdio: true, running: true }], storage);
  assert.deepEqual(running.ready, ['browser']);
});

test('backgroundRefusal lets read-only built-ins through and refuses anything that asks', () => {
  assert.equal(recipes.backgroundRefusal(recipe, { name: 'web_search', asks: '' }), '');
  assert.equal(recipes.backgroundRefusal(recipe, { name: 'github_read_file', asks: '' }), '');
  for (const name of ['write_file', 'edit_file', 'run_command', 'github_commit_file', 'github_delete_file', 'github_create_branch']) {
    const out = recipes.backgroundRefusal(recipe, { name, asks: tools.needsApproval(name, memoryStorage()) });
    assert.match(out, /^Error: /, name);
    assert.match(out, /needs your approval; run this recipe from chat \(\/recipe brief\)/, name);
  }
  assert.match(recipes.backgroundRefusal(recipe, { name: 'spawn_agent', asks: '' }), /sub-agents do not run in a background/);
});

test('backgroundRefusal: MCP tools only when always-allowed, from the recipe\'s own ready servers', () => {
  const storage = memoryStorage();
  const name = 'mcp__weather__forecast';
  // Not always-allowed: asks, so refused.
  assert.match(recipes.backgroundRefusal(recipe, { name, asks: tools.needsApproval(name, storage), usable: true }), /needs your approval/);
  tools.setAlways(name, storage);
  assert.equal(tools.needsApproval(name, storage), '');
  assert.equal(recipes.backgroundRefusal(recipe, { name, asks: '', usable: true }), '');
  // Always-allowed but the server could not be started (no consent).
  assert.match(recipes.backgroundRefusal(recipe, { name, asks: '', usable: false }), /no consent to start it/);
  // A server the recipe does not list.
  assert.match(recipes.backgroundRefusal(recipe, { name: 'mcp__other__x', asks: '', usable: true }), /does not list/);
  // Multi-word server names compare by slug.
  assert.equal(recipes.backgroundRefusal(recipe, { name: 'mcp__remote_docs__search', asks: '', usable: true }), '');
});

test('backgroundOffer keeps only what may run: no writes, no spawn_agent, no asking or unready MCP tools', () => {
  const storage = memoryStorage();
  tools.setAlways('mcp__weather__forecast', storage);
  const mcp = (server, tool) => ({ type: 'function', function: { name: tools.mcpToolName(server, tool), parameters: {} } });
  const defs = tools.catalogue({ github: true, localRoot: '', shell: false }, storage).concat([
    tools.SPAWN_AGENT,
    mcp('Weather', 'forecast'),
    mcp('browser', 'click'),
    mcp('other', 'thing'),
  ]);
  const offered = recipes.backgroundOffer(recipe, defs, (n) => tools.needsApproval(n, storage), ['Weather', 'Remote Docs']);
  const names = offered.map((d) => d.function.name);
  assert.ok(names.includes('web_search'));
  assert.ok(names.includes('web_fetch'));
  assert.ok(names.includes('github_read_file'));
  assert.ok(names.includes('mcp__weather__forecast'));
  for (const refused of ['github_commit_file', 'github_delete_file', 'github_create_branch', 'spawn_agent', 'mcp__browser__click', 'mcp__other__thing']) {
    assert.ok(!names.includes(refused), refused);
  }
  // With the server not ready, even an always-allowed tool is not offered.
  const none = recipes.backgroundOffer(recipe, [mcp('Weather', 'forecast')], () => '', []);
  assert.deepEqual(none, []);
});

test('RecipesScreen runs background recipes through runTurn with the refusal as the only gate', () => {
  const src = read('desktop', 'src', 'screens', 'RecipesScreen.tsx');
  const body = src.slice(src.indexOf('export async function runRecipeInBackground'), src.indexOf('interface Form'));
  assert.match(body, /await runTurn\(\{/);
  assert.match(body, /recipesLib\.backgroundOffer\(recipe, toolsLib\.catalogue\(/);
  assert.match(body, /recipesLib\.backgroundRefusal\(recipe, \{/);
  assert.ok(body.indexOf('backgroundRefusal') < body.indexOf('executeTool('), 'refusal is checked before running');
  assert.match(body, /refusal \? Promise\.resolve\(refusal\) : executeTool\(call, args, \{ localRoot: '' \}\)/);
  assert.doesNotMatch(body, /collectReply\(/);
  // Servers start only with consent (backgroundServers), and what was skipped is noted.
  const prep = src.slice(src.indexOf('async function prepareServers'), src.indexOf('export async function runRecipeInBackground'));
  assert.match(prep, /recipesLib\.backgroundServers\(/);
  assert.match(prep, /for \(const name of plan\.start\)/);
  assert.match(prep, /no consent to start/);
});
