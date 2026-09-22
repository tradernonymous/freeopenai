// Phase 12a: scheduled / "Run now" recipes. Which calls a background run may
// make is pure and lives in recipes.js (backgroundServers, backgroundRefusal,
// backgroundGate, backgroundOffer); RecipesScreen wires it into Chat's tool
// loop, asserted here as source. NEURA-036: a call that asks pauses the run for
// an approval (approvalQueue) instead of being refused.
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

test('backgroundOffer offers what may run or ask: no spawn_agent, no unlisted or unready MCP tools', () => {
  const storage = memoryStorage();
  tools.setAlways('mcp__weather__forecast', storage);
  const mcp = (server, tool) => ({ type: 'function', function: { name: tools.mcpToolName(server, tool), parameters: {} } });
  const defs = tools.catalogue({ github: true, localRoot: '', shell: false }, storage).concat([
    tools.SPAWN_AGENT,
    mcp('Weather', 'forecast'),
    mcp('Remote Docs', 'search'),
    mcp('browser', 'click'),
    mcp('other', 'thing'),
  ]);
  const offered = recipes.backgroundOffer(recipe, defs, (n) => tools.needsApproval(n, storage), ['Weather', 'Remote Docs']);
  const names = offered.map((d) => d.function.name);
  for (const kept of ['web_search', 'web_fetch', 'github_read_file', 'mcp__weather__forecast',
    // These ask: offered now, and a call pauses the run for an approval (NEURA-036).
    'github_commit_file', 'github_delete_file', 'github_create_branch', 'mcp__remote_docs__search']) {
    assert.ok(names.includes(kept), kept);
  }
  for (const refused of ['spawn_agent', 'mcp__browser__click', 'mcp__other__thing']) {
    assert.ok(!names.includes(refused), refused);
  }
  // With the server not ready, even an always-allowed tool is not offered.
  const none = recipes.backgroundOffer(recipe, [mcp('Weather', 'forecast')], () => '', []);
  assert.deepEqual(none, []);
});

test('backgroundGate: refuse what never runs here, ask for what asks, remember "always" per recipe', () => {
  const storage = memoryStorage();
  assert.deepEqual(recipes.backgroundGate(recipe, { name: 'web_search', asks: '' }, storage), { action: 'run', text: '' });
  const spawn = recipes.backgroundGate(recipe, { name: 'spawn_agent', asks: 'starts a helper' }, storage);
  assert.equal(spawn.action, 'refuse');
  assert.match(spawn.text, /sub-agents do not run in a background/);
  assert.equal(recipes.backgroundGate(recipe, { name: 'mcp__other__x', asks: 'x', usable: true }, storage).action, 'refuse');
  assert.equal(recipes.backgroundGate(recipe, { name: 'mcp__weather__forecast', asks: 'x', usable: false }, storage).action, 'refuse');
  // Asks: paused for an approval; the text is today's refusal, used on a timeout.
  const asks = tools.needsApproval('github_commit_file', storage);
  const gate = recipes.backgroundGate(recipe, { name: 'github_commit_file', asks }, storage);
  assert.equal(gate.action, 'ask');
  assert.equal(gate.text, recipes.backgroundRefusal(recipe, { name: 'github_commit_file', asks }));
  assert.match(gate.text, /needs your approval; run this recipe from chat \(\/recipe brief\)/);
  // "Always for this recipe" is remembered for this recipe and this tool only.
  assert.equal(recipes.recipeAllows('brief', 'github_commit_file', storage), false);
  assert.ok(recipes.allowForRecipe('brief', 'github_commit_file', storage));
  assert.equal(recipes.recipeAllows('brief', 'github_commit_file', storage), true);
  assert.equal(recipes.backgroundGate(recipe, { name: 'github_commit_file', asks }, storage).action, 'run');
  assert.equal(recipes.backgroundGate({ ...recipe, id: 'other' }, { name: 'github_commit_file', asks }, storage).action, 'ask');
  assert.equal(recipes.backgroundGate(recipe, { name: 'github_delete_file', asks }, storage).action, 'ask');
  // It never lifts a structural refusal.
  recipes.allowForRecipe('brief', 'spawn_agent', storage);
  assert.equal(recipes.backgroundGate(recipe, { name: 'spawn_agent', asks: 'x' }, storage).action, 'refuse');
  assert.ok(JSON.parse(storage.getItem(recipes.ALWAYS_KEY))['brief\ngithub_commit_file'] > 0);
});

