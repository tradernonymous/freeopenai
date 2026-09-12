// The skill router, checked against the real library instead of a hand-made
// catalogue.
//
// A router is not wrong in a way a unit test notices. Its unit tests pass
// whatever it does -- the bug is that it answers a JavaScript question with an
// SEO skill, and seeing that requires running ordinary requests through the
// actual 136 skills that ship. `tools/skill-audit.js` is that run; this file
// asserts on it, so the corpus is the record of what the router does rather
// than a description of what it was meant to do.
//
// The snapshot (test/fixtures/skill-catalogue.json) is a real /api/skills
// response. It keeps the suite network-free and makes a router change show up
// as a diff in behaviour rather than as a silent drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSkills, skillTriggerScore, skillTokens } = require('../chatlib.js');
const { audit, loadCatalogue } = require('../tools/skill-audit.js');

const CATALOG = loadCatalogue();
const REPORT = audit(CATALOG);

// Requests whose answer must never come from another field of work. Each of
// these was a real failure before the stop list and the minimum-hit rule: the
// word "why" in a JavaScript question reached every SEO skill in the library,
// because their descriptions all say "Use when the user asks why...".
const CROSSED_WIRES = [
  { request: 'why does this function return undefined when the array is empty', mode: 'build', forbid: ['marketing', 'diagrams', 'writing'] },
  { request: 'who won the world cup in 2014', mode: 'build', forbid: ['marketing', 'diagrams', 'writing', 'engineering'] },
  { request: 'what is the weather in Lisbon tomorrow', mode: 'build', forbid: ['marketing', 'diagrams', 'writing', 'engineering'] },
  { request: 'summarise the attached meeting notes for my manager', mode: 'build', forbid: ['marketing', 'diagrams', 'engineering'] },
  { request: 'fix the failing test in my node project', mode: 'build', forbid: ['marketing', 'diagrams', 'writing'] },
];

// Requests that are not work at all. Nothing should fire: an app that hands a
// methodology to "thanks, that worked" is spending prompt budget to announce
// that it was not paying attention.
const NOT_REQUESTS = ['thanks, that worked', 'translate this sentence into German', 'make this description half as long without losing the point', 'tighten up this readme, it rambles'];

// The remaining wrong picks, measured. Every one is the same shape -- a single
// word shared with a skill that the library also uses generically ("test" is in
// fifteen descriptions, "ai" in fourteen), and lexical overlap cannot tell a
// unit test from an A/B test. They are listed rather than asserted away so the
// number can only go down: a fix that removes one has to edit this list, and a
// change that adds one fails the ratchet below.
const KNOWN_LIMITS = ['ab-testing', 'ai-seo', 'sms'];

const fieldOf = (name) => {
  const row = CATALOG.find((s) => s.name === name);
  return row ? row.source : '';
};

test('the snapshot is the real library, not a stub', () => {
  assert.ok(CATALOG.length > 100, 'catalogue has the whole library: ' + CATALOG.length);
  assert.ok(CATALOG.every((s) => s.name && s.description), 'every row is scorable');
  assert.ok(CATALOG.some((s) => s.source === 'coreyhaines31/marketingskills'), 'the marketing library is in it');
});

test('a request is never answered from an unrelated field', () => {
  for (const entry of CROSSED_WIRES) {
    const picked = pickSkills(entry.request, entry.mode, CATALOG).map((s) => `${s.name} (${fieldOf(s.name)})`);
    const wrong = picked.filter((p) => entry.forbid.some((f) => p.includes(`(${f})`)));
    assert.deepEqual(wrong, [], `"${entry.request}" got ${picked.join(', ')}`);
  }
});

test('a question that is not work picks nothing at all', () => {
  for (const request of NOT_REQUESTS) {
    const picked = pickSkills(request, 'build', CATALOG);
    assert.deepEqual(picked, [], `"${request}" should not fire a skill, got ${picked.map((s) => s.name).join(', ')}`);
  }
});

test('the build core is seeded only once something real has matched', () => {
  // "Set up a retry helper" names real work, so the methodology comes along.
  const real = pickSkills('add a retry helper to the fetch module and write tests for it', 'build', CATALOG).map((s) => s.name);
  assert.ok(real.includes('test-driven-development'), 'methodology rides along with recognised work: ' + real.join(', '));
  // A question that matched nothing gets no methodology either: nothing was
  // recognised, so there is no work for a discipline to discipline.
  assert.ok(!pickSkills('what is the weather in Lisbon tomorrow', 'build', CATALOG).length);
});

test('a specific request reaches the specific skill, not a nearby general one', () => {
  const cases = [
    ['draft three ad variations for the spring sale', 'ad-creative'],
    ['set up an ab test for the signup button colour', 'ab-testing'],
    ['draw a diagram of how our auth flow works', 'diagram-design'],
    ['turn this mermaid diagram into something presentable', 'diagram-design'],
    ['rewrite this paragraph so it does not sound like ai wrote it', 'no-ai-slop'],
    ['our ai seo is weak, how do we get cited by chatgpt', 'ai-seo'],
    ['write a launch email for our new pricing page', 'pricing'],
    ['the deploy keeps timing out, debug it', 'systematic-debugging'],
    ['review my branch against main and tell me what is wrong', 'code-review'],
  ];
  for (const [request, expected] of cases) {
    const names = pickSkills(request, 'build', CATALOG).map((s) => s.name);
    assert.equal(names[0], expected, `"${request}" → ${names.join(', ')}`);
  }
});

