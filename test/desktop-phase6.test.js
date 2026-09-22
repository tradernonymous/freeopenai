// Phase 6: parity and evals -- reasoning shown and kept out of history, HTML
// blocks previewed or sent to Design, document attachments, Compare, memory
// and share from chat, and an Evals panel whose scoring is tested here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const evals = require('../desktop/src/evals.js');

// ---- evals ---------------------------------------------------------------------

test('every built-in task passes its own right answer and fails a wrong one', () => {
  const right = {
    arith: '391',
    'json-object': '{"name":"Ada","age":36}',
    'json-array': '["red","green","blue"]',
    'exact-list': '2, 3, 5, 7, 11',
    'three-words': 'vast blue restless',
    extract: 'Lisbon',
    'bat-ball': '5',
    'tool-args': '{"query":"weather in Oslo"}',
  };
  assert.deepEqual(evals.TASKS.map((t) => t.id).sort(), Object.keys(right).sort());
  for (const task of evals.TASKS) {
    assert.equal(evals.score(task, right[task.id]).pass, true, `${task.id} passes its answer`);
    assert.equal(evals.score(task, 'I am not sure.').pass, false, `${task.id} fails a non-answer`);
    assert.ok(task.prompt.length > 20 && task.skill, `${task.id} says what it tests`);
  }
});

test('answers are read the way models actually send them', () => {
  const arith = evals.byId('arith');
  assert.equal(evals.score(arith, '<think>17*23 = 391</think>391').pass, true, 'reasoning is ignored');
  assert.equal(evals.score(evals.byId('json-object'), '```json\n{"name": "Ada", "age": 36}\n```').pass, true, 'a fence is tolerated');
  assert.equal(evals.score(evals.byId('json-object'), 'Sure! {"name":"Ada","age":"36"}').pass, false, 'a string age is wrong');
  assert.equal(evals.score(evals.byId('bat-ball'), '10').pass, false, 'the intuitive answer fails');
  assert.equal(evals.score(evals.byId('three-words'), 'Vast blue sea').pass, false, 'capitals fail');
  assert.equal(evals.score(evals.byId('tool-args'), '{"query":"Oslo","units":"c"}').pass, false, 'extra arguments fail');
});

test('results summarise per model, best pass rate then fastest, and export as CSV', () => {
  const a = { label: 'A' };
  const b = { label: 'B' };
  const rows = [
    { target: a, taskId: 'arith', pass: true, ms: 1000, chars: 3 },
    { target: a, taskId: 'extract', pass: false, ms: 3000, chars: 40, note: 'expected Lisbon alone' },
    { target: b, taskId: 'arith', pass: true, ms: 200, chars: 3 },
    { target: b, taskId: 'extract', pass: true, ms: 400, chars: 6 },
  ];
  const summary = evals.summarize(rows);
  assert.equal(summary[0].target.label, 'B');
  assert.equal(summary[0].rate, 1);
  assert.equal(summary[1].passed, 1);
  assert.equal(summary[1].avgMs, 2000);
  const csv = evals.toCsv(rows);
  assert.match(csv, /^model,task,pass,ms,chars,note\n/);
  assert.match(csv, /A,extract,0,3000,40,expected Lisbon alone/);
});

test('the Evals screen runs through the shared stream, with a timeout per task', () => {
  const screen = read('desktop', 'src', 'screens', 'EvalsScreen.tsx');
  assert.match(screen, /collectReply\(target/);
  assert.match(screen, /evals\.score\(task, reply\.text\)/);
  assert.match(screen, /TIMEOUT_MS/);
  const sidebar = read('desktop', 'src', 'Sidebar.tsx');
  assert.match(sidebar, /\{ id: 'evals', label: 'Evals', parent: 'library' \}/);
});

// ---- reasoning -------------------------------------------------------------------

test('reasoning streamed apart from the answer is kept, folded, and never sent back', () => {
  const api = read('desktop', 'src', 'api.ts');
  assert.match(api, /delta\.reasoning_content/);
  assert.match(api, /'<think>'/);
  assert.match(api, /closeThinking\(\)/);
  const md = read('desktop', 'src', 'markdown.ts');
  assert.match(md, /<details class="thinking"/);
  assert.match(md, /Thinking…/, 'an unfinished thought is shown open while it streams');
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /m\.role === 'assistant' \? String\(m\.content \|\| ''\)\.replace\(\/<think>/, 'history is sent without reasoning');
  assert.match(chat, /reasoning_effort: active\.reasoning/);
  const server = read('server.js');
  assert.match(server, /\['low', 'medium', 'high'\]\.includes\(body\.reasoning_effort\)/, 'forwarded only when set');
});

// ---- chat parity -------------------------------------------------------------------

test('HTML code blocks preview in a sandbox or go to Design', () => {
  const md = read('desktop', 'src', 'markdown.ts');
  assert.match(md, /\/\^\(html\|svg\|xml\)\$\/i\.test\(lang\)/);
  assert.match(md, /code-preview/);
  assert.match(md, /code-design/);
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /frame\.setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.ok(!/allow-same-origin/.test(chat), 'a preview never shares the app origin');
});

test('documents attach as text with a token estimate; pictures attach for vision models', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  for (const call of ['pdf.extractPdfText', 'office.extractDocxText', 'office.extractPptxText', 'office.extractXlsxSheets']) {
    assert.ok(chat.includes(call), `${call} is used`);
  }
  assert.match(chat, /addImage\(await imageFileToDataUrl\(file\)\)/);
  assert.match(chat, /tokens/);
  const composer = read('desktop', 'src', 'components', 'Composer.tsx');
  assert.match(composer, /onAttach && \(/, 'the paperclip is in the composer');
});

test('Compare, memory and share are one command away', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /<CompareDrawer/);
  assert.match(chat, /api\.raw\('\/api\/memory', \{ method: 'PUT'/);
  assert.match(chat, /api\.raw\('\/api\/share', \{ method: 'PUT'/);
  assert.match(chat, /id: 'compare', label: 'Compare'/, 'Compare is on the reply ring too');
  const drawer = read('desktop', 'src', 'components', 'CompareDrawer.tsx');
  assert.match(drawer, /streamAny\(col\.target/);
  assert.match(drawer, /Use this answer/);
  const stream = read('desktop', 'src', 'stream-any.ts');
  assert.match(stream, /isSavedProvider\(target\.provider\)/, 'local models compare too');
});
