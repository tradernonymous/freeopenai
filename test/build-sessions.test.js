// Remote build sessions: the phone writes a plan, the server carries it out.
//
// Everything here runs against a scripted stand-in for the model, because what
// is worth testing is the harness around it -- that nothing is written or run
// without an approval for that exact call, that a stale or foreign answer is
// refused, that a path cannot leave the session folder, and that a weak model
// with no native tool support can still drive the loop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { signSession, SESSION_COOKIE_NAME } = require('../auth.js');
const { loadServerPointedAt } = require('./helpers/github-stand-in.js');
const {
  planSteps,
  parseTextToolCalls,
  matchToolName,
  lineDiff,
  globToRegExp,
  refusedGit,
  createBuildSessions,
  BUILD_TOOL_NAMES,
} = require('../agent-sessions.js');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freeopenai-build-'));
}

function call(name, args, id) {
  return { id: id || 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// A model that answers from a script. Each entry is either a reply object or a
// function of the messages it was sent, so a test can react to a tool result.
function scriptedModel(script) {
  const seen = [];
  const fn = async (request) => {
    seen.push(request);
    const next = script.shift();
    if (!next) return { ok: true, message: { role: 'assistant', content: 'Finished.' } };
    return typeof next === 'function' ? next(request) : next;
  };
  fn.seen = seen;
  return fn;
}

function reply(content, toolCalls) {
  return { ok: true, message: { role: 'assistant', content: content || '', ...(toolCalls ? { tool_calls: toolCalls } : {}) } };
}

function engine(root, model, extra = {}) {
  return createBuildSessions({
    rootDir: root,
    callModel: model,
    pickModel: () => ({ provider: 'stub', model: 'stub-model' }),
    runRefusal: () => '',
    runCommand: async ({ command }) => ({ stdout: 'ran: ' + command, stderr: '', exitCode: 0, timedOut: false, durationMs: 1 }),
    webSearch: async () => ({ results: [] }),
    webFetch: async () => ({ title: '', text: '' }),
    ...extra,
  });
}

// Resolves with the first event matching `predicate`, replaying history first.
function waitForEvent(store, session, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('timed out waiting for event')); }, timeoutMs);
    unsubscribe = store.subscribe(session, 0, (event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        setTimeout(() => unsubscribe(), 0);
        resolve(event);
      }
    });
  });
}

const terminal = (e) => e.type === 'done' || e.type === 'failed';

test('a plan becomes numbered steps, whatever list style it was written in', () => {
  assert.deepEqual(planSteps('Goal\n1. Add a test\n2) Write the code\n3. Run it').map((s) => s.title),
    ['Add a test', 'Write the code', 'Run it']);
  assert.deepEqual(planSteps('- [ ] first\n* second\n- third').map((s) => s.title), ['first', 'second', 'third']);
  assert.deepEqual(planSteps('Just do the thing').map((s) => s.title), ['Carry out the plan']);
  assert.equal(planSteps(Array.from({ length: 40 }, (_, i) => (i + 1) + '. step').join('\n')).length, 20);
  assert.ok(planSteps('1. a\n2. b').every((s, i) => s.id === String(i + 1) && s.status === 'pending'));
});

test('a tool call written as text is still a tool call', () => {
  const names = BUILD_TOOL_NAMES;
  const fenced = parseTextToolCalls('I will write it.\n```json\n{"tool": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}\n```', names);
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].function.name, 'write_file');
  assert.deepEqual(JSON.parse(fenced[0].function.arguments), { path: 'a.txt', content: 'hi' });

  const bare = parseTextToolCalls('Sure: {"name": "read_file", "args": {"path": "x {y}.md"}} done', names);
  assert.equal(bare[0].function.name, 'read_file');
  assert.equal(JSON.parse(bare[0].function.arguments).path, 'x {y}.md', 'braces inside strings do not end the object');

  const openaiShape = parseTextToolCalls('{"function": {"name": "web_search", "arguments": "{\\"query\\": \\"node sea\\"}"}}', names);
  assert.equal(openaiShape[0].function.name, 'web_search');

  assert.equal(parseTextToolCalls('{"tool": "bash", "arguments": {"command": "ls"}}', names)[0].function.name, 'run_command');
  assert.deepEqual(parseTextToolCalls('no json here', names), []);
  assert.deepEqual(parseTextToolCalls('{"tool": "format_disk", "arguments": {}}', names), []);
  assert.deepEqual(parseTextToolCalls('{broken', names), []);
});

