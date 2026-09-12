// A pin is the strongest signal the app has about which skills someone wants.
// One pin in one chat is a mood; the same skill pinned in two different chats is
// a habit, and a habit is worth offering before it has to be typed a third time.
//
// The rules that keep it honest: habit is counted by chat (un-pinning and
// re-pinning in one conversation is one intention), only deliberate pins count
// (the model's own use_skill is the app's doing, not a preference), and the offer
// is a question rather than an action.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SKILL_HABIT_CHATS,
  SUGGEST_MIN_SCORE,
  MAX_TRACKED_SKILLS,
  normalizeSkillUsage,
  recordSkillPin,
  learnedSkillNames,
  suggestSkillFor,
  skillTriggerScore,
} = require('../chatlib.js');

const CATALOG = [
  { source: 'a/one', name: 'ponytail', description: 'Lazy senior dev mode for any coding task: YAGNI, stdlib first, no unrequested abstractions.', body: 'PONYTAIL' },
  { source: 'a/one', name: 'caveman', description: 'Compress prose: shorter words, fewer tokens, no filler.', body: 'CAVEMAN' },
  { source: 'b/two', name: 'humanizer', description: 'Rewrite AI-sounding prose so it reads like the writer.', body: 'HUMANIZER' },
];

const pin = (usage, name, chat, at = 1000) => recordSkillPin(usage, name, chat, at).usage;

test('usage storage survives junk, and counts chats rather than clicks', () => {
  assert.deepEqual(normalizeSkillUsage(null), {});
  assert.deepEqual(normalizeSkillUsage('nonsense'), {});
  assert.deepEqual(normalizeSkillUsage({ x: null }), {});
  // A skill with no chats recorded is not a habit that happened.
  assert.deepEqual(normalizeSkillUsage({ ponytail: { chats: [], lastAt: 5 } }), {});
  assert.deepEqual(normalizeSkillUsage({ ' Ponytail ': { chats: ['c1'], lastAt: '9' } }), { ponytail: { chats: ['c1'], lastAt: 9 } });
  // Junk inside the entry is dropped rather than crashing a suggestion pass.
  assert.deepEqual(normalizeSkillUsage({ ponytail: { chats: ['c1', '', 7], lastAt: 'x' } }), { ponytail: { chats: ['c1'], lastAt: 0 } });

  let usage = {};
  usage = pin(usage, 'ponytail', 'chat-1');
  assert.equal(learnedSkillNames(usage).length, 0, 'one chat is a mood');
  assert.equal(usage.ponytail.chats.length, 1);
  // The same chat again is the same intention, however many times it is clicked.
  usage = pin(usage, 'ponytail', 'chat-1', 2000);
  assert.equal(usage.ponytail.chats.length, 1);
  assert.equal(usage.ponytail.lastAt, 2000, 'but it is the most recent use');
  // A second chat is what makes it a habit.
  usage = pin(usage, 'ponytail', 'chat-2', 3000);
  assert.equal(SKILL_HABIT_CHATS, 2, 'two chats is the threshold these assertions are built on');
  assert.deepEqual(learnedSkillNames(usage), ['ponytail']);
  // And the same skill pinned in the second chat is still only two chats.
  usage = pin(usage, 'ponytail', 'chat-2', 4000);
  assert.deepEqual(usage.ponytail.chats, ['chat-1', 'chat-2']);

  // No name, no chat: nothing to record.
  assert.deepEqual(recordSkillPin(usage, '', 'chat-3', 1).usage, normalizeSkillUsage(usage));
  assert.deepEqual(recordSkillPin(usage, 'ponytail', '', 1).usage, normalizeSkillUsage(usage));
  assert.equal(recordSkillPin(usage, '', 'chat-3', 1).counted, false);
  assert.equal(recordSkillPin(usage, 'caveman', 'chat-4', 1).counted, true);
});

