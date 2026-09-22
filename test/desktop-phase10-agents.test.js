// Phase 10: declarative agents (6.7), recipes and automations (6.8), and the
// browser preset (5.6). The rules are pure and tested here: an agent or a
// recipe is data and never code, tool names map onto what tools.js offers,
// templates fill, and a schedule is due exactly when it should be.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const agents = require('../desktop/src/agents.js');
const recipes = require('../desktop/src/recipes.js');
const tools = require('../desktop/src/tools.js');

function memory() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    data,
  };
}

const good = {
  id: 'summariser',
  name: 'Summariser',
  description: 'Summarises',
  systemPrompt: 'Summarise.',
  toolNames: ['web_fetch', 'files/read_file', 'browser/*'],
  outputMode: 'last_message',
  includeMessageHistory: false,
};

// ---- agents: validation ---------------------------------------------------------

test('a well-formed agent validates and unknown keys are dropped with a warning', () => {
  const checked = agents.validate({ ...good, colour: 'blue' });
  assert.equal(checked.ok, true, checked.errors.join(' '));
  assert.equal('colour' in checked.agent, false);
  assert.match(checked.warnings[0], /colour/);
  assert.deepEqual(checked.agent.toolNames, ['web_fetch', 'files/read_file', 'browser/*']);
});

test('code-carrying fields are refused with a reason, never dropped quietly', () => {
  for (const key of ['handleSteps', 'code', 'script', 'function', 'handler']) {
    const checked = agents.validate({ ...good, [key]: 'function* () { yield "x" }' });
    assert.equal(checked.ok, false, `${key} must be refused`);
    assert.match(checked.errors[0], /code/i);
    assert.equal(checked.agent, null);
  }
  const fn = agents.validate({ ...good, outputSchema: { type: 'object', check: () => true } });
  assert.equal(fn.ok, false);
  assert.match(fn.errors[0], /function/);
});

test('required fields and types are checked strictly', () => {
  assert.equal(agents.validate(null).ok, false);
  assert.equal(agents.validate([]).ok, false);
  const bad = agents.validate({ id: 'Bad Id', name: '', systemPrompt: '', toolNames: ['rm -rf /'], outputMode: 'chatty', includeMessageHistory: 'yes' });
  assert.equal(bad.ok, false);
  const text = bad.errors.join('\n');
  assert.match(text, /id:/);
  assert.match(text, /name is required/);
  assert.match(text, /systemPrompt is required/);
  assert.match(text, /toolNames/);
  assert.match(text, /outputMode/);
  assert.match(text, /includeMessageHistory/);
  assert.match(agents.validate({ ...good, outputMode: 'structured' }).errors.join(' '), /outputSchema/);
  assert.match(agents.validate({ ...good, model: { provider: 'groq' } }).errors.join(' '), /model/);
  assert.equal(agents.validate({ ...good, model: { provider: 'groq', model: 'llama' } }).agent.model.model, 'llama');
});

test('the three built-ins validate, and the browser agent keeps credentials away from the model', () => {
  const ids = agents.BUILTINS.map((b) => b.id);
  assert.deepEqual(ids, ['file-picker', 'reviewer', 'browser']);
  for (const b of agents.BUILTINS) assert.equal(agents.validate(b).ok, true, b.id);
  const browser = agents.BUILTINS.find((b) => b.id === 'browser');
  assert.deepEqual(browser.toolNames, ['browser/*']);
  assert.match(browser.systemPrompt, /credentials/i);
  assert.match(browser.systemPrompt, /type it into the browser themselves/);
  const picker = agents.BUILTINS.find((b) => b.id === 'file-picker');
  assert.deepEqual(picker.toolNames, ['list_files', 'read_file']);
  assert.equal(picker.outputMode, 'structured');
});

// ---- agents: tool names ------------------------------------------------------------

