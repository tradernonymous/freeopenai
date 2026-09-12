const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODES,
  DEFAULT_MODE,
  isValidMode,
  modePrompt,
  SKILL_SOURCES,
  BUILD_CORE_SKILLS,
  skillsAllowedForMode,
  skillTriggerScore,
  pickSkills,
  renderSkillsPrompt,
  USE_SKILL_TOOL,
  isUseSkillTool,
  parseSkillFrontmatter,
} = require('../chatlib.js');

const CATALOG = [
  { source: 'anthropics/skills', name: 'frontend-design', description: 'Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and layout.' },
  { source: 'anthropics/skills', name: 'docx', description: 'Comprehensive document creation, editing, and analysis with document creation, new content creation, document editing, and handling of docx files.' },
  { source: 'anthropics/skills', name: 'pdf', description: 'PDF processing: extract text and tables, create new PDFs, merge and split documents, and handle forms.' },
  { source: 'anthropics/skills', name: 'mcp-builder', description: 'Guide for creating high-quality MCP servers that enable LLMs to discover external tools.' },
  { source: 'anthropics/skills', name: 'canvas-design', description: 'Beautiful visual art in .png and .pdf: posters, generative art, design principles, typography.' },
  { source: 'obra/superpowers', name: 'test-driven-development', description: 'Use when implementing any feature or bugfix, before writing implementation code' },
  { source: 'obra/superpowers', name: 'systematic-debugging', description: 'Use when debugging any issue, before proposing a fix: root cause over symptom patching' },
  { source: 'obra/superpowers', name: 'verification-before-completion', description: 'Use when about to claim work is complete: run the verification, never report untested success' },
  { source: 'obra/superpowers', name: 'writing-plans', description: 'Use when writing an implementation plan: turn vague requests into concrete steps with file paths' },
  { source: 'obra/superpowers', name: 'brainstorming', description: 'Use when starting any creative work: refine rough ideas into validated designs before implementation' },
  { source: 'JuliusBrussee/caveman', name: 'lean-build', description: 'Build feature work with high overbuilding risk. Use for new behavior, product slices, or integrations where repository reuse, strict scope, and an explicit stop condition matter.' },
  { source: 'JuliusBrussee/caveman', name: 'surgical-patch', description: 'Minimal targeted fixes: change only what the fix requires, keep the diff reviewable' },
];

test('modes exist with chat default', () => {
  assert.deepEqual(MODES.map((m) => m.id), ['chat', 'plan', 'build']);
  assert.equal(DEFAULT_MODE, 'chat');
  assert.ok(isValidMode('build'));
  assert.ok(!isValidMode('yolo'));
});

test('plan mode prompt forbids edits and demands a plan shape', () => {
  const prompt = modePrompt('plan');
  assert.match(prompt, /MODE: PLAN/);
  assert.match(prompt, /Do not write or commit code/);
  assert.match(prompt, /Build mode/);
});

test('build mode prompt enforces lean scope and verification', () => {
  const prompt = modePrompt('build');
  assert.match(prompt, /MODE: BUILD/);
  assert.match(prompt, /smallest change/);
  assert.match(prompt, /[Vv]erify/);
});

test('caveman is lite: only the curated five skills are picked from its repo', () => {
  const caveman = SKILL_SOURCES.find((s) => s.repo === 'JuliusBrussee/caveman');
  assert.ok(caveman, 'caveman source present');
  assert.ok(Array.isArray(caveman.pick), 'caveman is a lite pick, not the whole repo');
  assert.deepEqual([...caveman.pick].sort(), ['caveman', 'caveman-commit', 'lean-build', 'surgical-patch', 'verify-and-stop']);
  assert.equal(SKILL_SOURCES.find((s) => s.repo === 'anthropics/skills').pick, 'all');
  assert.equal(SKILL_SOURCES.find((s) => s.repo === 'obra/superpowers').pick, 'all');
});

test('skills are silent in chat, process-only in plan, everything in build', () => {
  assert.equal(skillsAllowedForMode('chat'), 'none');
  assert.equal(skillsAllowedForMode('plan'), 'process');
  assert.equal(skillsAllowedForMode('build'), 'all');
});

test('a TDD-ish build request auto-picks the core + matching skills, capped', () => {
  const picked = pickSkills('add a retry helper to the fetch module and write tests for it', 'build', CATALOG, 3);
  const names = picked.map((s) => s.name);
  assert.ok(names.includes('test-driven-development'), 'core skill seeded: ' + names.join(','));
  assert.ok(picked.length <= 3, 'cap respected');
});

test('a UI build request picks the capability skill over methodology', () => {
  const picked = pickSkills('redesign the dashboard sidebar with a distinctive new visual design', 'build', CATALOG, 3);
  const names = picked.map((s) => s.name);
  assert.ok(names.includes('frontend-design'), 'got: ' + names.join(','));
});

test('plan mode pulls planning skills but not library skills', () => {
  const picked = pickSkills('we need a plan for the document import feature', 'plan', CATALOG, 3);
  const names = picked.map((s) => s.name);
  assert.ok(names.includes('writing-plans'), 'planning skill matched: ' + names.join(','));
  assert.ok(!names.includes('frontend-design'), 'capability skill held back in plan mode');
  assert.ok(!names.includes('docx'), 'capability skill held back in plan mode');
});

test('chat mode never picks skills', () => {
  assert.deepEqual(pickSkills('write tests and a beautiful redesign plan for the pdf importer', 'chat', CATALOG), []);
});

