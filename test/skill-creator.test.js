'use strict';

// Making a skill out of work you just did.
//
// The instruction the model is given decides whether the result is a skill or
// an essay, and the parser decides whether what comes back is safe to keep: a
// skill is injected into later prompts, so a draft with no name, no trigger
// description or a silly size is refused rather than saved.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SKILL_CREATOR_PROMPT,
  parseSkillDraft,
  addUserSkill,
  MAX_USER_SKILLS,
  MAX_USER_SKILL_CHARS,
} = require('../chatlib.js');

const draft = [
  '---',
  'name: railway-deploys',
  'description: Use when deploying this app to Railway, or when a deploy is live but serving an old commit.',
  '---',
  '',
  '# Railway deploys',
  '',
  '1. Push to main.',
  '2. Read /api/health and compare `commit` with `git rev-parse origin/main`.',
  '3. If they differ, the deploy has not finished; wait rather than pushing again.',
].join('\n');

test('the instruction asks for a skill, not an essay', () => {
  for (const rule of [/name/i, /description/i, /trigger|when to use/i, /numbered|steps/i, /imperative|terse|short/i]) {
    assert.match(SKILL_CREATOR_PROMPT, rule);
  }
  assert.match(SKILL_CREATOR_PROMPT, /---/, 'the frontmatter shape is shown');
});

test('a good draft is read into a skill', () => {
  const parsed = parseSkillDraft(draft);
  assert.equal(parsed.error, '');
  assert.equal(parsed.skill.name, 'railway-deploys');
  assert.match(parsed.skill.description, /^Use when deploying/);
  assert.equal(parsed.skill.source, 'you');
  assert.ok(parsed.skill.body.includes('1. Push to main.'));
  assert.ok(!parsed.skill.body.startsWith('---'), 'the frontmatter is not part of the body');
});

test('a draft that is not a skill is refused with a reason, never saved', () => {
  assert.match(parseSkillDraft('Here is how I would do it: first, ...').error, /name/i);
  assert.match(parseSkillDraft('---\nname: deploys\n---\nbody').error, /description/i);
  assert.match(parseSkillDraft('---\nname: x\ndescription: Use when testing.\n---\nbody').error, /name/i);
  assert.match(parseSkillDraft('---\nname: Bad Name!\ndescription: Use when testing.\n---\nbody').error, /name/i);
  assert.match(parseSkillDraft('---\nname: tiny\ndescription: Use when testing.\n---\n').error, /empty|short/i);
  const huge = '---\nname: big\ndescription: Use when testing.\n---\n' + 'x'.repeat(MAX_USER_SKILL_CHARS + 1);
  assert.match(parseSkillDraft(huge).error, /long/i);
  assert.match(parseSkillDraft('').error, /nothing|empty/i);
});

test('saving keeps one copy per name, newest first, and stops at the cap', () => {
  const first = addUserSkill([], parseSkillDraft(draft).skill);
  assert.equal(first.length, 1);

  const changed = { ...parseSkillDraft(draft).skill, body: 'different' };
  const replaced = addUserSkill(first, changed);
  assert.equal(replaced.length, 1, 'the same name replaces rather than piles up');
  assert.equal(replaced[0].body, 'different');

  let many = [];
  for (let i = 0; i < MAX_USER_SKILLS + 3; i++) {
    many = addUserSkill(many, { ...parseSkillDraft(draft).skill, name: 'skill-' + i });
  }
  assert.equal(many.length, MAX_USER_SKILLS);
  assert.equal(many[0].name, 'skill-' + (MAX_USER_SKILLS + 2), 'the newest is kept');
});
