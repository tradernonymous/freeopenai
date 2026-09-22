// Research mode (/research): desktop/src/research.js, and how ChatScreen runs it.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const research = require('../desktop/src/research.js');
const composer = require('../desktop/src/composer.js');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

// ---- plan --------------------------------------------------------------------

test('the plan asks for 3-5 queries as JSON', () => {
  const msgs = research.planMessages('How do heat pumps work?', new Date(2026, 8, 22));
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /JSON only/);
  assert.match(msgs[0].content, /3 to 5/);
  assert.match(msgs[0].content, /2026-09-22/);
  assert.equal(msgs[1].content, 'How do heat pumps work?');
});

test('queries are parsed from JSON in a fence, in prose, or as a bare array', () => {
  const fenced = 'Sure! Here you go:\n```json\n{"queries": ["heat pump COP", "heat pump cold climate", "heat pump COP"]}\n```\nGood luck.';
  assert.deepEqual(research.parseQueries(fenced, 'q'), ['heat pump COP', 'heat pump cold climate'], 'duplicates dropped');
  const prose = 'I would search for {"queries":["a {b}", "c \\"d\\""]} and then read.';
  assert.deepEqual(research.parseQueries(prose, 'q'), ['a {b}', 'c "d"']);
  assert.deepEqual(research.parseQueries('["one","two"]', 'q'), ['one', 'two']);
  const many = JSON.stringify({ queries: ['1', '2', '3', '4', '5', '6', '7'] });
  assert.equal(research.parseQueries(many, 'q').length, research.MAX_QUERIES, 'capped at 5');
  assert.deepEqual(research.parseQueries('<think>{"queries":["no"]}</think>{"queries":["yes"]}', 'q'), ['yes'], 'reasoning is ignored');
});

test('a plan with no JSON falls back to a list, then to the question', () => {
  assert.deepEqual(research.parseQueries('1. first query\n2. "second query"', 'q'), ['first query', 'second query']);
  assert.deepEqual(research.parseQueries('I cannot help with that.', 'the question'), ['the question']);
});

// ---- sources -----------------------------------------------------------------

test('web_search text is parsed back into rows', () => {
  // The exact shape tool-run.ts writes: `${title}\n${url}\n${snippet}\n` joined by '\n'.
  const out = ['Heat pump - Wikipedia\nhttps://en.wikipedia.org/wiki/Heat_pump\nA heat pump moves heat.\n',
    'https://example.com/no-title\nhttps://example.com/no-title\n\n'].join('\n');
  const rows = research.parseSearchResults(out);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { title: 'Heat pump - Wikipedia', url: 'https://en.wikipedia.org/wiki/Heat_pump', snippet: 'A heat pump moves heat.' });
  assert.equal(rows[1].title, 'https://example.com/no-title');
  assert.equal(rows[1].snippet, '');
  assert.deepEqual(research.parseSearchResults('No results for "x".'), []);
  assert.deepEqual(research.parseSearchResults('Error: search failed'), []);
});

test('sources are deduped by URL and numbered 1..n across queries', () => {
  let sources = research.addSources([], [
    { title: 'A', url: 'https://www.example.com/a/?utm_source=x#top', snippet: 'a' },
    { title: 'B', url: 'https://example.com/b', snippet: 'b' },
    { title: 'A again', url: 'https://example.com/a', snippet: 'dup' },
    { title: 'Bad', url: 'javascript:alert(1)', snippet: '' },
  ], 0);
  sources = research.addSources(sources, [
    { title: 'B dup', url: 'http://EXAMPLE.com/b/', snippet: '' },
    { title: 'C', url: 'https://other.org/c', snippet: 'c' },
  ], 1);
  assert.deepEqual(sources.map((s) => [s.n, s.title]), [[1, 'A'], [2, 'B'], [3, 'C']]);
  assert.equal(sources[2].query, 1);
  assert.equal(sources[2].rank, 0);
  assert.equal(research.normalizeUrl('ftp://x.org'), '');
});

test('pages are picked round-robin by rank, and clipped', () => {
  let sources = research.addSources([], [{ title: 'a1', url: 'https://a.org/1' }, { title: 'a2', url: 'https://a.org/2' }], 0);
  sources = research.addSources(sources, [{ title: 'b1', url: 'https://b.org/1' }], 1);
  assert.deepEqual(research.pickPages(sources, 2).map((s) => s.title), ['a1', 'b1']);
  assert.equal(research.clipPage('x'.repeat(10000)).length, research.PAGE_CHARS);
  assert.equal(research.clipPage('Error: 404'), '');
  const prompt = research.sourcesForPrompt(sources, { 1: 'y'.repeat(50) }, 20);
  assert.match(prompt, /^\[1\] a1\nURL: https:\/\/a\.org\/1/);
  assert.match(prompt, /Excerpt: y{20}…/, 'the total cap holds');
});

