// NEURA-052: `.freeai4u.json`, the per-project config read when a folder opens.
//
// The file arrives with a repository, so the tests that matter most are the
// ones that prove it cannot talk its way into more permission than the person
// already granted. Everything else is ordinary validation: a broken file must
// leave a readable problem behind and change nothing.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../desktop/src/project-config.js');
// The agent reads the rules off the global, which requiring the module above
// has just published; requiring it here is the node equivalent of the Code
// screen's `import '../project-config.js'`.
const agent = require('../desktop/src/coding-agent.js');

describe('project-config: the surface', () => {
  it('exports the expected API', () => {
    assert.equal(config.FILENAME, '.freeai4u.json');
    assert.deepEqual(config.MODES, ['never', 'commands', 'always']);
    assert.deepEqual(config.DEFAULT_GLOBAL, { approvalMode: 'always', allowedCommands: [] });
    for (const name of ['parse', 'merge', 'defaults', 'needsApproval', 'promptBlock', 'describe', 'read']) {
      assert.equal(typeof config[name], 'function', name + ' is exported');
    }
  });
});

describe('project-config: parsing', () => {
  it('treats an absent or empty file as no file at all', () => {
    for (const text of [null, undefined, '', '   \n']) {
      const parsed = config.parse(text);
      assert.equal(parsed.present, false);
      assert.deepEqual(parsed.problems, []);
      assert.equal(parsed.config.approvalMode, null);
    }
  });

  it('reads every documented field', () => {
    const parsed = config.parse(JSON.stringify({
      model: { provider: 'openai', model: 'gpt-4o-mini' },
      approvalMode: 'commands',
      allowedCommands: ['npm  test', 'npm run lint'],
      systemPrompt: '  This project uses tabs.  ',
    }));
    assert.equal(parsed.present, true);
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parsed.config.model, { provider: 'openai', model: 'gpt-4o-mini' });
    assert.equal(parsed.config.approvalMode, 'commands');
    // Whitespace is normalised so two spellings of one command compare equal.
    assert.deepEqual(parsed.config.allowedCommands, ['npm test', 'npm run lint']);
    assert.equal(parsed.config.systemPrompt, 'This project uses tabs.');
  });

  it('ignores unknown keys without complaining about them', () => {
    const parsed = config.parse('{"approvalMode":"always","somethingNewer":{"a":1}}');
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.config.approvalMode, 'always');
    assert.equal(parsed.config.somethingNewer, undefined);
  });

  it('reports invalid JSON instead of throwing or swallowing it', () => {
    const parsed = config.parse('{ this is not json ');
    assert.equal(parsed.present, true);
    assert.equal(parsed.problems.length, 1);
    assert.match(parsed.problems[0], /\.freeai4u\.json is not valid JSON/);
    // And nothing was taken from it.
    assert.deepEqual(parsed.config, {
      model: null, approvalMode: null, allowedCommands: null, systemPrompt: '',
    });
  });

  it('reports a file that is not an object', () => {
    for (const text of ['[]', '"hello"', '42', 'null']) {
      const parsed = config.parse(text);
      assert.equal(parsed.problems.length, 1, text + ' is refused');
      assert.match(parsed.problems[0], /has to be a JSON object/);
    }
  });

  it('reports each badly typed field and ignores only that field', () => {
    const parsed = config.parse(JSON.stringify({
      model: 'gpt-4o',
      approvalMode: 'sometimes',
      allowedCommands: 'npm test',
      systemPrompt: { text: 'no' },
    }));
    assert.equal(parsed.problems.length, 4);
    assert.deepEqual(parsed.config, {
      model: null, approvalMode: null, allowedCommands: null, systemPrompt: '',
    });
  });

  it('keeps the good entries of allowedCommands and says how many it dropped', () => {
    const parsed = config.parse(JSON.stringify({ allowedCommands: ['npm test', 7, '', null, 'ls'] }));
    assert.deepEqual(parsed.config.allowedCommands, ['npm test', 'ls']);
    assert.equal(parsed.problems.length, 1);
    assert.match(parsed.problems[0], /skipped 3 entr/);
  });

  it('cuts an overlong systemPrompt short rather than spending the context window', () => {
    const parsed = config.parse(JSON.stringify({ systemPrompt: 'x'.repeat(config.MAX_PROMPT + 500) }));
    assert.equal(parsed.config.systemPrompt.length, config.MAX_PROMPT);
    assert.match(parsed.problems[0], /cut short/);
  });
});

