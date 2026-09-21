// Copy diagnostics: the text a user pastes into a bug report. It has to say
// enough to find the problem, and contain nothing they would regret pasting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const diagnostics = require('../desktop/src/diagnostics.js');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const SHELL = {
  version: '2.4.0',
  os: 'windows',
  arch: 'x86_64',
  webview2: '132.0.2957.140',
  log_path: 'C:\\Users\\x\\AppData\\Local\\FreeAI4U\\logs\\freeai4u-crash.log',
  log_bytes: 2048,
  log_tail: '[2026-09-20T00:00:00Z] WebView2 runtime not found at startup',
  data_dir: 'C:\\Users\\x\\AppData\\Roaming\\com.freeai4u.desktop',
  cache_dir: 'C:\\Users\\x\\AppData\\Local\\com.freeai4u.desktop',
};

test('the report carries what is needed to debug a failure', () => {
  const report = diagnostics.buildReport({
    shell: SHELL,
    client: { engine: 'https://freeopenai-production.up.railway.app', state: 'signed-out · signed out', hasShell: true },
  });
  assert.match(report, /NeuraOS Desktop 2\.4\.0/);
  assert.match(report, /engine\s+https:\/\/freeopenai-production\.up\.railway\.app/);
  assert.match(report, /signed-out/);
  assert.match(report, /shell\s+desktop/);
  assert.match(report, /os\s+windows \/ x86_64/);
  assert.match(report, /webview2\s+132\./);
  assert.match(report, /crash log\s+.*freeai4u-crash\.log \(2 KB\)/);
  assert.match(report, /--- last log lines ---/);
  assert.match(report, /WebView2 runtime not found/);
});

test('a browser build says so rather than claiming a shell it does not have', () => {
  const report = diagnostics.buildReport({ shell: {}, client: { hasShell: false } });
  assert.match(report, /shell\s+browser \(no desktop shell\)/);
});

test('an empty log is described, not silently omitted', () => {
  const report = diagnostics.buildReport({ shell: { ...SHELL, log_bytes: 0, log_tail: '' }, client: {} });
  assert.match(report, /\(empty\)/);
  assert.ok(!report.includes('--- last log lines ---'), 'no empty section');
});

// ---- the part that matters most -----------------------------------------

test('credentials never reach the report', () => {
  assert.equal(diagnostics.redact('token hf_abcdefghijklmnopqrst'), 'token hf_<redacted>');
  assert.equal(diagnostics.redact('key sk-proj-abcdefghijklmnop'), 'key sk-<redacted>');
  assert.equal(diagnostics.redact('Authorization: Bearer abc123.def456'), 'Authorization: Bearer <redacted>');
});

test('a query string is dropped from an address', () => {
  assert.equal(
    diagnostics.redactUrl('https://engine.example.com/api/llm/chat?token=hf_abcdefghijklmnop'),
    'https://engine.example.com/api/llm/chat?<redacted>',
  );
  assert.equal(diagnostics.redactUrl('https://engine.example.com/plain'), 'https://engine.example.com/plain');
  assert.equal(diagnostics.redactUrl(''), '');
});

test('the report redacts a token that came from the shell as well', () => {
  const report = diagnostics.buildReport({
    shell: { ...SHELL, log_tail: 'used key sk-proj-abcdefghijklmnop to call the engine' },
    client: { engine: 'https://engine.example.com/?api_key=hf_abcdefghijklmnop' },
  });
  assert.ok(!report.includes('sk-proj-abcdefghijklmnop'), 'the key is gone');
  assert.ok(!report.includes('hf_abcdefghijklmnop'), 'the token is gone');
  assert.match(report, /sk-<redacted>/);
});

test('sizes read like sizes', () => {
  assert.equal(diagnostics.bytesLabel(0), '0 B');
  assert.equal(diagnostics.bytesLabel(900), '900 B');
  assert.equal(diagnostics.bytesLabel(2048), '2 KB');
  assert.equal(diagnostics.bytesLabel(5 * 1024 * 1024), '5.0 MB');
});

test('the shell gathers the facts and the frontend owns the wording', () => {
  const diagRs = read('desktop', 'src-tauri', 'src', 'diag.rs');
  for (const field of ['version', 'webview2', 'log_path', 'log_bytes', 'log_tail', 'data_dir', 'cache_dir']) {
    assert.ok(diagRs.includes(field), `diag.rs reports ${field}`);
  }
  // The report is built in JS, where node:test can check what it says.
  assert.ok(!/format!\(/.test(diagRs), 'diag.rs gathers; diagnostics.js writes the report');
  const card = read('desktop', 'src', 'components', 'DiagnosticsCard.tsx');
  assert.match(card, /buildReport/);
  assert.match(card, /clipboard\.writeText/);
});
