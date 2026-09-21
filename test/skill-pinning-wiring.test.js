// The rules live in chatlib.js and are tested there; this is the other half --
// that the page actually wires them up. A pinning feature that is written but
// never consulted looks identical to a working one from the outside, which is
// the failure mode worth a test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sourceOf } = require('./helpers/index-html.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

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
  assert.match(CSS, /parsed\.name === 'help'[\s\S]{0,80}renderCommandsHelp\(\)/);
  assert.match(CSS, /parsed\.name === 'skills'[\s\S]{0,90}renderSkillsCommandReply\(activeSkillNames, catalog\)/);
  assert.match(CSS, /parsed\.name === 'mode'[\s\S]{0,60}applyModeCommand\(parsed\.args\)/);
  assert.match(CSS, /parsed\.name === 'clear'[\s\S]{0,200}startNewConversation\(\)/);
  assert.match(CSS, /parsed\.name === 'skill'[\s\S]{0,60}applySkillCommand\(parsed\.args\)/);
  // `/ponytail` is the shorthand for `/skill ponytail`.
  assert.match(CSS, /parsed\.kind === 'skill'[\s\S]{0,60}pinSkillForChat\(parsed\.name\)/);
  // And `/skill off` has to be able to switch one off, or the cap is a trap.
  assert.match(CSS, /function applySkillCommand[\s\S]{0,200}\/\^off\\b/);
  assert.match(HTML, /setActiveSkillNames\(deactivateSkill\(activeSkillNames, which\)\)/);
});

test('the pinned set belongs to the chat: saved with it, loaded from it, absent in a new one', () => {
  // Each assertion reads the function's own body. A fixed character window was
  // the old form, and every unrelated line added inside one of these functions
  // pushed the call out of it -- reporting a broken pin when nothing had moved.
  // Saved: persistMessages writes the pinned names onto the conversation.
  assert.match(sourceOf('persistMessages'), /skills: activeSkillNames,/);
  // Loaded: the only source of the pinned set is the conversation itself.
  assert.match(sourceOf('syncActiveSkillsFromConversation'), /Array\.isArray\(convo\.skills\)/);
  // Called wherever a conversation becomes the active one...
  assert.match(sourceOf('renderActiveConversation'), /syncActiveSkillsFromConversation\(\)/);
  assert.match(sourceOf('loadMessagesFromStorage'), /syncActiveSkillsFromConversation\(\)/);
  // ...and the sync derives the names rather than keeping them, which is what
  // makes a new chat start empty without anyone having to remember to clear it.
  const sync = HTML.slice(APP_JS.indexOf('function syncActiveSkillsFromConversation'), APP_JS.indexOf('function renderSkillBar'));
  assert.match(sync, /activeSkillNames = convo && Array\.isArray/);
  assert.doesNotMatch(sync, /activeSkillNames\.push/, 'a fresh chat must not inherit the previous one');
});

