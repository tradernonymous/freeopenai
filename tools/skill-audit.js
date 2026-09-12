// What the router actually does with the installed library.
//
// The library grew to 136 skills, three of which ride along on every Plan and
// Build turn, and until now nothing had checked *which* three. A router is not
// wrong in a way a unit test notices: it is wrong by answering "write a launch
// email" with a debugging discipline, and the only way to see that is to run
// ordinary requests through it and look.
//
// This is the same code the test suite asserts on, so the corpus is the record
// of what the router is expected to do rather than a description of it:
//
//   node tools/skill-audit.js                    # against the committed snapshot
//   node tools/skill-audit.js live.json          # against a fresh /api/skills dump
//
// The snapshot (test/fixtures/skill-catalogue.json) is what makes the suite
// network-free and deterministic; refresh it by writing a fresh catalogue there.

const fs = require('node:fs');
const path = require('node:path');
const { pickSkills, skillTriggerScore, skillTokens } = require('../chatlib.js');

const SNAPSHOT = path.join(__dirname, '..', 'test', 'fixtures', 'skill-catalogue.json');

// Which field each library is for. A source with no entry is treated as
// general-purpose and is never counted against a request -- anthropics/skills
// really does mix design, documents and MCP tooling, so pretending it is one
// thing would produce false alarms about it.
const SOURCE_FIELD = {
  'mattpocock/skills': 'engineering',
  'DietrichGebert/ponytail': 'engineering',
  'obra/superpowers': 'engineering',
  'JuliusBrussee/caveman': 'writing',
  'blader/humanizer': 'writing',
  'petergyang/no-ai-slop': 'writing',
  'coreyhaines31/marketingskills': 'marketing',
  'cathrynlavery/diagram-design': 'diagrams',
  'tt-a1i/archify': 'diagrams',
  'ayghri/i-have-adhd': 'style',
};

// method-field skills are about how to work, not what the work is, so they are
// welcome on any request: refusing to let a debugging discipline help with a
// debugging request would be the opposite mistake.
const METHOD_FIELDS = new Set(['engineering', 'style']);

// Ordinary requests, of the kind typed into a chat app, with what the answer
// must not be. `forbid` names *fields* -- a marketing request answered by a
// debugging discipline is the failure this exists to catch.
const CORPUS = [
  { request: 'fix the failing test in my node project', mode: 'build', forbid: ['marketing', 'diagrams', 'writing'] },
  { request: 'refactor this module so it is simpler and smaller', mode: 'build', forbid: ['marketing', 'diagrams'] },
  { request: 'why does this function return undefined when the array is empty', mode: 'build', forbid: ['marketing', 'diagrams'] },
  { request: 'add a test for the retry logic before changing it', mode: 'build', forbid: ['marketing', 'diagrams'] },
  { request: 'review my branch against main and tell me what is wrong', mode: 'plan', forbid: ['marketing', 'diagrams'] },
  { request: 'the deploy keeps timing out, debug it', mode: 'build', forbid: ['marketing', 'diagrams'] },
  { request: 'write a launch email for our new pricing page', mode: 'build', forbid: ['engineering', 'diagrams'] },
  { request: 'our ai seo is weak, how do we get cited by chatgpt', mode: 'build', forbid: ['engineering', 'diagrams'] },
  { request: 'draft three ad variations for the spring sale', mode: 'build', forbid: ['engineering', 'diagrams'] },
  { request: 'set up an ab test for the signup button colour', mode: 'build', forbid: ['engineering', 'diagrams'] },
  { request: 'rewrite this paragraph so it does not sound like ai wrote it', mode: 'build', forbid: ['marketing', 'diagrams'] },
  { request: 'make this description half as long without losing the point', mode: 'build', forbid: ['marketing', 'diagrams'] },
  { request: 'tighten up this readme, it rambles', mode: 'build', forbid: ['marketing', 'diagrams'] },
  { request: 'draw a diagram of how our auth flow works', mode: 'build', forbid: ['marketing', 'writing'] },
  { request: 'turn this mermaid diagram into something presentable', mode: 'build', forbid: ['marketing'] },
  { request: 'what is the weather in Lisbon tomorrow', mode: 'build', forbid: ['marketing', 'diagrams', 'writing', 'engineering'] },
  { request: 'who won the world cup in 2014', mode: 'build', forbid: ['marketing', 'diagrams', 'writing', 'engineering'] },
  { request: 'thanks, that worked', mode: 'build', forbid: ['marketing', 'diagrams', 'writing', 'engineering'] },
  { request: 'translate this sentence into German', mode: 'build', forbid: ['marketing', 'diagrams', 'engineering'] },
  { request: 'summarise the attached meeting notes for my manager', mode: 'build', forbid: ['marketing', 'diagrams', 'engineering'] },
];

function loadCatalogue(file) {
  const target = file || SNAPSHOT;
  const rows = JSON.parse(fs.readFileSync(target, 'utf8'));
  return Array.isArray(rows) ? rows : [];
}

// One request through the shipped router, with each pick's score and field.
function auditRequest(entry, catalogue) {
  const picked = pickSkills(entry.request, entry.mode, catalogue);
  const scored = picked.map((s) => ({
    name: s.name,
    source: s.source,
    field: SOURCE_FIELD[s.source] || 'general',
    score: skillTriggerScore(entry.request, s),
  }));
  const violations = scored.filter((pick) => {
    const field = SOURCE_FIELD[pick.source];
    return field && entry.forbid.includes(field) && !METHOD_FIELDS.has(field);
  });
  return { ...entry, picked: scored, violations };
}

function audit(catalogue, corpus = CORPUS) {
  const results = corpus.map((entry) => auditRequest(entry, catalogue));
  return {
    results,
    violations: results.flatMap((r) => r.violations.map((v) => ({ request: r.request, ...v }))),
    answered: results.filter((r) => r.picked.length).length,
  };
}

// A quick look at which tokens a request is actually scored on: the stop list is
// the difference between a router and a keyword soup, and this is how a gap in
// it is found rather than guessed at.
function explain(request, catalogue, mode = 'build') {
  return {
    tokens: skillTokens(request),
    picked: pickSkills(request, mode, catalogue).map((s) => ({
      name: s.name,
      source: s.source,
      score: skillTriggerScore(request, s),
      shared: [...new Set(skillTokens(`${s.name} ${s.description}`).filter((t) => skillTokens(request).includes(t)))],
    })),
  };
}

module.exports = { CORPUS, SOURCE_FIELD, METHOD_FIELDS, audit, auditRequest, explain, loadCatalogue };

if (require.main === module) {
  const catalogue = loadCatalogue(process.argv[2]);
  const report = audit(catalogue);
  console.log(`library: ${catalogue.length} skills · requests: ${report.results.length} · answered: ${report.answered}\n`);
  for (const row of report.results) {
    const picks = row.picked.length
      ? row.picked.map((p) => `${p.name}(${p.field},${p.score})`).join(', ')
      : '— nothing —';
    console.log(`[${row.mode}] ${row.request}\n    ${picks}`);
  }
  console.log(`\nviolations: ${report.violations.length}`);
  for (const v of report.violations) console.log(`  ${v.request}\n    -> ${v.name} (${v.field})`);
  console.log('\nexplain one request: node -e "console.log(JSON.stringify(require(\'./tools/skill-audit.js\').explain(process.argv[1], require(\'./tools/skill-audit.js\').loadCatalogue()), null, 2))" "your request here"');
}