test('server/tool names map onto the mcp__ names tools.js offers', () => {
  assert.equal(agents.toolName('read_file'), 'read_file');
  assert.equal(agents.toolName('files/read_file'), tools.mcpToolName('files', 'read_file'));
  assert.equal(agents.toolName('My Server/do.it'), tools.mcpToolName('My Server', 'do.it'));
  assert.equal(agents.toolName('browser/*'), 'mcp__browser__*');
  assert.equal(agents.allowsTool(['browser/*'], 'mcp__browser__navigate_page'), true);
  assert.equal(agents.allowsTool(['browser/*'], 'mcp__browserish__x'), false, 'a prefix is not a server');
  assert.equal(agents.allowsTool(['read_file'], 'write_file'), false);
});

test('an agent is offered only its own tools, never spawn_agent by name', () => {
  const store = memory();
  tools.addStdioServer({ name: 'browser', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], tools: [{ name: 'navigate_page' }, { name: 'click' }] }, store);
  const defs = tools.catalogue({ localRoot: 'C:/w', shell: true }, store).concat([tools.SPAWN_AGENT]);
  const picked = agents.pickTools({ toolNames: ['read_file', 'browser/*', 'spawn_agent'] }, defs).map((d) => d.function.name);
  assert.deepEqual(picked.sort(), ['mcp__browser__click', 'mcp__browser__navigate_page', 'read_file']);
});

test('spawn_agent asks first unless always-allowed, and routes through tool-run', () => {
  const store = memory();
  assert.equal(tools.SPAWN_AGENT.function.name, 'spawn_agent');
  assert.deepEqual(tools.SPAWN_AGENT.function.parameters.required, ['agent', 'task']);
  assert.match(tools.needsApproval('spawn_agent', store), /sub-agent/);
  assert.equal(tools.alwaysKey('spawn_agent'), 'agent:spawn');
  assert.equal(tools.setAlways('spawn_agent', store), true);
  assert.equal(tools.needsApproval('spawn_agent', store), '');
  assert.equal(tools.alwaysKey('write_file'), '', 'writes still never get "always"');
  const run = read('desktop', 'src', 'tool-run.ts');
  assert.match(run, /if \(name === 'spawn_agent'\) return context\.spawnAgent \? context\.spawnAgent\(args\)/);
});

test('spawn targets: a spawner starts only its spawnableAgents; chat may start any', () => {
  const all = agents.list(memory());
  assert.deepEqual(agents.spawnTargets(null, all), ['file-picker', 'reviewer', 'browser']);
  assert.deepEqual(agents.spawnTargets({ id: 'x', spawnableAgents: ['reviewer', 'ghost', 'x'] }, all), ['reviewer']);
  assert.deepEqual(agents.spawnTargets({ id: 'x' }, all), []);
  assert.match(agents.spawnDescription(all), /file-picker/);
});

// ---- agents: storage, import, running ----------------------------------------------

test('saving, overriding a built-in, resetting and import/export round-trip', () => {
  const store = memory();
  assert.equal(agents.save(good, store).ok, true);
  assert.equal(agents.get('summariser', store).name, 'Summariser');
  assert.equal(agents.save({ ...good, handleSteps: 'x' }, store).ok, false, 'a refused agent is not stored');
  const edited = { ...agents.get('reviewer', store), name: 'Strict reviewer' };
  agents.save(edited, store);
  assert.equal(agents.get('reviewer', store).name, 'Strict reviewer');
  assert.equal(agents.isOverridden('reviewer', store), true);
  agents.remove('reviewer', store);
  assert.equal(agents.get('reviewer', store).name, 'Reviewer', 'reset to the shipped definition');
  const exported = agents.exportJson(agents.list(store));
  const back = agents.parseImport(exported);
  assert.equal(back.errors.length, 0);
  assert.ok(back.agents.some((a) => a.id === 'summariser'));
  const mixed = agents.parseImport(JSON.stringify([good, { ...good, id: 'evil', code: 'alert(1)' }]));
  assert.equal(mixed.agents.length, 1);
  assert.match(mixed.errors[0], /^evil: .*code/);
  assert.match(agents.parseImport('{nope').errors[0], /valid JSON/);
});