test('the wrong picks are down to the known few, and no further', () => {
  const faults = REPORT.violations.map((v) => v.name).sort();
  // A ratchet: this is the measured floor, not a target. It was thirteen
  // before the stop list was completed -- three SEO skills answered "why does
  // this function return undefined", and "who won the world cup in 2014" was
  // answered by co-marketing, competitor-profiling and paywalls.
  assert.deepEqual([...new Set(faults)].sort(), [...KNOWN_LIMITS].sort(), 'violations: ' + JSON.stringify(REPORT.violations));
});

test('the field check itself would notice a regression', () => {
  // If the audit stopped detecting anything, the ratchet above would pass by
  // being blind, so pin that it still fires on a deliberately wrong answer: a
  // marketing skill whose description is rewritten to share words with an
  // engineering question.
  const sabotage = [{ source: 'coreyhaines31/marketingskills', name: 'seo-audit', description: 'when the user wants to function array empty return undefined' }];
  const forced = audit(sabotage, [
    { request: 'why does this function return undefined when the array is empty', mode: 'build', forbid: ['marketing'] },
  ]);
  assert.deepEqual(forced.violations.map((v) => v.name), ['seo-audit'], 'the audit still detects a crossed wire');
});

test('the same request always picks the same skills, whatever order the library is in', () => {
  const request = 'draft three ad variations for the spring sale';
  const forwards = pickSkills(request, 'build', CATALOG).map((s) => s.name);
  const backwards = pickSkills(request, 'build', [...CATALOG].reverse()).map((s) => s.name);
  // Before the tie-break existed, the winner of an equal score was whichever
  // library happened to be listed first, so the same request answered
  // differently depending on fetch order.
  assert.deepEqual(backwards, forwards, 'stable under a reordered catalogue');
  assert.deepEqual(pickSkills(request, 'build', CATALOG).map((s) => s.name), forwards);
});

test('one shared word is not a match, unless it is the skill\'s own name', () => {
  const oneWord = [{ source: 'x', name: 'alpha', description: 'when the user wants to test something' }];
  // "test" is in the description and in the request: one shared word, no name
  // hit, so it stays out.
  assert.deepEqual(pickSkills('run the test suite', 'build', oneWord), []);
  // The same word as the skill's *name* is a match.
  const named = [{ source: 'x', name: 'tests', description: 'when the user wants to verify behaviour' }];
  assert.deepEqual(pickSkills('run the test suite', 'build', named).map((s) => s.name), ['tests']);
});

test('the stop list is what keeps a question from reaching every library at once', () => {
  // These words appear in almost every "Use when..." description in the
  // library, so a request containing one used to score against all of them.
  for (const word of ['why', 'what', 'who', 'how', 'when', 'you', 'your', 'my', 'the']) {
    assert.deepEqual(skillTokens(word), [], `"${word}" must not be a trigger word`);
  }
  // Two-letter words are kept, because they are the names of real things.
  assert.deepEqual(skillTokens('ad copy'), ['ad', 'copy']);
  assert.deepEqual(skillTokens('ui and js'), ['ui', 'js']);
});

test('the tail of a sentence still counts', () => {
  // The tokenizer used to keep the full stop, so the last word of every
  // description -- the word a skill is usually *about* -- could never match.
  const skill = { source: 'x', name: 'zeta', description: 'Use when the user asks for abstractions' };
  assert.ok(skillTriggerScore('explain these abstractions', skill) > 0);
  // The trailing dot goes, and what is left is stemmed like any other word --
  // so the sentence's last word meets the same word in the middle of one.
  assert.ok(skillTokens('abstractions.').includes('abstraction'));
  assert.deepEqual(skillTokens('abstractions.'), skillTokens('abstractions'));
  // A dot inside a version is part of the token, not a sentence end: the
  // tokenizer splits on the hyphen, so "gpt-5.4" is "gpt" and "5.4" -- and
  // "5.4" must stay one token rather than becoming "5" and "4".
  assert.deepEqual(skillTokens('use gpt-5.4 here'), ['gpt', '5.4']);
});

test('plan mode still refuses capability skills and takes process ones', () => {
  const picked = pickSkills('we need a plan for the document import feature', 'plan', CATALOG).map((s) => s.name);
  assert.ok(picked.length > 0, 'plan mode found a planning skill');
  assert.ok(!picked.includes('docx'), 'a document capability skill is held back: ' + picked.join(', '));
  assert.deepEqual(pickSkills('write me a plan', 'chat', CATALOG), [], 'chat mode never auto-picks');
});
