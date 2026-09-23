const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const approval = require('../desktop/src/approval.js');
const projectConfig = require('../desktop/src/project-config.js');
const sandbox = require('../desktop/src/docker-sandbox.js');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

/** localStorage, small enough to see: the two keys a level is made of. */
function fakeStore(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    raw: (key) => (map.has(key) ? JSON.parse(map.get(key)) : null),
  };
}

const PROJECT_MODES = ['never', 'commands', 'always'];

describe('approval levels', () => {
  it('offers four levels, strictest first, each with a one-line consequence', () => {
    assert.equal(approval.LEVELS.length, 4);
    assert.deepEqual(approval.LEVELS.map((l) => l.id), ['ask', 'delegate', 'sandbox', 'full']);
    assert.equal(approval.STRICTEST, 'ask');
    approval.LEVELS.forEach((level, i) => {
      assert.equal(approval.rank(level.id), i, `${level.id} ranks where it sits`);
      assert.ok(level.why.trim().length > 20, `${level.id} says what will happen`);
      assert.ok(!/\n/.test(level.why), `${level.id}'s consequence is one line`);
      // Interface copy: sentence case, no shouting.
      assert.ok(!/\b[A-Z]{3,}\b/.test(level.label + ' ' + level.why), `${level.id} has no ALL-CAPS label`);
      assert.equal(level.label[0], level.label[0].toUpperCase());
    });
    assert.equal(approval.byId('full').risk, 'high', 'the level with no prompts and no container is marked risky');
    assert.equal(approval.byId('ask').risk, '');
  });

  it('each level writes exactly the settings it claims, and reads back as itself', () => {
    const claims = {
      ask: { mode: 'always', sandbox: false },
      delegate: { mode: 'commands', sandbox: false },
      sandbox: { mode: 'never', sandbox: true },
      full: { mode: 'never', sandbox: false },
    };
    for (const [id, claim] of Object.entries(claims)) {
      const store = fakeStore();
      assert.equal(approval.choose(id, store), id, `${id} is in force after being chosen`);
      assert.equal(store.raw(approval.KEY).approvalMode, claim.mode, `${id} stores ${claim.mode}`);
      assert.equal(store.raw(sandbox.KEY).enabled, claim.sandbox, `${id} sets the sandbox to ${claim.sandbox}`);
      assert.equal(approval.current(store), id, `${id} reads back from the settings themselves`);
      // The gate the agent actually asks is the same one the level claims.
      const effective = projectConfig.merge(projectConfig.globalSettings(store.raw(approval.KEY)), null);
      assert.equal(projectConfig.needsApproval(effective, 'write_file', {}), id === 'ask');
      assert.equal(projectConfig.needsApproval(effective, 'run_command', { command: 'rm -rf .' }),
        id === 'ask' || id === 'delegate');
    }
  });

  it('picking a level changes one decision, not the commands you allowed', () => {
    const store = fakeStore({
      [approval.KEY]: JSON.stringify({ approvalMode: 'always', allowedCommands: ['npm test'] }),
      [sandbox.KEY]: JSON.stringify({ enabled: false, image: 'node:22-bookworm' }),
    });
    approval.choose('sandbox', store);
    assert.deepEqual(store.raw(approval.KEY).allowedCommands, ['npm test']);
    assert.equal(store.raw(sandbox.KEY).image, 'node:22-bookworm', 'and not the image either');
  });

  it('a project file can only make the level stricter, never looser', () => {
    for (const level of approval.LEVELS) {
      for (const asked of PROJECT_MODES) {
        const got = approval.effectiveLevel(level.id, { approvalMode: asked });
        assert.ok(approval.rank(got) <= approval.rank(level.id),
          `${level.id} + a project asking for "${asked}" gave ${got}, which is looser`);
      }
      // A file that asks for nothing changes nothing.
      assert.equal(approval.effectiveLevel(level.id, null), level.id);
      assert.equal(approval.effectiveLevel(level.id, { approvalMode: null }), level.id);
    }
    // The case the rule exists for: a repository trying to keep full access.
    assert.equal(approval.effectiveLevel('full', { approvalMode: 'always' }), 'ask');
    assert.equal(approval.effectiveLevel('sandbox', { approvalMode: 'commands' }), 'delegate');
    assert.equal(approval.effectiveLevel('ask', { approvalMode: 'never' }), 'ask',
      'a project asking for no prompts at all is ignored');
  });

  it('an unknown or unreadable setting is the strictest level, not the loosest', () => {
    assert.equal(approval.byId('no-such-level'), null);
    assert.equal(approval.levelFor('sudo-mode', true), 'ask');
    assert.equal(approval.levelFor(undefined, false), 'ask');
    assert.equal(approval.current(fakeStore()), 'ask', 'nothing stored yet');
    assert.equal(approval.current(fakeStore({ [approval.KEY]: 'not json at all' })), 'ask');
    assert.equal(approval.current(fakeStore({ [approval.KEY]: JSON.stringify({ approvalMode: 'yolo' }) })), 'ask');
    assert.equal(approval.effectiveLevel('no-such-level', null), 'ask');

    const store = fakeStore({ [approval.KEY]: JSON.stringify({ approvalMode: 'never' }) });
    assert.equal(approval.choose('no-such-level', store), 'ask');
    assert.equal(store.raw(approval.KEY).approvalMode, 'always', 'an unknown pick tightens, it does not loosen');
  });

  it('the sandbox level is read from the sandbox setting, so it can never overstate itself', () => {
    const store = fakeStore();
    approval.choose('sandbox', store);
    // The same switch lives in Code; turning it off there is a real change,
    // and the menu has to say so rather than keep claiming a container.
    sandbox.saveSettings({ enabled: false, image: sandbox.DEFAULT_IMAGE }, store);
    assert.equal(approval.current(store), 'full');
  });

  it('the keys belong to the modules that already owned them', () => {
    assert.equal(approval.KEY, 'freeai4u.code_approval');
    assert.match(read('desktop', 'src', 'screens', 'CodeScreen.tsx'),
      /CODE_APPROVAL_KEY = 'freeai4u\.code_approval'/);
    assert.equal(sandbox.KEY, 'freeai4u.docker_sandbox');
  });
});

