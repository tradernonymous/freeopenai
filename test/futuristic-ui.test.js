const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { COMMAND_STATES, commandStateOf, commandStateLabel } = require('../command-state.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the chat has a restrained futuristic ambient layer', () => {
  assert.match(html, /body::before[\s\S]*?ambient-grid/);
  assert.match(html, /\.chat-card::before[\s\S]*?edge-scan/);
  assert.match(html, /\.composer:focus-within[\s\S]*?composer-flow/);
  assert.match(html, /id="commandState"[^>]*aria-live="polite"/);
  assert.match(html, /class="brand-name">FreeAi4U<\/span>/);
  assert.match(html, /\.chat-bar-title \.brand-name \{ display: none; \}/);
  assert.match(html, /command-state\.js/);
  assert.match(html, /function updateCommandState\([\s\S]*?FreeOpenAICommandState\.commandStateOf/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: \.001ms/);
});

test('command state is a pure precedence rule', () => {
  assert.deepEqual(COMMAND_STATES, ['ready', 'plan', 'build', 'draw', 'running']);
  assert.equal(commandStateOf(), 'ready');
  assert.equal(commandStateOf({ selectedMode: 'plan' }), 'plan');
  assert.equal(commandStateOf({ selectedMode: 'build' }), 'build');
  assert.equal(commandStateOf({ imageMode: true, selectedMode: 'build' }), 'draw');
  assert.equal(commandStateOf({ isTyping: true, imageMode: true, selectedMode: 'build' }), 'running');
  assert.equal(commandStateLabel('draw'), 'DRAW');
  assert.equal(commandStateLabel('unknown'), 'READY');
});

test('primary interactions acknowledge hover, focus, and press', () => {
  assert.match(html, /\.hero-card:hover[\s\S]*?transform: translateY\(-2px\)/);
  assert.match(html, /\.hero-start:hover[\s\S]*?box-shadow: 0 0 18px var\(--accent-bg\)/);
  assert.match(html, /\.composer-send:hover:not\(:disabled\)[\s\S]*?rotate\(-2deg\)/);
  assert.match(html, /\.composer-send:focus-visible[\s\S]*?var\(--glow\)/);
  assert.match(html, /\.command-state\[data-state="running"\][\s\S]*?state-ping/);
});