test('the most-used habits come first, and the store stays bounded', () => {
  let usage = {};
  usage = pin(usage, 'caveman', 'c1', 100);
  usage = pin(usage, 'caveman', 'c2', 200);
  usage = pin(usage, 'ponytail', 'c1', 300);
  usage = pin(usage, 'ponytail', 'c2', 400);
  usage = pin(usage, 'ponytail', 'c3', 500);
  // Sorted by how many chats, then by recency: ponytail (3) before caveman (2).
  assert.deepEqual(learnedSkillNames(usage), ['ponytail', 'caveman']);
  // Bounded: a browser that has pinned every skill on earth keeps the newest.
  let many = {};
  for (let i = 0; i < MAX_TRACKED_SKILLS + 15; i++) many = pin(many, 'skill-' + i, 'c1', 1000 + i);
  assert.equal(Object.keys(recordSkillPin(many, 'one-more', 'c9', 99999).usage).length, MAX_TRACKED_SKILLS);
  assert.ok(recordSkillPin(many, 'one-more', 'c9', 99999).usage['one-more'], 'the newest pins are the ones kept');
});

test('an offer needs a habit, a match, and someone who has not already refused it', () => {
  let usage = {};
  usage = pin(usage, 'ponytail', 'chat-1');
  usage = pin(usage, 'ponytail', 'chat-2');
  usage = pin(usage, 'humanizer', 'chat-1');
  usage = pin(usage, 'humanizer', 'chat-2');

  // Too little text to be a request at all.
  assert.equal(suggestSkillFor('ok', CATALOG, usage), null);
  assert.equal(suggestSkillFor('', CATALOG, usage), null);

  // A request that matches the habit: two shared words with the description.
  const request = 'keep this code minimal and avoid unrequested abstractions';
  const offered = suggestSkillFor(request, CATALOG, usage);
  assert.equal(offered.skill.name, 'ponytail');
  assert.equal(offered.chats, 2);
  assert.ok(offered.score >= SUGGEST_MIN_SCORE);

  // A request that matches nothing: no offer, however strong the habit.
  assert.equal(suggestSkillFor('what is the weather in Lisbon tomorrow', CATALOG, usage), null);
  // One shared word is below the line -- that is where interruptions start.
  assert.equal(suggestSkillFor('keep an eye on the deploy logs for me', CATALOG, usage), null);

  // A skill already pinned is not offered back at you.
  assert.equal(suggestSkillFor(request, CATALOG, usage, { active: ['ponytail'] }), null);
  // Nor one this chat has already declined -- matched by name, whatever the spelling.
  assert.equal(suggestSkillFor(request, CATALOG, usage, { dismissed: ['ponytail'] }), null);
  assert.equal(suggestSkillFor(request, CATALOG, usage, { dismissed: ['PONYTAIL'] }), null);

  // Pinned in one chat only: not a habit yet, so nothing is offered.
  const single = pin({}, 'ponytail', 'chat-9');
  assert.equal(suggestSkillFor(request, CATALOG, single), null);
  // A skill that is no longer installed cannot be offered.
  assert.equal(suggestSkillFor(request, [], usage), null);
  assert.equal(suggestSkillFor(request, CATALOG, null), null);
});

test('the best match wins, and the score is the one the router already uses', () => {
  let usage = {};
  for (const name of ['ponytail', 'caveman', 'humanizer']) {
    usage = pin(usage, name, 'chat-1');
    usage = pin(usage, name, 'chat-2');
  }
  // A compression request should reach for caveman, not whichever habit is oldest.
  const offered = suggestSkillFor('compress this prose and cut the filler from it', CATALOG, usage);
  assert.equal(offered.skill.name, 'caveman');
  assert.equal(offered.score, skillTriggerScore('compress this prose and cut the filler from it', CATALOG[1]));
  // The threshold is a real gate, not a formality.
  assert.ok(SUGGEST_MIN_SCORE > 0);
  const weak = suggestSkillFor('please make this a little bit shorter', CATALOG, usage);
  assert.ok(weak === null || weak.score >= SUGGEST_MIN_SCORE);
});

test('a description that ends in a full stop is still matchable on its last word', () => {
  // A bug the suggestion rules found: the tokenizer kept the sentence's full
  // stop, so the final word of every description was unmatchable -- "summary."
  // never met "summary". Costs every skill that ends a sentence with the word it
  // is really about, and nothing anywhere reported it.
  const skill = { name: 'wrap-up', description: 'Always finish a long task with a summary.' };
  assert.ok(skillTriggerScore('write the summary at the end', skill) > 0, 'the last word of a description counts');
  // A name hit still outweighs description overlap, and ids with dots survive.
  assert.ok(skillTriggerScore('use gpt-5.4 for this', { name: 'gpt-5.4', description: 'A model choice.' }) >= 3);
});