test('a pinned skill is consulted even in Chat mode, where nothing is auto-picked', () => {
  // The old gate was `selectedMode !== 'chat' && skillsEnabled`, which made a
  // skill someone pinned do nothing at all in a normal chat.
  assert.match(
    HTML,
    /if \(activeSkillNames\.length \|\| learnedSkills\.length \|\| \(skillsEnabled && selectedMode !== 'chat'\)\)/,
    'the library is consulted when something is pinned, when an offer could be made, or when auto-picking could apply'
  );
  assert.match(CSS, /skillsForTurn\(\{[\s\S]{0,200}active: activeSkillNames,/);
  // use_skill rides along with whatever applied, and the application is
  // recorded: the card beside the chat says which skills answered, so a route
  // that applies a skill without logging it would leave that card lying.
  assert.ok(HTML.includes('if (activeSkills.length)'), 'active-skills block present');
  assert.ok(HTML.includes('filterToolsBySkills'), 'allowed-tools scoping is wired');
  assert.ok(HTML.includes('tools.push(USE_SKILL_TOOL)'), 'use_skill tool still offered');
  assert.ok(HTML.includes('logSkillsUsed(activeConversationId, activeSkills)'), 'skill application still logged');
  // A plain chat with nothing pinned does not drag the library in at all.
  const gate = HTML.slice(HTML.indexOf('if (activeSkillNames.length || learnedSkills'), APP_JS.indexOf('const stored = readPendingTurn()'));
  assert.match(gate, /const catalog = await ensureSkillsLoaded\(\)/);
});

test('a skill the model loads is pinned, so the next turn does not fetch it again', () => {
  const tool = HTML.slice(HTML.indexOf('async function runUseSkillTool'), HTML.indexOf('// Set when GitHub handed back'));
  assert.match(tool, /pinSkillQuietly\(name\)/, 'use_skill has to stick to the chat');
  const pin = HTML.slice(APP_JS.indexOf('function pinSkillQuietly'), HTML.indexOf('// --- The skill picker ---'));
  assert.match(pin, /activateSkill\(activeSkillNames, row\.name\)/);
  assert.match(pin, /addMessage\('system'/, 'and say so, or a skill that turns itself on is invisible');
  assert.doesNotMatch(pin, /console\.log/);
});

test('the composer has buttons: a chip per pinned skill, and a picker in the panel', () => {
  assert.match(HTML, /<div class="skill-bar" id="skillBar" hidden/, 'the bar exists and starts hidden');
  assert.match(CSS, /id="sessionChip"[^>]*onclick="toggleSessionPanel\(\)"/, 'and there is a button to reach the picker');
  // The picker used to be a floating dropdown anchored under a composer chip,
  // which is what made it need `position: fixed`, a place-the-popup function and
  // a re-place on resize -- and what the attach menu got wrong when it was
  // positioned inside the row that scrolls. In the session panel it is a block
  // in a static section, so none of that is needed to keep it unclipped.
  const section = HTML.slice(HTML.indexOf('id="sessionSectionSkills"'), HTML.indexOf('id="sessionSectionTasks"'));
  assert.match(section, /id="skillSearch"/);
  assert.match(section, /id="skillMenuList"/);
  assert.equal(HTML.includes('id="skillMenu"'), false, 'the floating picker outlived the floating picker');
  assert.equal(HTML.includes('positionSkillMenu'), false, 'and so did its positioning');
  assert.equal(HTML.includes('skillTrigger'), false, 'and the chip it hung from');
  // Removing a pin is a control on the chip, not a trip to settings.
  const bar = HTML.slice(APP_JS.indexOf('function renderSkillBar'), APP_JS.indexOf('function removePinnedSkill'));
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
  // The auto-picking switch says what it is, and sits in the panel beside the
  // list it governs rather than in the row of things you touch every message.
  assert.match(HTML, /<label for="autoSkillsCheck">Apply relevant skills automatically<\/label>/);
  assert.match(HTML, /<input type="checkbox" id="autoSkillsCheck" checked onchange="setSkillsEnabled\(this\.checked\)">/);
  // Two controls, one state: the checkbox and the stored flag cannot disagree.
  assert.match(sourceOf('updateSkillsToggle'), /box\.checked = skillsEnabled/);
  // Through the guard, not straight at localStorage: a browser that refuses
  // storage must not throw out of a checkbox handler.
  assert.match(sourceOf('setSkillsEnabled'), /rememberPreference\('freeopenaiSkills'/);
  assert.equal(HTML.includes('skillsToggle'), false, 'the old chip outlived the switch');
});

test('the switch and the picker sit in one section, and the panel owns both', () => {
  // Escape closes the surface, and only when it is open: it yields to a modal,
  // the palette, and a reply that is still generating, which Escape stops.
  assert.match(
    HTML,
    /const shell = sessionShell\(\);\s*if \(!shell \|\| shell\.classList\.contains\('session-hidden'\)\) return;\s*toggleSessionPanel\(false\);/,
  );
  // A click elsewhere must not dismiss it. Unlike the two popups it replaced,
  // the plan is meant to be read while the work happens.
  const outsideClick = HTML.slice(HTML.indexOf("document.addEventListener('click', () => {"), HTML.indexOf("});", HTML.indexOf("document.addEventListener('click', () => {")));
  assert.doesNotMatch(outsideClick, /[Ss]ession/, 'the panel is not a dropdown');
  // Opening draws the section it opens on, and the picker is fetched then rather
  // than being an empty list that fills in later.
  assert.match(sourceOf('toggleSessionPanel'), /showSessionTab\(sessionTab, false\)/);
  assert.match(sourceOf('showSessionTab'), /wanted === 'skills' && !skillsCatalog\.length[\s\S]{0,120}ensureSkillsLoaded\(\)/);
});

test('offers are scored while typing, before the message they are for is sent', () => {
  // After sending would be too late: the offer has to be acceptable for the
  // request being written, not the next one.
  assert.match(HTML, /chatInput\.addEventListener\('input', scheduleSkillSuggestion\)/);
  assert.match(CSS, /function scheduleSkillSuggestion\(\)[\s\S]{0,300}setTimeout\([\s\S]{0,120}updateSkillSuggestion\(\)/);
  assert.match(CSS, /function updateSkillSuggestion\(\)[\s\S]{0,400}suggestSkillFor\(chatInput\.value, skillsCatalog, skillUsage/);
  // Both halves of "do not offer this again": what is pinned, and what was refused.
  assert.match(HTML, /active: activeSkillNames,\s+dismissed: activeSkillDismissals,/);
  // And the offer does not survive the send it was made for.
  const send = HTML.slice(HTML.indexOf('async function sendMessage()'));
  assert.match(send, /setSkillSuggestion\(null\);[\s\S]{0,200}chatInput\.value = ''/);
});

test('accepting an offer pins it and teaches the app; dismissing it is remembered per chat', () => {
  // Accepting goes through the same pin as the button and the command.
  assert.match(CSS, /function acceptSkillSuggestion\(\)[\s\S]{0,300}pinSkillForChat\(name\)/);
  // Only deliberate pins count as a habit: the model's own use_skill must not.
  assert.match(CSS, /function rememberSkillHabit\(name\)[\s\S]{0,300}recordSkillPin\(skillUsage, name, activeConversationId\)/);
  const pin = HTML.slice(APP_JS.indexOf('function pinSkillForChat'), APP_JS.indexOf('function pinSkillQuietly'));
  assert.match(pin, /rememberSkillHabit\(row\.name\)/);
  const quiet = HTML.slice(APP_JS.indexOf('function pinSkillQuietly'), HTML.indexOf('// --- The skill picker ---'));
  assert.doesNotMatch(quiet, /rememberSkillHabit/, 'a skill the model loaded is not a preference');
  // A refusal belongs to the chat that made it, and is saved with it.
  assert.match(CSS, /function dismissSkillSuggestion\(\)[\s\S]{0,500}activeSkillDismissals = \[\.\.\.activeSkillDismissals, name\]/);
  assert.match(HTML, /skillsDismissed: activeSkillDismissals,/);
  assert.match(sourceOf('syncDismissedSuggestionsFromConversation'), /convo\.skillsDismissed/);
  assert.match(sourceOf('renderActiveConversation'), /syncDismissedSuggestionsFromConversation\(\)/);
});

test('the offer is visible with nothing pinned, and says why it is being made', () => {
  // The bar used to hide itself whenever there were no pins, which is exactly
  // the state an offer arrives in.
  const bar = HTML.slice(APP_JS.indexOf('function renderSkillBar'), APP_JS.indexOf('function buildSkillSuggestionChip'));
  assert.match(bar, /const suggestion = pendingSkillSuggestion/);
  assert.match(bar, /if \(!activeSkillNames\.length && !suggestion\) \{ bar\.hidden = true; return; \}/);
  assert.match(bar, /if \(suggestion\) bar\.appendChild\(buildSkillSuggestionChip\(suggestion\)\)/);
  // A suggestion with no reason reads as the app being random.
  const chip = HTML.slice(APP_JS.indexOf('function buildSkillSuggestionChip'), APP_JS.indexOf('function removePinnedSkill'));
  assert.match(chip, /'Try ' \+ suggestion\.skill\.name \+ '\?'/);
  assert.match(chip, /suggestion\.chats/);
  assert.match(chip, /acceptSkillSuggestion\(\)/);
  assert.match(chip, /dismissSkillSuggestion\(\)/);
  // It must not look like something already on.
  assert.match(CSS, /\.skill-suggest \{[\s\S]{0,200}border: 1px dashed/);
});
