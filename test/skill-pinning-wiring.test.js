// The rules live in chatlib.js and are tested there; this is the other half --
// that the page actually wires them up. A pinning feature that is written but
// never consulted looks identical to a working one from the outside, which is
// the failure mode worth a test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('a command is resolved before anything is sent, and never sent to a model', () => {
  const send = HTML.slice(HTML.indexOf('async function sendMessage()'));
  const resolved = send.indexOf('await resolveComposerCommand(raw)');
  const sent = send.indexOf("addMessage('user', raw)");
  assert.ok(resolved > -1, 'sendMessage no longer resolves commands');
  assert.ok(resolved < sent, 'the command has to be answered before the turn starts');
  // A resolved command returns early: no typing indicator, no billed request.
  const branch = send.slice(resolved, resolved + 400);
  assert.match(branch, /if \(commandReply !== null\)/, 'the resolved command has to short-circuit the send');
  assert.match(branch, /return;/, 'and stop there');
});

test('each command does what it says on the tin', () => {
  assert.match(HTML, /parsed\.name === 'help'[\s\S]{0,80}renderCommandsHelp\(\)/);
  assert.match(HTML, /parsed\.name === 'skills'[\s\S]{0,90}renderSkillsCommandReply\(activeSkillNames, catalog\)/);
  assert.match(HTML, /parsed\.name === 'mode'[\s\S]{0,60}applyModeCommand\(parsed\.args\)/);
  assert.match(HTML, /parsed\.name === 'clear'[\s\S]{0,200}startNewConversation\(\)/);
  assert.match(HTML, /parsed\.name === 'skill'[\s\S]{0,60}applySkillCommand\(parsed\.args\)/);
  // `/ponytail` is the shorthand for `/skill ponytail`.
  assert.match(HTML, /parsed\.kind === 'skill'[\s\S]{0,60}pinSkillForChat\(parsed\.name\)/);
  // And `/skill off` has to be able to switch one off, or the cap is a trap.
  assert.match(HTML, /function applySkillCommand[\s\S]{0,200}\/\^off\\b/);
  assert.match(HTML, /setActiveSkillNames\(deactivateSkill\(activeSkillNames, which\)\)/);
});

test('the pinned set belongs to the chat: saved with it, loaded from it, absent in a new one', () => {
  // Saved: persistMessages writes the pinned names onto the conversation.
  assert.match(HTML, /function persistMessages[\s\S]{0,600}skills: activeSkillNames,/);
  // Loaded: the only source of the pinned set is the conversation itself.
  assert.match(HTML, /function syncActiveSkillsFromConversation[\s\S]{0,400}Array\.isArray\(convo\.skills\)/);
  // Called wherever a conversation becomes the active one...
  assert.match(HTML, /function renderActiveConversation[\s\S]{0,400}syncActiveSkillsFromConversation\(\)/);
  assert.match(HTML, /function loadMessagesFromStorage[\s\S]{0,2000}syncActiveSkillsFromConversation\(\)/);
  // ...and the sync derives the names rather than keeping them, which is what
  // makes a new chat start empty without anyone having to remember to clear it.
  const sync = HTML.slice(HTML.indexOf('function syncActiveSkillsFromConversation'), HTML.indexOf('function renderSkillBar'));
  assert.match(sync, /activeSkillNames = convo && Array\.isArray/);
  assert.doesNotMatch(sync, /activeSkillNames\.push/, 'a fresh chat must not inherit the previous one');
});