test('approvalText is the notification line', () => {
  assert.equal(
    recipes.approvalText('Daily brief', 'Commit notes.md to me/repo'),
    'Recipe Daily brief wants to commit notes.md to me/repo — open NeuraOS to allow',
  );
  assert.match(recipes.approvalText('', ''), /^Recipe untitled wants to use a tool/);
});

function fakeClock(start) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      timers.filter((x) => !x.cleared && x.at <= t).forEach((x) => { x.cleared = true; x.fn(); });
    },
    setTimer: (fn, ms) => { const x = { fn, at: t + ms, cleared: false }; timers.push(x); return x; },
    clearTimer: (x) => { if (x) x.cleared = true; },
    live: () => timers.filter((x) => !x.cleared).length,
  };
}

test('approvalQueue: pending list, answers resolve the paused run, and subscribers hear each change', async () => {
  const clock = fakeClock(1000);
  const q = recipes.approvalQueue({ ...clock, timeoutMs: 60000, storage: memoryStorage() });
  const heard = [];
  const off = q.subscribe((rows) => heard.push(rows.length));
  const first = q.request({ recipeId: 'brief', recipeName: 'Brief', tool: 'github_commit_file', summary: 'Commit a', asks: 'writes' });
  const second = q.request({ recipeId: 'brief', recipeName: 'Brief', tool: 'mcp__weather__alert', summary: 'weather: alert' });
  const rows = q.pending();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].recipeName, 'Brief');
  assert.equal(rows[0].expiresAt, 61000);
  assert.equal(clock.live(), 2);
  assert.equal(q.answer(rows[0].id, 'bogus'), false);
  assert.equal(q.answer(rows[0].id, 'timeout'), false, 'only the clock times out');
  assert.equal(q.answer('nope', 'once'), false);
  assert.ok(q.answer(rows[0].id, 'once'));
  assert.equal(await first, 'once');
  assert.ok(q.answer(rows[1].id, 'deny'));
  assert.equal(await second, 'deny');
  assert.equal(q.pending().length, 0);
  assert.equal(clock.live(), 0, 'answered approvals clear their timers');
  assert.deepEqual(heard, [1, 2, 1, 0]);
  off();
  q.request({ recipeId: 'x', tool: 't' });
  assert.deepEqual(heard, [1, 2, 1, 0], 'unsubscribed');
});

test('approvalQueue: nobody answering is a timeout (auto-deny) after timeoutMs', async () => {
  const clock = fakeClock(0);
  const q = recipes.approvalQueue({ ...clock, timeoutMs: 30 * 60000 });
  const waiting = q.request({ recipeId: 'brief', tool: 'github_commit_file' });
  clock.advance(30 * 60000 - 1);
  assert.equal(q.pending().length, 1);
  clock.advance(1);
  assert.equal(await waiting, 'timeout');
  assert.equal(q.pending().length, 0);
  // sweep() does the same without timers.
  const manual = recipes.approvalQueue({ now: () => 0, setTimer: null, timeoutMs: 1000 });
  const p = manual.request({ recipeId: 'a', tool: 'b' });
  assert.equal(manual.sweep(999), 0);
  assert.equal(manual.sweep(1000), 1);
  assert.equal(await p, 'timeout');
  assert.equal(recipes.APPROVAL_TIMEOUT_MS, 30 * 60000);
  assert.equal(recipes.approvalQueue().timeoutMs, 30 * 60000, 'the default is 30 minutes');
});