test('the synthesis prompt says: only the sources, cite [n], say when they disagree or are missing', () => {
  const sources = research.addSources([], [{ title: 'A', url: 'https://a.org', snippet: 's' }], 0);
  const [system, user] = research.synthesisMessages('Q?', sources, {}, Date.now());
  assert.match(system.content, /ONLY the numbered sources/);
  assert.match(system.content, /\[2\]/);
  assert.match(system.content, /disagree/);
  assert.match(system.content, /do not cover/);
  assert.match(user.content, /Question: Q\?/);
  assert.match(user.content, /\[1\] A/);
  const none = research.noSourcesMessages('Q?');
  assert.match(none[0].content, /Do NOT write citations/);
});

// ---- citations ---------------------------------------------------------------

test('the checker strips unknown [n], keeps known ones, and flags uncited paragraphs', () => {
  const answer = [
    'Heat pumps move heat rather than make it [1]. They reach a COP of three or more in mild weather [2][7].',
    '',
    'This paragraph makes a long claim about efficiency in the cold with no citation at all, which is flagged.',
    '',
    'Short line.',
    '',
    '## Details',
    '',
    'Grouped citations work too, and bad ones in a group go [1, 9].',
    '',
    '```',
    'code [9] stays as it is',
    '```',
  ].join('\n');
  const check = research.checkCitations(answer, 2);
  assert.deepEqual(check.cited, [1, 2]);
  assert.deepEqual(check.unknown, [7, 9]);
  assert.match(check.text, /mild weather \[2\]\./);
  assert.doesNotMatch(check.text, /\[7\]/);
  assert.match(check.text, /go \[1\]\./);
  assert.match(check.text, /code \[9\] stays/, 'fenced code is left alone');
  assert.equal(check.uncited.length, 1);
  assert.match(check.uncited[0].text, /^This paragraph/);
});

test('with no sources every citation is stripped', () => {
  const check = research.checkCitations('Made up [1] and [2].', 0);
  assert.equal(check.text, 'Made up and.');
  assert.deepEqual(check.unknown, [1, 2]);
});

test('citations become links, and rendered numeric links become superscripts', () => {
  const sources = research.addSources([], [{ title: 'A', url: 'https://a.org/x_(y)' }, { title: 'B', url: 'https://b.org' }], 0);
  const linked = research.linkCitations('One [1]. Two [1, 2]. Link [a](https://z.org). Unknown [5].', sources);
  assert.match(linked, /One \[1\]\(https:\/\/a\.org\/x_%28y%29\)\./);
  assert.match(linked, /Two \[1\]\(https:\/\/a\.org\/x_%28y%29\)\[2\]\(https:\/\/b\.org\)\./);
  assert.match(linked, /Link \[a\]\(https:\/\/z\.org\)/);
  assert.match(linked, /Unknown \[5\]\./);
  const html = research.superscriptCitations('<p>x <a href="https://b.org" target="_blank" rel="noreferrer">2</a> <a href="https://z.org" target="_blank" rel="noreferrer">word</a></p>');
  assert.match(html, /<sup class="cite"><a href="https:\/\/b\.org" target="_blank" rel="noreferrer" title="Source 2">2<\/a><\/sup>/);
  assert.match(html, />word<\/a>/, 'word links stay links');
});

// ---- knowledge graph ---------------------------------------------------------

test('the graph parser caps at 9 nodes and drops edges to missing nodes', () => {
  const nodes = Array.from({ length: 12 }, (_, k) => ({ id: `n${k}`, label: `Topic ${k}` }));
  const edges = [
    { from: 'n0', to: 'n1', label: 'causes' },
    { from: 'n0', to: 'n11', label: 'to a trimmed node' },
    { from: 'n2', to: 'ghost' },
    { from: 'n0', to: 'n1', label: 'duplicate' },
    { from: 'n3', to: 'n3' },
    { from: 'Topic 4', to: 'n5', label: 'by label' },
  ];
  const graph = research.parseGraph('Here:\n```json\n' + JSON.stringify({ nodes, edges }) + '\n```');
  assert.equal(graph.nodes.length, research.MAX_GRAPH_NODES);
  assert.equal(graph.trimmed, true);
  assert.match(graph.message, /12 topics/);
  assert.deepEqual(graph.edges, [{ from: 'n0', to: 'n1', label: 'causes' }, { from: 'n4', to: 'n5', label: 'by label' }]);
  assert.equal(research.parseGraph('no graph here').nodes.length, 0);
  const [system] = research.graphMessages('Q', 'Answer [1].');
  assert.match(system.content, /At most 9 nodes/);
});