describe('composer tool groups', () => {
  it('names the three groups the chips show', () => {
    assert.deepEqual(approval.groupIds(), ['search', 'code', 'mcp']);
    approval.GROUPS.forEach((group) => {
      assert.ok(group.hint.length > 10, `${group.id} says what turning it on lets the model do`);
      assert.ok(!/\b[A-Z]{4,}\b/.test(group.hint));
    });
  });

  it('sorts a tool catalogue into the groups the chips govern', () => {
    assert.equal(approval.groupOf('web_search'), 'search');
    assert.equal(approval.groupOf('web_fetch'), 'search');
    assert.equal(approval.groupOf('run_command'), 'code');
    assert.equal(approval.groupOf('edit_file'), 'code');
    assert.equal(approval.groupOf('github_commit_file'), 'code');
    assert.equal(approval.groupOf('mcp__notion__search'), 'mcp');
    assert.equal(approval.groupOf('spawn_agent'), '', 'a tool no chip names is not governed by one');
    assert.equal(approval.groupOf(null), '');
  });

  it('offers only the groups that are on, and always what no chip governs', () => {
    const tools = require('../desktop/src/tools.js');
    const catalogue = tools.WEB.concat(tools.LOCAL, [tools.SPAWN_AGENT]);
    const names = (list) => list.map((def) => def.function.name);

    assert.deepEqual(names(approval.offered(catalogue, ['search'])), ['web_search', 'web_fetch', 'spawn_agent']);
    assert.deepEqual(names(approval.offered(catalogue, ['code'])),
      ['list_files', 'read_file', 'write_file', 'edit_file', 'run_command', 'spawn_agent']);
    assert.deepEqual(names(approval.offered(catalogue, [])), ['spawn_agent']);
    assert.equal(approval.offered(catalogue, approval.groupIds()).length, catalogue.length);
  });

  it('the chips persist, and a broken value is every group on', () => {
    const store = fakeStore();
    assert.deepEqual(approval.readGroups(store), ['search', 'code', 'mcp'], 'unset is all of them');

    const off = approval.toggleGroup(approval.readGroups(store), 'code');
    assert.deepEqual(approval.saveGroups(off, store), ['search', 'mcp']);
    assert.deepEqual(approval.readGroups(store), ['search', 'mcp'], 'and it is still that after a restart');

    assert.deepEqual(approval.toggleGroup(['search'], 'code'), ['search', 'code'], 'toggling twice is where it started');
    assert.deepEqual(approval.toggleGroup(['search'], 'not-a-group'), ['search']);

    assert.deepEqual(approval.readGroups(fakeStore({ [approval.GROUPS_KEY]: '{oops' })), ['search', 'code', 'mcp']);
    assert.deepEqual(approval.readGroups(fakeStore({ [approval.GROUPS_KEY]: '["mcp","mcp","nope"]' })), ['mcp']);
    assert.deepEqual(approval.saveGroups(['nope'], store), []);
  });
});