test('approvalQueue: "always" remembers the tool for the recipe and settles its other pending asks', async () => {
  const storage = memoryStorage();
  const q = recipes.approvalQueue({ now: () => 5, setTimer: null, storage });
  const a = q.request({ recipeId: 'brief', tool: 'github_commit_file' });
  const b = q.request({ recipeId: 'brief', tool: 'github_commit_file' });
  const other = q.request({ recipeId: 'other', tool: 'github_commit_file' });
  assert.ok(q.answer(q.pending()[0].id, 'always'));
  assert.equal(await a, 'always');
  assert.equal(await b, 'always');
  assert.equal(q.pending().length, 1);
  assert.equal(q.pending()[0].recipeId, 'other');
  assert.equal(recipes.recipeAllows('brief', 'github_commit_file', storage), true);
  assert.equal(recipes.recipeAllows('other', 'github_commit_file', storage), false);
  q.answer(q.pending()[0].id, 'deny');
  assert.equal(await other, 'deny');
});

test('the app has one approvals queue, read by the sidebar badge and the Recipes screen', () => {
  assert.equal(typeof recipes.approvals.request, 'function');
  assert.deepEqual(recipes.approvals.pending(), []);
  const sidebar = read('desktop', 'src', 'Sidebar.tsx');
  assert.match(sidebar, /recipesLib\.approvals\.subscribe\(/);
  assert.match(sidebar, /className="sidebar-badge"/);
  const screen = read('desktop', 'src', 'screens', 'RecipesScreen.tsx');
  assert.match(screen, /recipesLib\.approvals\.subscribe\(setPending\)/);
  for (const [label, decision] of [['Allow once', 'once'], ['Deny', 'deny'], ['Always for this recipe', 'always']]) {
    assert.ok(screen.includes(`answer(p.id, '${decision}')}>${label}<`) || screen.includes(`answer(p.id, '${decision}')} title=`), label);
    assert.ok(screen.includes(`>${label}</button>`), label);
  }
  assert.match(screen, /<RecipeApprovals \/>/);
});

test('RecipesScreen runs background recipes through runTurn with backgroundGate as the only gate', () => {
  const src = read('desktop', 'src', 'screens', 'RecipesScreen.tsx');
  const body = src.slice(src.indexOf('export async function runRecipeInBackground'), src.indexOf('interface Form'));
  assert.match(body, /await runTurn\(\{/);
  assert.match(body, /recipesLib\.backgroundOffer\(recipe, toolsLib\.catalogue\(/);
  assert.match(body, /recipesLib\.backgroundGate\(recipe, \{/);
  assert.ok(body.indexOf('backgroundGate') < body.indexOf('executeTool('), 'the gate is checked before running');
  assert.ok(body.includes("gate.action === 'run' ? executeTool(call, args, { localRoot: '' }) : Promise.resolve(gate.text)"));
  // A call that asks pauses: notification, queued approval, and the run's clock stops meanwhile.
  assert.ok(body.includes("if (gate.action !== 'ask') return true;"));
  assert.ok(body.includes('notifyUser(`${recipe.name} needs your approval`, line)'));
  assert.ok(body.includes('await recipesLib.approvals.request({'));
  assert.ok(body.indexOf('pauseClock()') < body.indexOf('approvals.request') && body.indexOf('approvals.request') < body.indexOf('resumeClock()'));
  assert.ok(body.includes("if (decision === 'deny') return false;"));
  assert.ok(body.includes("decision === 'timeout' ? gate.text : ''"));
  assert.doesNotMatch(body, /collectReply\(/);
  // Servers start only with consent (backgroundServers), and what was skipped is noted.
  const prep = src.slice(src.indexOf('async function prepareServers'), src.indexOf('export async function runRecipeInBackground'));
  assert.match(prep, /recipesLib\.backgroundServers\(/);
  assert.match(prep, /for \(const name of plan\.start\)/);
  assert.match(prep, /no consent to start/);
});