test('the parsed graph fits diagram-layout as it is', () => {
  const layout = require('../desktop/src/design/diagram-layout.js');
  const graph = research.parseGraph(JSON.stringify({ nodes: [{ id: 'a', label: 'A <b>' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: 'x' }] }));
  const clean = layout.normalize(graph);
  assert.equal(clean.nodes.length, 2);
  assert.equal(clean.edges.length, 1);
  const svg = layout.toSvg(clean, { title: 'Knowledge graph' });
  assert.match(svg, /^<svg/);
  assert.match(svg, /A &lt;b&gt;/, 'labels are escaped');
});

// ---- export ------------------------------------------------------------------

test('Markdown export: title, date, answer, numbered Sources with links', () => {
  const sources = research.addSources([], [{ title: 'Heat [pumps]', url: 'https://a.org/p' }, { title: 'B', url: 'https://b.org' }], 0);
  const md = research.exportMarkdown({ question: 'How do heat pumps work?', answer: 'They move heat [1][2].\n', sources, date: new Date(2026, 8, 22, 12), model: 'qwen3' });
  assert.equal(md, [
    '# How do heat pumps work?',
    '',
    '_Researched 2026-09-22 with qwen3_',
    '',
    'They move heat [1][2].',
    '',
    '## Sources',
    '',
    '1. [Heat \\[pumps\\]](https://a.org/p)',
    '2. [B](https://b.org)',
    '',
  ].join('\n'));
  const none = research.exportMarkdown({ question: 'Q', answer: 'A', sources: [], date: new Date(2026, 0, 2) });
  assert.match(none, /_Researched 2026-01-02_/);
  assert.match(none, /> No sources:/);
  assert.doesNotMatch(none, /## Sources/);
});

test('the print page escapes what it is given and prints itself only when asked', () => {
  const sources = research.addSources([], [{ title: '<script>x</script>', url: 'https://a.org/?a=1&b=2' }], 0);
  const html = research.printHtml({ question: 'Q <i>', bodyHtml: '<p>ok</p>', sources, date: new Date(2026, 8, 22), autoPrint: true });
  assert.match(html, /<title>Q &lt;i&gt;<\/title>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/a\.org\/\?a=1&amp;b=2"/);
  assert.match(html, /<main><p>ok<\/main>|<main><p>ok<\/p><\/main>/);
  assert.match(html, /window\.print\(\)/);
  assert.doesNotMatch(research.printHtml({ question: 'Q', bodyHtml: '', sources: [] }), /window\.print/);
});

test('progress reads Planning -> Searching n queries -> Reading sources -> Writing', () => {
  assert.match(research.progressText('plan'), /\*\*Planning…\*\* → Searching 0 queries/);
  const reading = research.progressText('read', { queries: 4, sources: 12, pages: 6 });
  assert.match(reading, /Planning ✓ → Searching 4 queries ✓ → \*\*Reading 6 of 12 sources…\*\* → Writing/);
  assert.doesNotMatch(research.progressText('done', { queries: 1 }), /…/);
});

// ---- wiring ------------------------------------------------------------------

test('/research is one slash command, and ChatScreen runs it through the existing search tools', () => {
  const row = composer.SLASH.find((c) => c.id === 'research');
  assert.ok(row && row.hint, '/research is in the menu with a hint');
  assert.equal(composer.parseSlash('/research why is the sky blue').arg, 'why is the sky blue');
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /case 'research': clear\(\); runResearch\(arg\); return;/);
  assert.match(chat, /runTool\(`research-search-\$\{k\}`, 'web_search', \{ query \}\)/, 'searches go through web_search');
  assert.match(chat, /runTool\(`research-read-\$\{src\.n\}`, 'web_fetch', \{ url: src\.url \}\)/, 'pages go through web_fetch');
  assert.match(chat, /await executeTool\(\{ id, name, arguments: JSON\.stringify\(args\) \}, args, \{ localRoot: '' \}\)/, 'the executeTool path, no new backend');
  assert.doesNotMatch(chat, /\/api\/llm\/websearch/, 'no search route of its own');
  assert.match(chat, /sources\?: ResearchSource\[\];/, 'sources are kept on the message');
  assert.match(chat, /research\.superscriptCitations\(renderMarkdown\(research\.linkCitations\(msg\.content, msg\.sources\)\)\)/);
  assert.match(chat, /Knowledge graph/);
  assert.match(chat, /Export Markdown/);
  assert.match(chat, /Export PDF/);
  // NEURA-041: no search -> say so, and answer without sources.
  assert.match(chat, /research\.noSourcesMessages\(question, date\)/);
  assert.match(chat, /noSources: true/);
});

test('web_search and web_fetch are read-only: they never ask', () => {
  const tools = require('../desktop/src/tools.js');
  assert.equal(tools.ASKS.web_search, undefined);
  assert.equal(tools.ASKS.web_fetch, undefined);
});

test('index.css has one Research block', () => {
  const css = read('desktop', 'src', 'index.css');
  assert.equal(css.split('/* ---- Research ---- */').length, 2);
});