describe('the composer row', () => {
  const menu = read('desktop', 'src', 'components', 'ApprovalMenu.tsx');
  const composer = read('desktop', 'src', 'components', 'Composer.tsx');

  it('the menu is the four levels, keyboard-reachable, and says which one is on', () => {
    assert.match(menu, /className="approval-menu"/);
    assert.match(menu, /role="menu"/);
    assert.match(menu, /role="menuitemradio"/);
    assert.match(menu, /aria-checked=\{row\.id === level\}/);
    assert.match(menu, /className="approval-item"/);
    assert.match(menu, /className="approval-item-why"/);
    assert.match(menu, /data-risk=\{row\.risk \|\| undefined\}/, 'the risky level carries its mark');
    assert.match(menu, /e\.key !== 'Escape'/, 'Escape closes it');
    assert.match(menu, /'ArrowDown'/, 'the arrows move through it');
    assert.match(menu, /boxRef\.current && !boxRef\.current\.contains/, 'a click outside closes it');
    assert.match(menu, /approval\.choose\(id\)/, 'a pick writes the real setting');
    assert.match(menu, /approval\.current\(\)/, 'and what is shown is read back from it');
  });

  it('the row under the box holds the tools, the model, the mic and send', () => {
    assert.match(composer, /<ApprovalMenu \/>/);
    assert.match(composer, /className="composer-tools"/);
    assert.match(composer, /className="tool-chip"/);
    assert.match(composer, /aria-pressed=\{toolsOn && groups\.includes\(group\.id\)\}/);
    assert.match(composer, /approval\.saveGroups\(approval\.toggleGroup\(groups, id\)\)/, 'a chip persists');
    // Everything the composer could already do is still in the same row.
    assert.match(composer, /onAttach && \(/);
    assert.match(composer, /\{modelChip\}/);
    assert.match(composer, /name="mic"/);
    assert.match(composer, /className=\{`send-btn\$\{sending \? ' is-stop' : ''\}`\}/);
  });
});

// The chips have to reach the turn, or they are a promise the app breaks
// quietly: ChatScreen builds the catalogue, so this asserts the wiring at the
// one call site that matters.
describe('the chips reach the turn', () => {
  it('a chip turned off is a group the turn never offers', () => {
  const chat = read('desktop', 'src', 'screens', 'ChatScreen.tsx');
  assert.match(chat, /approval\.offered\(/, 'the catalogue passes through the filter');
  assert.match(chat, /approval\.readGroups\(\)/, 'with the groups the composer saved');
  const composer = read('desktop', 'src', 'components', 'Composer.tsx');
  assert.ok(!/the turn's tool list/.test(composer), 'the seam is closed, so its marker is gone');
  });
});