test('a tool call written as tags is run, and the tags never reach the phone', async () => {
  const tagged = parseTextToolCalls('Let me check.\n<tool_call>\n<function=run_command>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>');
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].function.name, 'run_command');
  assert.deepEqual(JSON.parse(tagged[0].function.arguments), { command: 'ls' });
  const two = parseTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call><tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>');
  assert.equal(two.length, 2, 'every tagged call is kept');

  const root = tempRoot();
  try {
    const model = scriptedModel([
      reply('Reading first.\n<tool_call>\n<function=read_file>\n<parameter=path>README.md</parameter>\n</function>\n</tool_call>'),
      reply('All done.'),
    ]);
    const store = engine(root, model);
    const session = store.create({ owner: 'op', plan: 'read the readme' });
    await waitForEvent(store, session, terminal);
    const texts = session.events.filter((e) => e.type === 'message').map((e) => e.text);
    assert.ok(texts.includes('Reading first.'), 'prose around the call is shown');
    assert.ok(texts.every((t) => !t.includes('<function=')), 'the markup is not');
    assert.ok(model.seen.length >= 2 && model.seen[1].messages.some((m) => m.role === 'tool' || m.fromTool), 'the call ran and its result went back');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('search, find, delete and move: the coding tools a real change needs', async () => {
  assert.ok(globToRegExp('src/**/*.kt').test('src/a/b/Main.kt'));
  assert.ok(globToRegExp('*.js').test('index.js'));
  assert.ok(!globToRegExp('*.js').test('src/index.js'), 'a single star stays inside one folder');
  assert.ok(globToRegExp('**/*.test.js').test('test/x.test.js'));
  assert.ok(globToRegExp('**/*.test.js').test('x.test.js'), 'a leading ** may match nothing');

  const root = tempRoot();
  try {
    const seen = [];
    const model = scriptedModel([
      reply('', [call('search_files', { query: 'needle', glob: '*.md' }, 'c1'), call('find_files', { pattern: '**/*.txt' }, 'c2')]),
      (request) => {
        seen.push(...request.messages.filter((m) => m.role === 'tool').map((m) => m.content));
        return reply('', [call('move_file', { from: 'notes/a.txt', to: 'notes/b.txt' }, 'c3')]);
      },
      reply('', [call('delete_file', { path: 'README.md' }, 'c4')]),
      reply('Done.'),
    ]);
    const store = engine(root, model);
    // Seed the build folder before the loop gets to it.
    const original = store.create;
    const session = original({ owner: 'op', plan: 'tidy up' });
    fs.mkdirSync(path.join(session.dir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(session.dir, 'README.md'), 'line one\nthe NEEDLE is here\n');
    fs.writeFileSync(path.join(session.dir, 'notes/a.txt'), 'needle too');
    const approval = await waitForEvent(store, session, (e) => e.type === 'approval');
    assert.equal(approval.tool, 'move_file');
    assert.match(approval.summary, /notes\/a\.txt → notes\/b\.txt/);
    assert.equal(store.input(session, { requestId: approval.requestId, decision: 'approve' }).status, 200);
    const second = await waitForEvent(store, session, (e) => e.type === 'approval' && e.tool === 'delete_file');
    assert.equal(store.input(session, { requestId: second.requestId, decision: 'approve' }).status, 200);
    await waitForEvent(store, session, terminal);
    assert.match(seen[0], /^README\.md:2: the NEEDLE is here$/m, 'search is case-insensitive and names the line');
    assert.ok(!seen[0].includes('a.txt'), 'the glob limited the search to markdown');
    assert.equal(seen[1].trim(), 'notes/a.txt');
    assert.ok(fs.existsSync(path.join(session.dir, 'notes/b.txt')) && !fs.existsSync(path.join(session.dir, 'notes/a.txt')));
    assert.ok(!fs.existsSync(path.join(session.dir, 'README.md')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git that would hang or rewrite history is refused before anyone is asked', () => {
  assert.equal(refusedGit('npm test'), '');
  assert.equal(refusedGit('git status && git push origin HEAD:main'), '');
  assert.equal(refusedGit('git push --force-with-lease origin main').length > 0, true);
  assert.match(refusedGit('git push -f origin main'), /force/);
  assert.match(refusedGit('git rebase -i HEAD~3'), /interactive|rewrite/);
  assert.match(refusedGit('git commit --amend -m x'), /rewrite/);
  assert.match(refusedGit('git config --global user.name x'), /outside/);
  assert.equal(refusedGit('git commit -m "fix: -i flag parsing"'), '', 'text inside the message is not a flag');
});

test('a build with a connected account runs git as that account and reads the project notes', async () => {
  const root = tempRoot();
  try {
    const runs = [];
    const model = scriptedModel([
      reply('', [call('run_command', { command: 'git status' }, 'c1')]),
      (request) => {
        assert.match(request.messages[0].content, /Project notes from AGENTS\.md/);
        assert.match(request.messages[0].content, /always run npm test/);
        assert.match(request.messages[0].content, /connected GitHub account \(octocat\)/);
        return reply('Done.');
      },
    ]);
    const store = engine(root, model, { runCommand: async (args) => { runs.push(args); return { stdout: 'clean', stderr: '', exitCode: 0 }; } });
    const session = store.create({ owner: 'op', plan: 'check', ctx: { headers: {}, git: { token: 'ghu_x', login: 'octocat' } } });
    fs.writeFileSync(path.join(session.dir, 'AGENTS.md'), '# Notes\nalways run npm test before you finish\n');
    const approval = await waitForEvent(store, session, (e) => e.type === 'approval');
    assert.match(approval.preview, /git runs as your GitHub account octocat/);
    assert.ok(!approval.preview.includes('ghu_x'), 'the token is never shown');
    store.input(session, { requestId: approval.requestId, decision: 'approve' });
    await waitForEvent(store, session, terminal);
    assert.equal(runs[0].git.login, 'octocat');
    assert.ok(!JSON.stringify(store.view(session)).includes('ghu_x'), 'the token is not in the view');
    assert.ok(!JSON.stringify(session.events).includes('ghu_x'), 'nor in any event');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a plan runs its actions in order, in one model turn, and skips what a failure left behind', async () => {
  const root = tempRoot();
  try {
    const model = scriptedModel([
      reply('', [call('plan_actions', {
        actions: [
          { id: 'write', tool: 'write_file', args: { path: 'a.txt', content: 'hello' } },
          { id: 'read', tool: 'read_file', args: { path: 'a.txt' }, after: ['write'] },
          { id: 'missing', tool: 'read_file', args: { path: 'nope.txt' } },
          { id: 'after-missing', tool: 'read_file', args: { path: 'a.txt' }, after: ['missing'] },
        ],
      }, 'c1')]),
      reply('Done.'),
    ]);
    const store = engine(root, model);
    const session = store.create({ owner: 'op', plan: 'write and read' });
    const approval = await waitForEvent(store, session, (e) => e.type === 'approval');
    assert.equal(approval.tool, 'write_file', 'a write inside a plan still asks');
    store.input(session, { requestId: approval.requestId, decision: 'approve' });
    await waitForEvent(store, session, terminal);

    // The point of the graph: four steps, one call to the model.
    const results = model.seen[1].messages.filter((m) => m.role === 'tool');
    assert.equal(results.length, 1, 'four actions came back as one tool result');
    const report = results.map((m) => m.content).join('\n');
    assert.match(report, /write \(write_file\): Created a\.txt/);
    assert.match(report, /read \(read_file\): hello/);
    assert.match(report, /missing \(read_file\): FAILED/);
    assert.match(report, /after-missing \(read_file\): skipped, it waited for missing/);
    assert.equal(fs.readFileSync(path.join(session.dir, 'a.txt'), 'utf8'), 'hello');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a plan the engine cannot run is refused with its reason, and nothing happens', async () => {
  const root = tempRoot();
  try {
    const model = scriptedModel([
      reply('', [call('plan_actions', { actions: [{ id: 'a', tool: 'write_file', args: { path: 'x', content: 'y' }, after: ['ghost'] }] }, 'c1')]),
      (request) => {
        const last = request.messages[request.messages.length - 1];
        assert.match(last.content, /was not run/);
        assert.match(last.content, /ghost/);
        return reply('Understood.');
      },
    ]);
    const store = engine(root, model);
    const session = store.create({ owner: 'op', plan: 'bad plan' });
    await waitForEvent(store, session, terminal);
    assert.equal(fs.existsSync(path.join(session.dir, 'x')), false, 'nothing ran');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tool names are matched loosely but never guessed', () => {
  assert.equal(matchToolName('write_file'), 'write_file');
  assert.equal(matchToolName('WriteFile'), 'write_file');
  assert.equal(matchToolName('shell'), 'run_command');
  assert.equal(matchToolName('cat'), 'read_file');
  assert.equal(matchToolName('delete_everything'), null);
  assert.equal(matchToolName(''), null);
});

test('the preview of a change shows what is removed and what is added', () => {
  const created = lineDiff('', 'a\nb');
  assert.match(created, /^\+a$/m);
  const edited = lineDiff('one\ntwo\nthree', 'one\nTWO\nthree');
  assert.match(edited, /^-two$/m);
  assert.match(edited, /^\+TWO$/m);
  assert.match(edited, /^ one$/m, 'with context');
});

test('a write waits for approval, then lands exactly as approved', async () => {
  const root = tempRoot();
  try {
    const model = scriptedModel([
      reply('Starting.', [call('step_update', { id: '1', status: 'in_progress' }, 'c1'), call('write_file', { path: 'hello.txt', content: 'hi there' }, 'c2')]),
      reply('', [call('step_update', { id: '1', status: 'done' }, 'c3')]),
      reply('Wrote hello.txt. Nothing else to do.'),
    ]);
    const store = engine(root, model);
    const session = store.create({ owner: 'op', chatId: 'chat-1', plan: '1. Write hello.txt' });
    const approval = await waitForEvent(store, session, (e) => e.type === 'approval');
    assert.equal(approval.tool, 'write_file');
    assert.match(approval.preview, /\+hi there/);
    assert.equal(store.view(session).status, 'awaiting_approval');
    assert.equal(fs.existsSync(path.join(root, 'builds', session.id, 'hello.txt')), false, 'nothing is written before approval');

    const answer = store.input(session, { text: 'approve' });
    assert.equal(answer.status, 200);
    const done = await waitForEvent(store, session, terminal);
    assert.equal(done.type, 'done');
    assert.equal(fs.readFileSync(path.join(root, 'builds', session.id, 'hello.txt'), 'utf8'), 'hi there');
    const view = store.view(session);
    assert.equal(view.status, 'done');
    assert.equal(view.steps[0].status, 'done');
    assert.ok(session.events.some((e) => e.type === 'diff' && e.path === 'hello.txt'));
    assert.deepEqual(session.events.map((e) => e.seq), session.events.map((_, i) => i + 1), 'events are numbered without gaps');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an approval or a question notifies the session\'s owner, not a stranger', async () => {
  const root = tempRoot();
  try {
    const notified = [];
    const model = scriptedModel([
      reply('', [call('write_file', { path: 'a.txt', content: 'x' })]),
      reply('Done.'),
    ]);
    const store = engine(root, model, { notifyOwner: (owner, msg) => notified.push({ owner, msg }) });
    const session = store.create({ owner: 'op', plan: 'write a.txt' });
    await waitForEvent(store, session, (e) => e.type === 'approval');
    assert.equal(notified.length, 1);
    assert.equal(notified[0].owner, 'op');
    assert.equal(notified[0].msg.title, 'Build needs your approval');
    store.input(session, { text: 'approve' });
    await waitForEvent(store, session, terminal);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a notifier that throws or rejects never stops the build', async () => {
  const root = tempRoot();
  try {
    const model = scriptedModel([
      reply('', [call('write_file', { path: 'a.txt', content: 'x' })]),
      reply('Done.'),
    ]);
    const store = engine(root, model, { notifyOwner: () => { throw new Error('push service is down'); } });
    const session = store.create({ owner: 'op', plan: 'write a.txt' });
    const approval = await waitForEvent(store, session, (e) => e.type === 'approval');
    assert.equal(approval.tool, 'write_file');
    assert.equal(store.view(session).status, 'awaiting_approval', 'the build still reached the same state a failed push would not change');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a session with no owner is never pushed to', async () => {
  const root = tempRoot();
  try {
    let calls = 0;
    const model = scriptedModel([reply('', [call('write_file', { path: 'a.txt', content: 'x' })]), reply('Done.')]);
    const store = engine(root, model, { notifyOwner: () => { calls++; } });
    const session = store.create({ plan: 'write a.txt' });
    await waitForEvent(store, session, (e) => e.type === 'approval');
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a rejection is not a write, and the reason reaches the model', async () => {
  const root = tempRoot();
  try {
    const model = scriptedModel([
      reply('', [call('write_file', { path: 'notes.txt', content: 'x' })]),
      (request) => {
        const last = request.messages[request.messages.length - 1];
        assert.equal(last.role, 'tool');
        assert.match(last.content, /rejected/i);
        assert.match(last.content, /call it notes\.md/);
        return reply('Understood, stopping.');
      },
    ]);
    const store = engine(root, model);
    const session = store.create({ owner: 'op', plan: 'write notes' });
    const approval = await waitForEvent(store, session, (e) => e.type === 'approval');
    assert.equal(store.input(session, { requestId: approval.requestId, decision: 'reject', text: 'call it notes.md' }).status, 200);
    await waitForEvent(store, session, terminal);
    assert.equal(fs.existsSync(path.join(root, 'builds', session.id, 'notes.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an answer for a different request, or when nothing waits, is refused', async () => {
  const root = tempRoot();
  try {
    const store = engine(root, scriptedModel([reply('', [call('write_file', { path: 'a.txt', content: 'a' })])]));
    const session = store.create({ owner: 'op', plan: 'x' });
    assert.equal(store.input(session, { text: 'approve' }).status, 409, 'nothing is waiting yet');
    await waitForEvent(store, session, (e) => e.type === 'approval');
    assert.equal(store.input(session, { requestId: 'not-this-one', decision: 'approve' }).status, 409);
    assert.equal(store.view(session).status, 'awaiting_approval', 'a stale answer changes nothing');
    assert.equal(store.input(session, {}).status, 400, 'an empty answer is not an approval');
    store.cancel(session);
    await waitForEvent(store, session, terminal);
    assert.equal(store.input(session, { text: 'approve' }).status, 409);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a path outside the session folder is refused without asking', async () => {
  const root = tempRoot();
  try {
    const model = scriptedModel([
      reply('', [call('write_file', { path: '../../escape.txt', content: 'x' })]),
      (request) => {
        assert.match(request.messages[request.messages.length - 1].content, /outside/i);
        return reply('ok');
      },
    ]);
    const store = engine(root, model);
    const session = store.create({ owner: 'op', plan: 'x' });
    await waitForEvent(store, session, terminal);
    assert.equal(session.events.some((e) => e.type === 'approval'), false);
    assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a command on a server that does not allow commands is refused, not asked about', async () => {
  const root = tempRoot();
  try {
    let ran = false;
    const model = scriptedModel([
      reply('', [call('run_command', { command: 'npm test' })]),
      (request) => {
        assert.match(request.messages[request.messages.length - 1].content, /WORKSPACE_RUN=1/);
        return reply('Cannot run tests here.');
      },
    ]);
    const store = engine(root, model, {
      runRefusal: () => 'Running commands is off on this server. Set WORKSPACE_RUN=1 to enable it.',
      runCommand: async () => { ran = true; return { stdout: '', stderr: '', exitCode: 0 }; },
    });
    const session = store.create({ owner: 'op', plan: 'x' });
    await waitForEvent(store, session, terminal);
    assert.equal(ran, false);
    assert.equal(session.events.some((e) => e.type === 'approval'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an approved command runs and its output is streamed', async () => {
  const root = tempRoot();
  try {
    const store = engine(root, scriptedModel([reply('', [call('run_command', { command: 'node -v' })]), reply('Done.')]));
    const session = store.create({ owner: 'op', plan: 'x' });
    await waitForEvent(store, session, (e) => e.type === 'approval');
    store.input(session, { text: 'yes' });
    const output = await waitForEvent(store, session, (e) => e.type === 'step' && e.phase === 'output');
    assert.match(output.text, /ran: node -v/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a model without native tools falls back to tool calls written as JSON', async () => {
  const root = tempRoot();
  try {
    const model = scriptedModel([
      { ok: false, status: 400, error: 'tools are not supported', toolsRejected: true },
      (request) => {
        assert.equal(request.tools, undefined, 'the retry is sent without tools');
        assert.match(request.messages[0].content, /```json/);
        return reply('```json\n{"tool": "write_file", "arguments": {"path": "a.md", "content": "# A"}}\n```');
      },
    ]);
    const store = engine(root, model);
    const session = store.create({ owner: 'op', plan: 'x' });
    const approval = await waitForEvent(store, session, (e) => e.type === 'approval');
    assert.equal(approval.tool, 'write_file');
    store.cancel(session);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling while a change waits ends the session and writes nothing', async () => {
  const root = tempRoot();
  try {
    const store = engine(root, scriptedModel([reply('', [call('write_file', { path: 'a.txt', content: 'a' })])]));
    const session = store.create({ owner: 'op', plan: 'x' });
    await waitForEvent(store, session, (e) => e.type === 'approval');
    store.cancel(session);
    const end = await waitForEvent(store, session, terminal);
    assert.equal(end.type, 'failed');
    assert.equal(end.status, 'cancelled');
    assert.equal(store.view(session).status, 'cancelled');
    assert.equal(fs.existsSync(path.join(root, 'builds', session.id, 'a.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an approval nobody answers expires closed', async () => {
  const root = tempRoot();
  try {
    const store = engine(root, scriptedModel([reply('', [call('write_file', { path: 'a.txt', content: 'a' })])]), { approvalTtlMs: 30 });
    const session = store.create({ owner: 'op', plan: 'x' });
    const end = await waitForEvent(store, session, terminal);
    assert.equal(end.status, 'expired');
    assert.equal(fs.existsSync(path.join(root, 'builds', session.id, 'a.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a model stuck repeating one call is stopped', async () => {
  const root = tempRoot();
  try {
    const again = () => reply('', [call('list_files', { path: '.' })]);
    const store = engine(root, scriptedModel(Array.from({ length: 10 }, () => again)));
    const session = store.create({ owner: 'op', plan: 'x' });
    const end = await waitForEvent(store, session, terminal);
    assert.equal(end.type, 'failed');
    assert.match(end.error, /repeat/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sessions belong to the account that started them', async () => {
  const root = tempRoot();
  try {
    const store = engine(root, scriptedModel([reply('done')]));
    const mine = store.create({ owner: 'alice', plan: 'x' });
    assert.equal(store.get(mine.id, 'alice'), mine);
    assert.equal(store.get(mine.id, 'bob'), null);
    assert.deepEqual(store.list('bob'), []);
    assert.equal(store.list('alice').length, 1);
    await waitForEvent(store, mine, terminal);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- The HTTP contract the Android app and the desktop app speak ---

const SECRET = 'build-secret';

async function withApp(env, run) {
  const previous = {};
  const stub = {
    SESSION_SECRET: SECRET,
    OPENROUTER_API_KEY: 'test-key',
    BUILD_AGENT_PROVIDER: 'openrouter',
    BUILD_AGENT_MODEL: 'stub:free',
    ...env,
  };
  // A stand-in provider that answers every turn with a plain summary.
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'All steps are done.' } }] }));
    });
  });
  await new Promise((resolve) => provider.listen(0, resolve));
  stub.OPENROUTER_BASE_URL = 'http://127.0.0.1:' + provider.address().port;
  for (const [key, value] of Object.entries(stub)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const appRoot = tempRoot();
  const { mod, cleanup } = loadServerPointedAt('https://api.github.com', '-build');
  const app = http.createServer(mod.createRequestHandler(appRoot));
  await new Promise((resolve) => app.listen(0, resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  const cookie = (user) => SESSION_COOKIE_NAME + '=' + signSession(SECRET, user);
  try {
    await run({ base, cookie });
  } finally {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup();
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
}

const ACCOUNTS = { AUTH_USER_1: 'alice', AUTH_PASS_1: 'pw1', AUTH_USER_2: 'bob', AUTH_PASS_2: 'pw2' };

test('the build session routes: create, read, stream, and stay private', async () => {
  await withApp(ACCOUNTS, async ({ base, cookie }) => {
    const post = (url, body, headers) => fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    assert.equal((await post('/api/build/sessions', { plan: '1. x' })).status, 401, 'signed out');

    const formPost = await fetch(base + '/api/build/sessions', {
      method: 'POST', headers: { 'Content-Type': 'text/plain', Cookie: cookie('alice') }, body: '{"plan":"1. x"}',
    });
    assert.equal(formPost.status, 415, 'a cross-site form cannot start a build');

    assert.equal((await post('/api/build/sessions', { plan: '' }, { Cookie: cookie('alice') })).status, 400);

    const created = await post('/api/build/sessions', { chatId: 'c1', plan: '1. Make a README\n2. Check it' }, { Cookie: cookie('alice') });
    assert.equal(created.status, 201);
    const { id, steps } = await created.json();
    assert.match(id, /^[a-f0-9]{16,}$/);
    assert.equal(steps.length, 2);

    const events = await fetch(base + '/api/build/sessions/' + id + '/events', { headers: { Cookie: cookie('alice') } });
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    const text = await events.text();
    assert.match(text, /^id: 1$/m);
    assert.match(text, /^event: status$/m);
    assert.match(text, /^event: done$/m, 'the stream ends once the session does');

    const view = await (await fetch(base + '/api/build/sessions/' + id, { headers: { Cookie: cookie('alice') } })).json();
    assert.equal(view.status, 'done');
    assert.equal(view.provider, 'openrouter');

    const replay = await (await fetch(base + '/api/build/sessions/' + id + '/events', { headers: { Cookie: cookie('alice'), 'Last-Event-ID': '1' } })).text();
    assert.doesNotMatch(replay, /^id: 1$/m, 'a reconnect gets only what it missed');

    assert.equal((await fetch(base + '/api/build/sessions/' + id, { headers: { Cookie: cookie('bob') } })).status, 404);
    const bobList = await (await fetch(base + '/api/build/sessions', { headers: { Cookie: cookie('bob') } })).json();
    assert.deepEqual(bobList.sessions, []);
    const aliceList = await (await fetch(base + '/api/build/sessions', { headers: { Cookie: cookie('alice') } })).json();
    assert.equal(aliceList.sessions[0].id, id);
    assert.equal(aliceList.enabled, true);
    const writeTool = aliceList.tools.find((t) => t.name === 'write_file');
    assert.equal(writeTool.approval, true, 'the hub can say which tools ask first');
    assert.equal(aliceList.tools.find((t) => t.name === 'read_file').approval, false);

    assert.equal((await post('/api/build/sessions/' + id + '/input', { text: 'approve' }, { Cookie: cookie('alice') })).status, 409);
    assert.equal((await post('/api/build/sessions/' + id + '/cancel', {}, { Cookie: cookie('bob') })).status, 404);
  });
});

test('an app with no login cannot start builds at all', async () => {
  await withApp({ AUTH_USER_1: undefined, AUTH_PASS_1: undefined, AUTH_USER_2: undefined, AUTH_PASS_2: undefined }, async ({ base }) => {
    const res = await fetch(base + '/api/build/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: '1. x' }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /login/i);
  });
});

test('push registration needs a sign-in and a real token, and answers whether push is even configured', async () => {
  await withApp({ ...ACCOUNTS, FCM_SERVICE_ACCOUNT: undefined }, async ({ base, cookie }) => {
    const post = (url, body, headers) => fetch(base + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await post('/api/push/register', { token: 'device-1' })).status, 401, 'signed out');
    assert.equal((await post('/api/push/register', { token: '' }, { Cookie: cookie('alice') })).status, 400, 'empty token');

    const registered = await post('/api/push/register', { token: 'device-1' }, { Cookie: cookie('alice') });
    assert.equal(registered.status, 200);
    const body = await registered.json();
    assert.equal(body.ok, true);
    assert.equal(body.configured, false, 'no FCM_SERVICE_ACCOUNT is set for this test run');

    const gone = await post('/api/push/unregister', { token: 'device-1' }, { Cookie: cookie('alice') });
    assert.equal(gone.status, 200);
    assert.equal((await post('/api/push/unregister', { token: 'device-1' })).status, 401);
  });
});
