const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the chat has a restrained futuristic ambient layer', () => {
  assert.match(html, /body::before[\s\S]*?ambient-grid/);
  assert.match(html, /\.chat-card::before[\s\S]*?edge-scan/);
  assert.match(html, /\.composer:focus-within[\s\S]*?composer-flow/);
  assert.match(html, /id="commandState"[^>]*aria-live="polite"/);
  assert.match(html, /function updateCommandState\([\s\S]*?dataset\.state/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: \.001ms/);
});

test('primary interactions acknowledge hover, focus, and press', () => {
  assert.match(html, /\.hero-card:hover[\s\S]*?transform: translateY\(-2px\)/);
  assert.match(html, /\.hero-start:hover[\s\S]*?box-shadow: 0 0 18px var\(--accent-bg\)/);
  assert.match(html, /\.composer-send:hover:not\(:disabled\)[\s\S]*?rotate\(-2deg\)/);
  assert.match(html, /\.composer-send:focus-visible[\s\S]*?var\(--glow\)/);
  assert.match(html, /\.command-state\[data-state="running"\][\s\S]*?state-ping/);
});