describe('project-config: a project file cannot escalate permissions', () => {
  const strict = { approvalMode: 'always', allowedCommands: [] };

  it('cannot turn approval off', () => {
    const asked = config.parse('{"approvalMode":"never"}').config;
    const effective = config.merge(strict, asked);
    assert.equal(effective.approvalMode, 'always');
    assert.equal(config.needsApproval(effective, 'write_file', { path: 'a.txt' }), true);
    assert.equal(config.needsApproval(effective, 'run_command', { command: 'ls' }), true);
  });

  it('cannot weaken approval to commands-only either', () => {
    const effective = config.merge(strict, config.parse('{"approvalMode":"commands"}').config);
    assert.equal(effective.approvalMode, 'always');
    assert.equal(config.needsApproval(effective, 'edit_file', { path: 'a.txt' }), true);
  });

  it('cannot add a command the person never allowed', () => {
    const asked = config.parse('{"allowedCommands":["rm -rf /","git push --force"]}').config;
    const effective = config.merge(strict, asked);
    assert.deepEqual(effective.allowedCommands, []);
    assert.equal(config.needsApproval(effective, 'run_command', { command: 'rm -rf /' }), true);
    assert.equal(config.needsApproval(effective, 'run_command', { command: 'git push --force' }), true);
  });

  it('narrows a list the person did grant, and never widens it', () => {
    const mine = { approvalMode: 'commands', allowedCommands: ['npm test', 'npm run lint'] };
    const asked = config.parse('{"allowedCommands":["npm test","curl evil.example"]}').config;
    const effective = config.merge(mine, asked);
    // The intersection: what the project asked for AND the person allows.
    assert.deepEqual(effective.allowedCommands, ['npm test']);
    assert.equal(config.needsApproval(effective, 'run_command', { command: 'npm test' }), false);
    assert.equal(config.needsApproval(effective, 'run_command', { command: 'npm run lint' }), true);
    assert.equal(config.needsApproval(effective, 'run_command', { command: 'curl evil.example' }), true);
  });

  it('may make approval stricter than the person asked for', () => {
    const mine = { approvalMode: 'never', allowedCommands: ['npm test'] };
    const effective = config.merge(mine, config.parse('{"approvalMode":"always"}').config);
    assert.equal(effective.approvalMode, 'always');
    assert.equal(config.needsApproval(effective, 'write_file', { path: 'a.txt' }), true);
  });

  it('never lets an allowance leak into a second, chained command', () => {
    const mine = { approvalMode: 'always', allowedCommands: ['npm test'] };
    const effective = config.merge(mine, config.parse('{"allowedCommands":["npm test"]}').config);
    assert.equal(config.needsApproval(effective, 'run_command', { command: 'npm test' }), false);
    for (const command of [
      'npm test; rm -rf .',
      'npm test && git push --force',
      'npm test | sh',
      'npm test `whoami`',
      'npm test $(whoami)',
      'npm test > /etc/passwd',
      'npm test\nrm -rf .',
    ]) {
      assert.equal(config.needsApproval(effective, 'run_command', { command: command }), true,
        command + ' still needs approval');
    }
  });

  it('matches whole words from the start, not any old prefix', () => {
    const mine = { approvalMode: 'always', allowedCommands: ['npm test'] };
    const effective = config.merge(mine, null);
    assert.equal(config.needsApproval(effective, 'run_command', { command: 'npm test --watch' }), false);
    assert.equal(config.needsApproval(effective, 'run_command', { command: 'npm testament' }), true);
    assert.equal(config.needsApproval(effective, 'run_command', { command: 'x npm test' }), true);
  });

  it('asks about everything when it is handed nothing at all', () => {
    for (const effective of [null, undefined, {}, 'nonsense']) {
      assert.equal(config.needsApproval(effective, 'write_file', {}), true);
      assert.equal(config.needsApproval(effective, 'run_command', { command: 'ls' }), true);
    }
  });

  it('treats a malformed global setting as the strict default', () => {
    const mine = config.globalSettings({ approvalMode: 'whenever', allowedCommands: 'everything' });
    assert.deepEqual(mine, { approvalMode: 'always', allowedCommands: [] });
  });
});

