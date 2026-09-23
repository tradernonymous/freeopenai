// A turn never ends in silence.
//
// Two ways it used to, and both looked like the app was broken rather than
// the model being unfinished:
//
//   * a model that streams only its reasoning (reasoning_content, kept as
//     <think> so the chat can fold it) left a "Thought" block and no answer;
//   * a research-shaped request -- "audit this repo and draft a plan" -- spent
//     a round per read and per search, ran out of rounds, and left a pile of
//     tool cards and no plan.
//
// Both now get one closing pass with the tools withheld, so the only thing the
// model can do with it is answer. These tests drive the real module:
// agent-turn.ts is TypeScript, so it is transpiled with the esbuild already in
// desktop/node_modules and loaded, rather than asserted against as text --
// source assertions cannot tell whether a loop actually terminates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');

function loadTurn() {
  const esbuild = require(path.join(DESKTOP, 'node_modules', 'esbuild'));
  const source = fs.readFileSync(path.join(DESKTOP, 'src', 'agent-turn.ts'), 'utf8');
  const js = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  // The module reads FreeAI4UTools off globalThis (the UMD convention this
  // repo uses), so the real tools.js is loaded first for MAX_ROUNDS and the
  // message builders -- the cap under test is its cap, not a copy.
  require(path.join(DESKTOP, 'src', 'tools.js'));
  const filename = path.join(DESKTOP, 'src', 'agent-turn.generated.js');
  const mod = new Module(filename, null);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.join(DESKTOP, 'src'));
  mod._compile(js, filename);
  return mod.exports;
}

const turn = loadTurn();
const tools = require(path.join(DESKTOP, 'src', 'tools.js'));

/** A stream that replays scripted rounds and records what it was offered. */
function scripted(rounds) {
  const offers = [];
  let round = 0;
  return {
    offers,
    get rounds() { return round; },
    stream: async (messages, offered, onFrame) => {
      offers.push(offered);
      const step = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      if (step.content) onFrame({ content: step.content });
      if (step.toolCalls) onFrame({ toolCalls: step.toolCalls });
      onFrame({ done: true });
    },
  };
}

const CALL = [{ index: 0, id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }];
const OFFERED = [{ type: 'function', function: { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } } }];

function collect() {
  const text = [];
  const notes = [];
  return {
    text,
    notes,
    onText: (piece) => text.push(piece),
    onTool: () => {},
    onNote: (note) => notes.push(note),
    answer: () => text.join(''),
  };
}

test('a reply that is only reasoning gets one closing pass, and the answer arrives', async () => {
  const script = scripted([
    { content: '<think>weighing the options</think>' },
    { content: 'Here is the plan: start with the audit.' },
  ]);
  const out = collect();
  await turn.runTurn({
    messages: [{ role: 'user', content: 'draft a plan' }],
    tools: OFFERED,
    stream: script.stream,
    execute: async () => 'unused',
    approve: async () => true,
    onText: out.onText,
    onTool: out.onTool,
    onNote: out.onNote,
  });

  assert.ok(out.answer().includes('Here is the plan'), 'the person gets an answer, not just a Thought block');
  assert.equal(script.offers[1], undefined, 'the closing pass withholds the tools');
  assert.match(out.notes.join(' '), /only the model thinking/i, 'and is told why it asked again');
});

test('the closing pass happens once, so a silent model cannot loop', async () => {
  const script = scripted([{ content: '<think>still thinking</think>' }]);
  const out = collect();
  await turn.runTurn({
    messages: [{ role: 'user', content: 'draft a plan' }],
    tools: [],
    stream: script.stream,
    execute: async () => 'unused',
    approve: async () => true,
    onText: out.onText,
    onTool: out.onTool,
    onNote: out.onNote,
  });

  assert.equal(script.rounds, 2, 'one ordinary round and exactly one closing pass');
  assert.match(out.notes.join(' '), /nothing more to say/i, 'a model with no answer is reported, not hidden');
});

test('running out of rounds asks for the answer instead of going quiet', async () => {
  // A model that keeps calling tools forever: the cap is what stops it, and
  // the closing pass is what makes the turn worth having.
  const script = scripted([{ toolCalls: CALL }]);
  const out = collect();
  await turn.runTurn({
    messages: [{ role: 'user', content: 'audit the repo and draft a plan' }],
    tools: OFFERED,
    stream: async (messages, offered, onFrame) => {
      if (script.rounds >= tools.MAX_ROUNDS) {
        script.offers.push(offered);
        onFrame({ content: 'Plan: 1. audit 2. benchmark 3. backlog' });
        onFrame({ done: true });
        return;
      }
      return script.stream(messages, offered, onFrame);
    },
    execute: async () => 'a search result',
    approve: async () => true,
    onText: out.onText,
    onTool: out.onTool,
    onNote: out.onNote,
  });

  assert.ok(out.answer().includes('Plan:'), 'the plan arrives even though the cap was hit');
  assert.match(out.notes.join(' '), new RegExp(`${tools.MAX_ROUNDS} rounds`), 'and the cap is named');
  assert.equal(script.offers[script.offers.length - 1], undefined, 'the closing pass withheld the tools');
});

test('an ordinary answer is left alone -- no extra call, no note', async () => {
  const script = scripted([{ content: 'The answer is 42.' }]);
  const out = collect();
  await turn.runTurn({
    messages: [{ role: 'user', content: 'what is it' }],
    tools: [],
    stream: script.stream,
    execute: async () => 'unused',
    approve: async () => true,
    onText: out.onText,
    onTool: out.onTool,
    onNote: out.onNote,
  });

  assert.equal(script.rounds, 1, 'one round is enough when the model answered');
  assert.deepEqual(out.notes, [], 'nothing to explain');
});

test('the round cap is high enough for a research-shaped request', () => {
  // Eight was the cap that ended "audit this repo and draft a plan" with tool
  // cards and no plan; a round goes on each read and each search.
  assert.ok(tools.MAX_ROUNDS >= 20, `MAX_ROUNDS is ${tools.MAX_ROUNDS}`);
});

test('visibleAnswer strips the reasoning, including an unclosed one', () => {
  assert.equal(turn.visibleAnswer('<think>a</think>  real  '), 'real');
  assert.equal(turn.visibleAnswer('<think>never closed'), '');
  assert.equal(turn.visibleAnswer('plain'), 'plain');
});