test('a pinned skill is consulted even in Chat mode, where nothing is auto-picked', () => {
  // The old gate was `selectedMode !== 'chat' && skillsEnabled`, which made a
  // skill someone pinned do nothing at all in a normal chat.
  assert.match(
    HTML,
    /if \(activeSkillNames\.length \|\| \(skillsEnabled && selectedMode !== 'chat'\)\)/,
    'the library is consulted when something is pinned, or when auto-picking could apply'
  );
  assert.match(HTML, /skillsForTurn\(\{[\s\S]{0,200}active: activeSkillNames,/);
  assert.match(HTML, /if \(activeSkills\.length\) tools\.push\(USE_SKILL_TOOL\)/);
  // A plain chat with nothing pinned does not drag the library in at all.
  const gate = HTML.slice(HTML.indexOf('if (activeSkillNames.length || (skillsEnabled'), HTML.indexOf('const stored = readPendingTurn()'));
  assert.match(gate, /const catalog = await ensureSkillsLoaded\(\)/);
});

test('a skill the model loads is pinned, so the next turn does not fetch it again', () => {
  const tool = HTML.slice(HTML.indexOf('async function runUseSkillTool'), HTML.indexOf('// Set when GitHub handed back'));
  assert.match(tool, /pinSkillQuietly\(name\)/, 'use_skill has to stick to the chat');
  const pin = HTML.slice(HTML.indexOf('function pinSkillQuietly'), HTML.indexOf('// --- The skill picker ---'));
  assert.match(pin, /activateSkill\(activeSkillNames, row\.name\)/);
  assert.match(pin, /addMessage\('system'/, 'and say so, or a skill that turns itself on is invisible');
  assert.doesNotMatch(pin, /console\.log/);
});

test('the composer has buttons: a chip per pinned skill, and a picker that cannot be clipped', () => {
  assert.match(HTML, /<div class="skill-bar" id="skillBar" hidden/, 'the bar exists and starts hidden');
  assert.match(HTML, /id="skillTrigger"/, 'and there is a button to add one');
  // The picker rides the model dropdown's fixed-position contract. The attach
  // menu was invisible on every screen size because it was positioned inside the
  // horizontally-scrolling controls row; a menu with this class cannot be.
  assert.match(HTML, /<div class="model-dropdown" id="skillMenu"/);
  assert.match(HTML, /function positionSkillMenu\(\)[\s\S]{0,500}placeDropdown\(/);
  assert.match(HTML, /window\.addEventListener\('resize',[\s\S]{0,160}positionSkillMenu\(\)/);
  // Removing a pin is a control on the chip, not a trip to settings.
  const bar = HTML.slice(HTML.indexOf('function renderSkillBar'), HTML.indexOf('function removePinnedSkill'));
  assert.match(bar, /off\.textContent = '×'/);
  assert.match(bar, /removePinnedSkill\(name\)/);
  // A chip for a name that is not in the library is still shown: the pin is the
  // user's, and hiding it would look like the app forgot.
  assert.match(bar, /activeSkillNames\.length/);
  assert.match(bar, /bar\.hidden = false/);
});

test('the skills panel and the picker tell one story about the library', () => {
  // Two counts of the same library that disagree is how a user learns to trust
  // neither, so the picker reuses the panel's text.
  assert.match(HTML, /skillsStatusText = skillsCatalog\.length/);
  assert.match(HTML, /empty\.textContent = skillsStatusText/);
  assert.match(HTML, /pinned ones apply in every mode/);
  // The auto-picking toggle now says what it is, since pinning is the other half.
  assert.match(HTML, /Auto-skills on/);
  assert.match(HTML, /toggle\.textContent = skillsEnabled \? 'Auto-skills on' : 'Auto-skills off'/);
});

test('the toggle and the picker stay out of each other\'s way', () => {
  // The picker opens on click, closes on outside click, and Escape returns focus
  // to the trigger -- the same contract the other two popups have.
  assert.match(HTML, /function closeSkillMenu\(\)[\s\S]{0,200}aria-expanded', 'false'/);
  assert.match(HTML, /document\.addEventListener\('click',[\s\S]{0,120}closeSkillMenu\(\)/);
  assert.match(HTML, /function handleSkillMenuKeydown[\s\S]{0,800}closeSkillMenu\(\); skillTrigger\.focus\(\)/);
  assert.match(HTML, /function openSkillMenu\(\)[\s\S]{0,400}closeModelDropdown\(\);[\s\S]{0,80}closeAttachMenu\(\)/);
});