describe('project-config: merging the rest', () => {
  it('takes the project model, which is a preference and not a permission', () => {
    const effective = config.merge(null, config.parse('{"model":{"provider":"local","model":"qwen"}}').config);
    assert.deepEqual(effective.model, { provider: 'local', model: 'qwen' });
  });

  it('leaves the person alone when the project asks for nothing', () => {
    const mine = { approvalMode: 'commands', allowedCommands: ['npm test'] };
    const effective = config.merge(mine, config.parse('{}').config);
    assert.equal(effective.approvalMode, 'commands');
    assert.deepEqual(effective.allowedCommands, ['npm test']);
    assert.equal(effective.model, null);
    assert.equal(effective.systemPrompt, '');
  });

  it('defaults() is the merge of no project file at all', () => {
    assert.deepEqual(config.defaults(null), {
      model: null, approvalMode: 'always', allowedCommands: [], systemPrompt: '',
    });
  });

  it('describes what a folder changed, for the screen to show', () => {
    const mine = { approvalMode: 'commands', allowedCommands: ['npm test', 'ls'] };
    const parsed = config.parse(JSON.stringify({
      model: { provider: 'openai', model: 'gpt-4o' },
      approvalMode: 'always',
      allowedCommands: ['npm test'],
      systemPrompt: 'Tabs, not spaces.',
    }));
    const lines = config.describe(config.merge(mine, parsed.config), mine);
    assert.equal(lines.length, 4);
    assert.match(lines[0], /openai/);
    assert.match(lines[1], /approval: always/);
    assert.match(lines[2], /npm test/);
    assert.match(lines[3], /project context/);
    // A file that asks for nothing describes nothing.
    assert.deepEqual(config.describe(config.merge(mine, config.parse('{}').config), mine), []);
  });
});

describe('project-config: the project prompt is context, not instructions', () => {
  it('labels the block with where it came from', () => {
    const block = config.promptBlock('Run the linter before you finish.');
    assert.match(block, /from \.freeai4u\.json/);
    assert.match(block, /not as instructions/);
    assert.ok(block.includes('Run the linter before you finish.'));
  });

  it('is empty for an empty prompt', () => {
    assert.equal(config.promptBlock(''), '');
    assert.equal(config.promptBlock('   '), '');
    assert.equal(config.promptBlock(undefined), '');
  });

  it('is appended after the agent rules, never instead of them', () => {
    const block = config.promptBlock('Prefer pnpm.');
    const prompt = agent.systemPrompt('', block);
    assert.ok(prompt.includes('Never modify .git or .env files.'), 'the app rules are still there');
    assert.ok(prompt.indexOf('Never modify .git or .env files.') < prompt.indexOf('Prefer pnpm.'),
      'the project block comes after the rules');
    assert.ok(prompt.includes('Available tools:'));
  });

  it('leaves the prompt exactly as it was when there is no project block', () => {
    assert.equal(agent.systemPrompt(''), agent.systemPrompt('', ''));
  });
});

