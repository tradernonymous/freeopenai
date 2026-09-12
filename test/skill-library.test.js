// Skills used to be picked per request and then forgotten: the next question
// scored the library from scratch, so a skill someone deliberately turned on was
// off again by the second message. They are now pinned to the conversation --
// stored with the chat, applying in every mode, and never inherited by a new
// chat. These are the rules, and the library plumbing they sit on.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_ACTIVE_SKILLS,
  activateSkill,
  deactivateSkill,
  pinnedSkills,
  skillsForTurn,
  skillEntriesFromTree,
  resolveChatCommand,
  renderCommandsHelp,
  renderSkillsCommandReply,
  renderSkillsPrompt,
  CHAT_COMMANDS,
  SKILL_SOURCES,
} = require('../chatlib.js');

const blob = (path) => ({ type: 'blob', path });

test('a skill is named by the folder holding it, however deeply it is nested', () => {
  // The shape that used to collapse: naming by the first segment under `dir`
  // called all thirty-seven of this repo's skills "engineering".
  const tree = [
    blob('skills/engineering/code-review/SKILL.md'),
    blob('skills/engineering/diagnosing-bugs/SKILL.md'),
    blob('skills/planning/writing-plans/SKILL.md'),
    blob('skills/README.md'),
    blob('README.md'),
  ];
  assert.deepEqual(
    skillEntriesFromTree(tree, { repo: 'mattpocock/skills', dir: 'skills' }),
    [
      { name: 'code-review', path: 'skills/engineering/code-review/SKILL.md' },
      { name: 'diagnosing-bugs', path: 'skills/engineering/diagnosing-bugs/SKILL.md' },
      { name: 'writing-plans', path: 'skills/planning/writing-plans/SKILL.md' },
    ]
  );
});

test('a SKILL.md at the root of a repo is the skill itself', () => {
  // blader/humanizer is one skill at the top level, so its folder is the repo.
  assert.deepEqual(
    skillEntriesFromTree([blob('SKILL.md'), blob('docs/example/SKILL.md')], { repo: 'blader/humanizer', dir: '' }),
    [{ name: 'humanizer', path: 'SKILL.md' }]
  );
  // And a SKILL.md directly inside the directory takes the repo name too.
  assert.deepEqual(
    skillEntriesFromTree([blob('archify/SKILL.md')], { repo: 'tt-a1i/archify', dir: 'archify' }),
    [{ name: 'archify', path: 'archify/SKILL.md' }]
  );
});

test('the path travels with the name, so a nested skill is fetched where it really is', () => {
  // The bug this prevents: reconstructing `dir/name/SKILL.md` fetches a 404 for
  // everything nested, and a 404 is silently dropped, so the skill vanishes.
  const entries = skillEntriesFromTree([blob('skills/engineering/code-review/SKILL.md')], {
    repo: 'mattpocock/skills',
    dir: 'skills',
  });
  assert.equal(entries[0].path, 'skills/engineering/code-review/SKILL.md');
  assert.notEqual(entries[0].path, 'skills/code-review/SKILL.md');
});

test('a lite source takes only the names it names, and duplicates keep the first', () => {
  const tree = [
    blob('.openclaw/skills/ponytail/SKILL.md'),
    blob('.openclaw/skills/ponytail-help/SKILL.md'),
    blob('.openclaw/skills/ponytail-extras/SKILL.md'),
  ];
  const lite = skillEntriesFromTree(tree, { repo: 'DietrichGebert/ponytail', dir: '.openclaw/skills', pick: ['ponytail', 'ponytail-help'] });
  assert.deepEqual(lite.map((e) => e.name), ['ponytail', 'ponytail-help']);
  // The catalogue addresses skills by name, so a duplicate would be unreachable.
  const dupes = skillEntriesFromTree([blob('a/twin/SKILL.md'), blob('b/twin/SKILL.md')], { repo: 'x/y', dir: 'a' });
  assert.deepEqual(dupes, [{ name: 'twin', path: 'a/twin/SKILL.md' }]);
  // Junk in should not crash a server that is loading a library.
  assert.deepEqual(skillEntriesFromTree(null, { repo: 'x/y', dir: 'skills' }), []);
  assert.deepEqual(skillEntriesFromTree([null, {}, { type: 'tree', path: 'skills/a/SKILL.md' }], { repo: 'x/y', dir: 'skills' }), []);
});