test('a sub-turn starts from the agent prompt, and history only when asked for', () => {
  const history = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  const without = agents.messagesFor(agents.validate(good).agent, 'do it', history);
  assert.deepEqual(without.map((m) => m.role), ['system', 'user']);
  const withHistory = agents.messagesFor({ ...agents.validate(good).agent, includeMessageHistory: true }, 'do it', history);
  assert.deepEqual(withHistory.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  const structured = agents.messagesFor(agents.validate(agents.BUILTINS[0]).agent, 'find', []);
  assert.match(structured[0].content, /JSON schema/);
  assert.deepEqual(agents.parseCommand('File-Picker  find the router'), { id: 'file-picker', task: 'find the router' });
});

test('structured output is checked against required keys and types, and pretty-printed', () => {
  const picker = agents.validate(agents.BUILTINS[0]).agent;
  const ok = agents.formatResult(picker, 'Sure:\n```json\n{"paths":["a.js","b.js"],"reason":"routes"}\n```');
  assert.equal(ok.ok, true);
  assert.match(ok.text, /^```json\n\{\n {2}"paths": \[/);
  const missing = agents.formatResult(picker, '{"reason": "none"}');
  assert.equal(missing.ok, false);
  assert.match(missing.text, /Missing required key "paths"/);
  const wrongType = agents.checkStructured('{"paths": "a.js"}', picker.outputSchema);
  assert.match(wrongType.errors[0], /"paths" should be array/);
  assert.equal(agents.formatResult(picker, 'no json here').ok, false);
  const plain = agents.formatResult(agents.validate(good).agent, '<think>hmm</think>The answer.');
  assert.equal(plain.text, 'The answer.');
});

// ---- recipes ------------------------------------------------------------------------

const recipe = {
  id: 'brief',
  name: 'Brief',
  systemPrompt: 'Be short.',
  prompt: 'Brief me on {{topic}} in a {{tone}} tone for {{ who }}.',
  params: [{ name: 'topic', label: 'Topic', default: 'AI' }, { name: 'tone', label: 'Tone', default: '' }, { name: 'who', label: 'Who' }],
  extensions: ['browser'],
};

test('recipes validate strictly and refuse code', () => {
  assert.equal(recipes.validate(recipe).ok, true);
  assert.equal(recipes.validate({ ...recipe, handleSteps: 'x' }).ok, false);
  assert.equal(recipes.validate({ ...recipe, run: () => 1 }).ok, false);
  assert.match(recipes.validate({ ...recipe, schedule: { dailyAt: '25:00' } }).errors.join(' '), /HH:MM/);
  assert.match(recipes.validate({ ...recipe, schedule: { everyMinutes: 0 } }).errors.join(' '), /everyMinutes/);
  assert.match(recipes.validate({ ...recipe, schedule: {} }).errors.join(' '), /everyMinutes or dailyAt/);
  assert.match(recipes.validate({ ...recipe, params: [{ name: 'bad name' }] }).errors.join(' '), /parameter name/);
  assert.equal(recipes.validate({ ...recipe, schedule: { everyMinutes: 30 } }).recipe.schedule.enabled, true);
});

test('templates fill from values, then defaults, and name what is missing', () => {
  const filled = recipes.fillTemplate(recipe.prompt, recipe.params, { tone: 'dry' });
  assert.equal(filled.text, 'Brief me on AI in a dry tone for .');
  assert.deepEqual(filled.missing, ['who']);
  assert.deepEqual(recipes.fillTemplate(recipe.prompt, recipe.params, { tone: 'dry', who: 'me', topic: 'Rust' }).missing, []);
  assert.deepEqual(recipes.placeholders(recipe.prompt), ['topic', 'tone', 'who']);
});

test('/recipe arguments: key=value, quotes keep spaces, loose words fill the first open parameter', () => {
  assert.deepEqual(recipes.parseCommand('Brief topic="async rust" who=me', recipe.params), { id: 'brief', values: { topic: 'async rust', who: 'me' } });
  assert.deepEqual(recipes.parseCommand('brief tone=dry the borrow checker', recipe.params).values, { tone: 'dry', topic: 'the borrow checker' });
  assert.deepEqual(recipes.parseCommand('', recipe.params), { id: '', values: {} });
});

test('nextRun: every N minutes counts from the last run; never run is due now', () => {
  const r = { ...recipe, schedule: { everyMinutes: 30, enabled: true } };
  const t0 = new Date(2026, 8, 22, 9, 0).getTime();
  assert.equal(recipes.nextRun(r, null, t0), t0);
  assert.equal(recipes.nextRun(r, t0, t0 + 1000), t0 + 30 * 60000);
  assert.equal(recipes.isDue(r, t0, t0 + 29 * 60000), false);
  assert.equal(recipes.isDue(r, t0, t0 + 30 * 60000), true);
  assert.equal(recipes.nextRun({ ...r, schedule: { everyMinutes: 30, enabled: false } }, t0, t0), null, 'off is never due');
  assert.equal(recipes.nextRun({ ...recipe }, t0, t0), null, 'no schedule, no run');
});

test('nextRun: daily at HH:MM, catching up once after the app was closed', () => {
  const r = { ...recipe, schedule: { dailyAt: '08:30' } };
  const at = (d, h, m) => new Date(2026, 8, d, h, m).getTime();
  // Turned on at 10:00, never run: tomorrow 08:30, not at once.
  assert.equal(recipes.nextRun(r, null, at(22, 10, 0)), at(23, 8, 30));
  // Turned on at 07:00: today 08:30.
  assert.equal(recipes.nextRun(r, null, at(22, 7, 0)), at(22, 8, 30));
  // Ran yesterday at 08:30; now 10:00 -> today's slot is past, so due now.
  assert.equal(recipes.nextRun(r, at(21, 8, 30), at(22, 10, 0)), at(22, 8, 30));
  assert.equal(recipes.isDue(r, at(21, 8, 30), at(22, 10, 0)), true);
  // Ran today at 08:30 -> tomorrow.
  assert.equal(recipes.nextRun(r, at(22, 8, 30), at(22, 10, 0)), at(23, 8, 30));
  // Closed for three days: one catch-up, then the normal slot.
  assert.equal(recipes.nextRun(r, at(18, 8, 30), at(22, 10, 0)), at(19, 8, 30));
  // Both set: whichever is first.
  const both = { ...recipe, schedule: { dailyAt: '08:30', everyMinutes: 60 } };
  assert.equal(recipes.nextRun(both, at(22, 8, 0), at(22, 8, 5)), at(22, 8, 30));
  const due = recipes.dueRecipes([r, { ...recipe, id: 'other' }], { brief: { at: at(21, 8, 30) } }, at(22, 10, 0));
  assert.deepEqual(due.map((x) => x.id), ['brief']);
});

test('consent is remembered per recipe and server; runs are recorded', () => {
  const store = memory();
  assert.deepEqual(recipes.needsConsent(recipes.validate(recipe).recipe, store), ['browser']);
  recipes.grantConsent('brief', ['Browser'], store);
  assert.equal(recipes.hasConsent('brief', 'browser', store), true, 'server names compare by slug');
  assert.equal(recipes.hasConsent('other', 'browser', store), false, 'another recipe asks again');
  assert.deepEqual(recipes.needsConsent(recipes.validate(recipe).recipe, store), []);
  recipes.recordRun('brief', { at: 5, ok: true }, store);
  assert.equal(recipes.lastRuns(store).brief.at, 5);
  assert.match(recipes.runTitle({ name: 'Brief' }, new Date(2026, 8, 22, 8, 5).getTime()), /^Brief · 2026-09-22 08:05$/);
  const asAgent = recipes.asAgent(recipes.validate({ ...recipe, responseSchema: { type: 'object' } }).recipe);
  assert.deepEqual(asAgent.toolNames, ['browser/*']);
  assert.equal(asAgent.outputMode, 'structured');
  assert.equal(agents.validate(asAgent).ok, true, 'a recipe runs as a valid agent');
});

// ---- wiring --------------------------------------------------------------------------

test('/agent and /recipe are slash commands with branches in ChatScreen', () => {
  const composer = require('../desktop/src/composer.js');
  assert.equal(composer.parseSlash('/agent reviewer check it').command.id, 'agent');
  assert.equal(composer.parseSlash('/recipe brief topic=x').command.id, 'recipe');
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /case 'agent': \{/);
  assert.match(chat, /case 'recipe': \{/);
  assert.match(chat, /runAgentInChat\(agent, task,/);
  assert.match(chat, /runRecipeInChat\(recipe, recipesLib\.parseCommand\(arg, recipe\.params\)\.values\)/);
  // Sub-turns: only the agent's tools, its model or the chat's, history only if asked.
  assert.match(chat, /agentsLib\.pickTools\(agent, toolsLib\.catalogue/);
  assert.match(chat, /agent\.model \|\| \{ provider: active\.provider, model: active\.model \}/);
  assert.match(chat, /agent\.includeMessageHistory \? turnsFor\(run\.history\) : \[\]/);
  // spawn_agent is offered outside Plan and keeps the approval card.
  assert.match(chat, /\.concat\(active\.mode !== 'plan' \? spawnDefFor\(null\) : \[\]\)/);
  assert.match(chat, /approve: \(event\) => ask\(\{ \.\.\.event, id: prefix \+ event\.id \}\)/);
  // Consent before a recipe's servers start.
  assert.match(chat, /recipesLib\.needsConsent\(recipe\)/);
  assert.match(chat, /className="consent-dialog"/);
});

test('Agents and Recipes are Library tabs, rendered, and on the palette', () => {
  const sidebar = read('desktop', 'src', 'Sidebar.tsx');
  assert.match(sidebar, /\{ id: 'agents', label: 'Agents', parent: 'library' \}/);
  assert.match(sidebar, /\{ id: 'recipes', label: 'Recipes', parent: 'library' \}/);
  const app = read('desktop', 'src', 'App.tsx');
  assert.match(app, /view === 'agents' && <AgentsScreen \/>/);
  assert.match(app, /view === 'recipes' && <RecipesScreen \/>/);
  assert.match(app, /useRecipeScheduler\(\);/);
  const commands = require('../desktop/src/commands.js');
  assert.ok(commands.COMMANDS.some((c) => c.palette === 'agents'));
  assert.ok(commands.COMMANDS.some((c) => c.palette === 'recipes'));
  const screen = read('desktop', 'src', 'screens', 'RecipesScreen.tsx');
  assert.match(screen, /recipesLib\.dueRecipes\(recipesLib\.list\(\), recipesLib\.lastRuns\(\), now\)/);
  assert.match(screen, /collectReply\(/);
  assert.match(screen, /recipesLib\.runTitle\(recipe, startedAt\)/);
  assert.match(screen, /notifyUser\(/);
  assert.doesNotMatch(screen + read('desktop', 'src', 'screens', 'AgentsScreen.tsx'), /<select/, 'no native select');
});

test('the browser preset adds Chrome DevTools MCP as the local server "browser"', () => {
  const card = read('desktop', 'src', 'components', 'ConnectorsCard.tsx');
  assert.match(card, /addPreset\(\{ name: 'browser', command: 'npx', args: \['-y', 'chrome-devtools-mcp@latest'\] \}\)/);
  assert.match(card, /Browser \(Chrome DevTools MCP\)/);
  assert.match(card, /Stagehand is out of scope/);
});