describe('project-config: reading the file from a folder', () => {
  it('reads, parses and merges in one call', async () => {
    const files = { '.freeai4u.json': '{"approvalMode":"always","systemPrompt":"Hi."}' };
    const loaded = await config.read((path) => Promise.resolve({ text: files[path] }), null);
    assert.equal(loaded.present, true);
    assert.deepEqual(loaded.problems, []);
    assert.equal(loaded.effective.approvalMode, 'always');
    assert.equal(loaded.effective.systemPrompt, 'Hi.');
  });

  it('a folder without the file is not a problem', async () => {
    const loaded = await config.read(() => Promise.reject(new Error('not found')), null);
    assert.equal(loaded.present, false);
    assert.deepEqual(loaded.problems, []);
    assert.deepEqual(loaded.effective, config.defaults(null));
  });

  it('a malformed file still yields working settings plus a problem to show', async () => {
    const loaded = await config.read(() => Promise.resolve('{oops'), null);
    assert.equal(loaded.present, true);
    assert.equal(loaded.problems.length, 1);
    assert.deepEqual(loaded.effective, config.defaults(null));
  });
});

describe('coding-agent: the folder settings reach the loop', () => {
  /** A model that asks for one command and then stops talking. */
  function scriptedModel(steps) {
    let at = 0;
    return async () => (at < steps.length ? steps[at++] : 'All done.');
  }

  function baseCallbacks(extra) {
    return Object.assign({
      runCmd: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }),
      readFile: async () => { throw new Error('no notes'); },
    }, extra || {});
  }

  it('createSession starts with no folder settings, which means ask', () => {
    assert.equal(agent.createSession('/tmp/p').config, null);
  });

  it('asks before a command when the folder says nothing', async () => {
    const session = agent.createSession('/tmp/p');
    session.plan = [{ id: 0, title: 'run the tests', status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
    const seen = [];
    await agent.runAgent(session, baseCallbacks({
      sendMessage: scriptedModel(['```tool\n{"name":"run_command","args":{"command":"npm test"}}\n```']),
      onEvent: (event) => seen.push(event.type),
      onDecision: (id, resolve) => resolve({ approved: true }),
    }));
    assert.ok(seen.includes('approval'), 'the approval card was shown');
  });

  it('runs an allowed command without a card, and still shows the step', async () => {
    const session = agent.createSession('/tmp/p');
    session.config = config.merge(
      { approvalMode: 'always', allowedCommands: ['npm test'] },
      config.parse('{"allowedCommands":["npm test"]}').config,
    );
    session.plan = [{ id: 0, title: 'run the tests', status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
    const seen = [];
    await agent.runAgent(session, baseCallbacks({
      sendMessage: scriptedModel(['```tool\n{"name":"run_command","args":{"command":"npm test"}}\n```']),
      onEvent: (event) => seen.push(event.type),
      onDecision: () => assert.fail('no decision should have been asked for'),
    }));
    assert.ok(!seen.includes('approval'), 'no approval card');
    assert.ok(seen.includes('auto'), 'the unattended run was still announced');
    assert.equal(session.plan[session.plan.length - 1].status, 'done');
  });

  it('a project asking for "never" still gets the card', async () => {
    const session = agent.createSession('/tmp/p');
    // The person's own settings are the strict default; the project asks for none.
    session.config = config.merge(null, config.parse('{"approvalMode":"never"}').config);
    session.plan = [{ id: 0, title: 'write a file', status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
    const seen = [];
    await agent.runAgent(session, baseCallbacks({
      writeFile: async () => ({ path: 'a.txt', bytes: 3 }),
      sendMessage: scriptedModel(['```tool\n{"name":"write_file","args":{"path":"a.txt","content":"hi"}}\n```']),
      onEvent: (event) => seen.push(event.type),
      onDecision: (id, resolve) => resolve({ approved: true }),
    }));
    assert.ok(seen.includes('approval'), 'the project could not turn the card off');
  });
});