test('a request matching nothing picks nothing, core included', () => {
  // The methodology core rides along with recognised work, not with silence.
  // Seeding it here once meant "thanks, that worked" arrived carrying
  // test-driven-development -- nothing had been recognised, so three
  // disciplines were handed over instead of none.
  assert.deepEqual(pickSkills('say hello', 'build', CATALOG, 3), []);
  // A recognised request still gets it, which is the half that must not change.
  const real = pickSkills('write tests for the importer', 'build', CATALOG, 3).map((s) => s.name);
  assert.ok(real.includes('test-driven-development'), 'core watches real work: ' + real.join(','));
});

test('core skills not present in the catalogue are skipped silently', () => {
  const tiny = CATALOG.filter((s) => !BUILD_CORE_SKILLS.includes(s.name));
  const picked = pickSkills('say hello', 'build', tiny, 3);
  assert.deepEqual(picked, []);
});

test('malformed catalogue rows are ignored', () => {
  const dirty = [...CATALOG, null, {}, { name: 'x' }, { description: 'no name' }];
  const picked = pickSkills('write tests for the importer', 'build', dirty, 5);
  assert.ok(picked.every((s) => s.name && s.description));
});

test('trigger scoring ignores stop words and short tokens', () => {
  // Name hits weigh 3x: "pdf" in the name triple-counts.
  assert.equal(skillTriggerScore('use the pdf thing', { name: 'pdf', description: 'the pdf skill' }), 4, 'name x3 + description x1');
  assert.equal(skillTriggerScore('', { name: 'pdf', description: 'anything' }), 0);
  // The name participates: "write tests" reaches test-driven-development
  // through its name even though its description never says "test".
  assert.ok(skillTriggerScore('write tests for the parser', { name: 'test-driven-development', description: 'Use when implementing any feature or bugfix, before writing implementation code' }) >= 3, 'name hit is the strong signal');
  // Filler-heavy descriptions cannot outscore real matches: stopped words
  // count 0, and a description-only "document" hit is weaker than a name hit.
  const docxScore = skillTriggerScore('add a retry helper to the fetch module and write tests for it', { name: 'docx', description: 'Comprehensive document creation, editing, and analysis with document creation, new content creation, document editing, and handling of docx files.' });
  const tddScore = skillTriggerScore('add a retry helper to the fetch module and write tests for it', { name: 'test-driven-development', description: 'Use when implementing any feature or bugfix, before writing implementation code' });
  assert.ok(tddScore > docxScore, 'name-weighted: tdd ' + tddScore + ' > docx ' + docxScore);
  // Light stemming: "debug" meets "debugging".
  assert.ok(skillTriggerScore('debug this crash', { name: 'systematic-debugging', description: 'Use when debugging any issue' }) >= 3);
});

test('renderSkillsPrompt bounds excerpts and credits the source', () => {
  const long = 'x'.repeat(5000);
  const out = renderSkillsPrompt([{ source: 'anthropics/skills', name: 'pdf', description: 'Handle PDFs.', body: long }]);
  assert.ok(out.includes('anthropics/skills'));
  assert.ok(out.length < 2500, 'excerpt is bounded');
  assert.match(out, /ACTIVE SKILLS/);
  assert.equal(renderSkillsPrompt([]), '');
});

test('use_skill tool exposes the OpenAI function shape and matcher', () => {
  assert.equal(USE_SKILL_TOOL.function.name, 'use_skill');
  assert.deepEqual(USE_SKILL_TOOL.function.parameters.required, ['name']);
  assert.ok(isUseSkillTool('use_skill'));
  assert.ok(!isUseSkillTool('github_read_file'));
});

test('frontmatter parsing survives real-world shapes', () => {
  const real = '---\nname: frontend-design\ndescription: Design guidance.\nlicense: Complete terms in LICENSE.txt\n---\n\n# Frontend Design\n\nBody here.';
  const meta = parseSkillFrontmatter(real);
  assert.equal(meta.name, 'frontend-design');
  assert.equal(meta.description, 'Design guidance.');
  assert.deepEqual(parseSkillFrontmatter('# No frontmatter\r\njust body'), { name: '', description: '' });
  assert.equal(parseSkillFrontmatter('').name, '');
  const crlf = '---\r\nname: a\r\ndescription: b\r\n---\r\nbody';
  assert.equal(parseSkillFrontmatter(crlf).description, 'b');
  // YAML block scalars fold the indented continuation lines into the value.
  const folded = '---\nname: academy-guide\ndescription: >\n  Use when learning\n  the academy system.\n---\nbody';
  assert.equal(parseSkillFrontmatter(folded).description, 'Use when learning the academy system.');
  const literal = '---\nname: x\ndescription: |\n  Line one.\n\n  Line two.\n---\nbody';
  assert.equal(parseSkillFrontmatter(literal).description, 'Line one. Line two.');
  const quoted = '---\nname: y\ndescription: "Use when deploying"\n---\nbody';
  assert.equal(parseSkillFrontmatter(quoted).description, 'Use when deploying');
  // A frontmatter block missing description yields an empty string, and such
  // rows are filtered out by pickSkills.
  assert.deepEqual(
    pickSkills('anything', 'build', [{ source: 'x', name: 'no-desc', description: '', body: '---\nname: no-desc\n---\nbody' }]),
    []
  );
});