test('pinning a skill is append-only, de-duplicated, and capped out loud', () => {
  let active = [];
  for (const name of ['ponytail', 'caveman', 'humanizer', 'no-ai-slop', 'archify']) {
    active = activateSkill(active, name).names;
  }
  assert.equal(active.length, MAX_ACTIVE_SKILLS);
  // The same name twice is not two skills.
  assert.deepEqual(activateSkill(active, 'CAVEMAN').names, active);
  assert.deepEqual(activateSkill(active, '  ').names, active);
  // Past the ceiling the oldest choice goes, and the caller is told which, so
  // the bar and the transcript can say what happened instead of silently refusing.
  const added = activateSkill(active, 'diagram-design');
  assert.equal(added.names.length, MAX_ACTIVE_SKILLS);
  assert.equal(added.dropped, 'ponytail');
  assert.equal(added.names[added.names.length - 1], 'diagram-design');
  assert.equal(added.names.includes('ponytail'), false);
  // Removing one, by any spelling of its name.
  assert.deepEqual(deactivateSkill(active, 'Caveman'), ['ponytail', 'humanizer', 'no-ai-slop', 'archify']);
  assert.deepEqual(deactivateSkill('not-an-array', 'x'), []);
});

const CATALOG = [
  { source: 'a/one', name: 'ponytail', description: 'lazy senior dev', body: 'BODY-PONYTAIL' },
  { source: 'a/one', name: 'caveman', description: 'compress prose', body: 'BODY-CAVEMAN' },
  { source: 'b/two', name: 'humanizer', description: 'remove AI tells', body: 'BODY-HUMANIZER' },
];

test('pinned names resolve to the installed skills, in the order they were chosen', () => {
  assert.deepEqual(pinnedSkills(['humanizer', 'ponytail'], CATALOG).map((s) => s.name), ['humanizer', 'ponytail']);
  // Case-insensitive, and a name that is not installed is dropped rather than
  // pretending something is applying.
  assert.deepEqual(pinnedSkills(['PONYTAIL', 'ghost'], CATALOG).map((s) => s.name), ['ponytail']);
  assert.deepEqual(pinnedSkills(null, CATALOG), []);
});

test('a pinned skill rides every request, in every mode, even with auto-skills off', () => {
  // Chat mode allows no auto-skills at all; the pinned one still applies, which
  // is the whole point of pinning it.
  const chat = skillsForTurn({ mode: 'chat', skillsEnabled: true, requestText: 'write me a poem', active: ['ponytail'], catalog: CATALOG });
  assert.deepEqual(chat.map((s) => s.name), ['ponytail']);
  assert.equal(chat[0].pinned, true, 'and it is marked, so the prompt says so');
  // Auto-skills off: the library is not consulted for matches, the pin remains.
  assert.deepEqual(
    skillsForTurn({ mode: 'build', skillsEnabled: false, requestText: 'write tests', active: ['caveman'], catalog: CATALOG }).map((s) => s.name),
    ['caveman']
  );
  // A new chat has nothing pinned, so a build turn is auto-picked exactly as before.
  const auto = skillsForTurn({ mode: 'build', skillsEnabled: true, requestText: 'compress this prose', active: [], catalog: CATALOG });
  assert.ok(auto.length > 0);
  assert.equal(auto.every((s) => !s.pinned), true);
  // And nothing is listed twice when the router would have picked the pin anyway.
  const both = skillsForTurn({ mode: 'build', skillsEnabled: true, requestText: 'compress this prose', active: ['caveman'], catalog: CATALOG });
  assert.deepEqual(both.map((s) => s.name), [...new Set(both.map((s) => s.name))]);
  assert.equal(both[0].name, 'caveman');
  assert.equal(both[0].pinned, true);
});

test('the prompt says pinned skills are for the whole chat, not this request', () => {
  const pinned = renderSkillsPrompt(skillsForTurn({ mode: 'chat', skillsEnabled: false, requestText: '', active: ['ponytail'], catalog: CATALOG }));
  assert.match(pinned, /pinned these to this chat/);
  assert.match(pinned, /\[pinned\]/);
  assert.match(pinned, /BODY-PONYTAIL/);
  // An unpinned set keeps the wording it had: this request, not the conversation.
  const auto = renderSkillsPrompt([CATALOG[2]]);
  assert.match(auto, /follow these methods for this request/);
  assert.doesNotMatch(auto, /pinned/);
});

test('a slash line means a command, a skill, or nothing at all', () => {
  const installed = ['ponytail', 'caveman', 'i-have-adhd'];
  assert.deepEqual(resolveChatCommand('/help', installed), { kind: 'command', name: 'help', args: '' });
  assert.deepEqual(resolveChatCommand('  /SKILL ponytail  ', installed), { kind: 'command', name: 'skill', args: 'ponytail' });
  assert.deepEqual(resolveChatCommand('/skill off caveman', installed), { kind: 'command', name: 'skill', args: 'off caveman' });
  assert.deepEqual(resolveChatCommand('/mode build', installed), { kind: 'command', name: 'mode', args: 'build' });
  // Typing a skill's own name is the shorthand, and the one people will reach for.
  assert.deepEqual(resolveChatCommand('/ponytail', installed), { kind: 'skill', name: 'ponytail' });
  assert.deepEqual(resolveChatCommand('/I-Have-ADHD', installed), { kind: 'skill', name: 'i-have-adhd' });
  // Everything else is a message. Swallowing text because it starts with a slash
  // would be worse than any typo it might have been.
  assert.equal(resolveChatCommand('/usr/bin/env is missing', installed), null);
  assert.equal(resolveChatCommand('/nope', installed), null);
  assert.equal(resolveChatCommand('hello', installed), null);
  assert.equal(resolveChatCommand('/', installed), null);
  assert.equal(resolveChatCommand('', installed), null);
  assert.equal(resolveChatCommand(undefined, installed), null);
});

test('the help and skills replies name what is on and how to change it', () => {
  const help = renderCommandsHelp();
  for (const command of CHAT_COMMANDS) assert.ok(help.includes(command.usage), command.usage + ' is listed');
  assert.match(help, /\/ponytail/);
  const on = renderSkillsCommandReply(['ponytail', 'caveman'], CATALOG);
  assert.match(on, /ponytail/);
  assert.match(on, /caveman/);
  const off = renderSkillsCommandReply([], CATALOG);
  assert.match(off, /Nothing is pinned/);
  assert.match(off, /3 skills are installed/);
  // A name that no longer exists is reported rather than dropped in silence.
  const missing = renderSkillsCommandReply(['ponytail', 'ghost'], CATALOG);
  assert.match(missing, /ghost/);
  assert.match(missing, /Not installed/);
});

test('every curated source is fetchable and none of them is a mistake', () => {
  // A source with no branch, or a `pick` that names nothing, silently contributes
  // no skills -- which is exactly the kind of quiet emptiness this guards.
  for (const source of SKILL_SOURCES) {
    assert.match(source.repo, /^[^/]+\/[^/]+$/, source.repo + ' is owner/name');
    assert.ok(source.branch, source.repo + ' names a branch');
    assert.equal(typeof source.dir, 'string');
    if (Array.isArray(source.pick)) assert.ok(source.pick.length, source.repo + ' picks something');
  }
  const repos = SKILL_SOURCES.map((s) => s.repo);
  assert.equal(new Set(repos).size, repos.length, 'no repo is listed twice');
  for (const wanted of ['DietrichGebert/ponytail', 'blader/humanizer', 'mattpocock/skills']) {
    assert.ok(repos.includes(wanted), wanted + ' is in the library');
  }
});
