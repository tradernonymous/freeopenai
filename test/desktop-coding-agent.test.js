const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const agent = require('../desktop/src/coding-agent.js');

describe('coding-agent', () => {
  it('exports the expected API surface', () => {
    assert.equal(typeof agent.parseToolCall, 'function');
    assert.equal(typeof agent.createSession, 'function');
    assert.equal(typeof agent.computeDiff, 'function');
    assert.equal(typeof agent.runAgent, 'function');
    assert.equal(typeof agent.systemPrompt, 'function');
    assert.equal(typeof agent.readProjectNotes, 'function');
    assert.equal(typeof agent.summarizeArgs, 'function');
    assert.ok(Array.isArray(agent.TOOLS));
    assert.equal(typeof agent.MAX_ROUNDS, 'number');
    assert.equal(typeof agent.MAX_TOOL_CALLS, 'number');
  });

  it('lists the expected tools', () => {
    const names = agent.TOOLS.map(t => t.name);
    assert.ok(names.includes('list_files'));
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(names.includes('run_command'));
  });

  it('marks mutating tools', () => {
    const mutating = agent.TOOLS.filter(t => t.mutating).map(t => t.name);
    assert.ok(mutating.includes('write_file'));
    assert.ok(mutating.includes('edit_file'));
    assert.ok(mutating.includes('run_command'));
    const readOnly = agent.TOOLS.filter(t => !t.mutating).map(t => t.name);
    assert.ok(readOnly.includes('list_files'));
    assert.ok(readOnly.includes('read_file'));
  });

  // --- parseToolCall -------------------------------------------------------

  describe('parseToolCall', () => {
    it('parses a ```tool code block', () => {
      const text = 'Let me read that file.\n```tool\n{"name": "read_file", "args": {"path": "src/main.ts"}}\n```';
      const call = agent.parseToolCall(text);
      assert.equal(call.name, 'read_file');
      assert.deepEqual(call.args, { path: 'src/main.ts' });
    });

    it('parses a ```json code block', () => {
      const text = '```json\n{"name": "write_file", "args": {"path": "test.txt", "content": "hello"}}\n```';
      const call = agent.parseToolCall(text);
      assert.equal(call.name, 'write_file');
    });

    it('parses a bare JSON object', () => {
      const text = '{"name": "run_command", "args": {"command": "npm test"}}';
      const call = agent.parseToolCall(text);
      assert.equal(call.name, 'run_command');
      assert.deepEqual(call.args, { command: 'npm test' });
    });

    it('parses name: "tool" pattern', () => {
      const text = 'I will edit the file.\nname: "edit_file"\nargs: {"path": "a.ts", "old_text": "a", "new_text": "b"}';
      const call = agent.parseToolCall(text);
      assert.equal(call.name, 'edit_file');
    });

    it('returns null for text with no tool call', () => {
      assert.equal(agent.parseToolCall('Hello, how can I help?'), null);
      assert.equal(agent.parseToolCall(''), null);
      assert.equal(agent.parseToolCall(null), null);
    });

    it('handles malformed JSON gracefully', () => {
      assert.equal(agent.parseToolCall('```tool\n{broken}\n```'), null);
    });
  });

  // --- createSession -------------------------------------------------------

  describe('createSession', () => {
    it('creates a session with the expected fields', () => {
      const s = agent.createSession('/my/project', 'gpt-4', 'openai');
      assert.equal(s.root, '/my/project');
      assert.equal(s.model, 'gpt-4');
      assert.equal(s.provider, 'openai');
      assert.equal(s.status, 'idle');
      assert.deepEqual(s.plan, []);
      assert.deepEqual(s.messages, []);
      assert.equal(s.pendingApproval, null);
      assert.equal(s.toolCalls, 0);
      assert.equal(s.rounds, 0);
      assert.equal(s.error, null);
      assert.ok(s.id.startsWith('agent-'));
    });

    it('generates unique ids', () => {
      const a = agent.createSession('/');
      const b = agent.createSession('/');
      assert.notEqual(a.id, b.id);
    });
  });

  // --- computeDiff ---------------------------------------------------------

  describe('computeDiff', () => {
    it('shows added and removed lines', () => {
      const diff = agent.computeDiff('line1\nline2\nline3', 'line1\nline2-NEW\nline3\nline4');
      const lines = diff.split('\n');
      assert.ok(lines.includes('  line1'));
      assert.ok(lines.includes('- line2'));
      assert.ok(lines.includes('+ line2-NEW'));
      assert.ok(lines.includes('+ line4'));
    });

    it('handles empty old text (new file)', () => {
      const diff = agent.computeDiff('', 'hello\nworld');
      assert.ok(diff.includes('+ hello'));
      assert.ok(diff.includes('+ world'));
    });

    it('handles empty new text (deletion)', () => {
      const diff = agent.computeDiff('hello\nworld', '');
      assert.ok(diff.includes('- hello'));
      assert.ok(diff.includes('- world'));
    });

    it('handles identical text', () => {
      const diff = agent.computeDiff('same', 'same');
      assert.equal(diff, '  same');
    });
  });

  // --- systemPrompt --------------------------------------------------------

  describe('systemPrompt', () => {
    it('mentions the available tools', () => {
      const p = agent.systemPrompt();
      assert.ok(p.includes('list_files'));
      assert.ok(p.includes('read_file'));
      assert.ok(p.includes('write_file'));
      assert.ok(p.includes('edit_file'));
      assert.ok(p.includes('run_command'));
    });

    it('includes project notes when provided', () => {
      const p = agent.systemPrompt('## CLAUDE.md\nUse TypeScript.');
      assert.ok(p.includes('CLAUDE.md'));
      assert.ok(p.includes('TypeScript'));
    });

    it('does not include notes section when none provided', () => {
      const p = agent.systemPrompt();
      assert.ok(!p.includes('Project notes:'));
    });
  });

  // --- readProjectNotes ----------------------------------------------------

  describe('readProjectNotes', () => {
    it('reads AGENTS.md and CLAUDE.md when they exist', async () => {
      const readFile = async (path) => {
        if (path === 'AGENTS.md') return '# Agents\nBe helpful.';
        if (path === 'CLAUDE.md') return '# Claude\nUse TypeScript.';
        throw new Error('not found');
      };
      const notes = await agent.readProjectNotes(readFile);
      assert.ok(notes.includes('AGENTS.md'));
      assert.ok(notes.includes('CLAUDE.md'));
      assert.ok(notes.includes('Be helpful'));
    });

    it('returns empty when no notes exist', async () => {
      const readFile = async () => { throw new Error('not found'); };
      const notes = await agent.readProjectNotes(readFile);
      assert.equal(notes, '');
    });
  });

  // --- summarizeArgs -------------------------------------------------------

  describe('summarizeArgs', () => {
    it('summarizes string args', () => {
      const s = agent.summarizeArgs({ path: 'src/main.ts', command: 'npm test' });
      assert.ok(s.includes('path=src/main.ts'));
      assert.ok(s.includes('command=npm test'));
    });

    it('truncates long strings', () => {
      const long = 'x'.repeat(100);
      const s = agent.summarizeArgs({ content: long });
      assert.ok(s.includes('…'));
      assert.ok(s.length < 80);
    });
  });

  // --- runAgent (minimal integration) --------------------------------------

  describe('runAgent', () => {
    it('finishes when the model returns no tool call', async () => {
      const session = agent.createSession('/tmp');
      session.plan = [{ id: 0, title: 'say hi', status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
      const events = [];
      await agent.runAgent(session, {
        sendMessage: async () => 'Hello! How can I help?',
        onEvent: (e) => events.push(e),
      });
      assert.equal(session.status, 'done');
      assert.ok(events.some(e => e.type === 'status' && e.status === 'done'));
    });

    it('rejects an unknown tool and continues', async () => {
      const session = agent.createSession('/tmp');
      session.plan = [{ id: 0, title: 'hack', status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
      let calls = 0;
      await agent.runAgent(session, {
        sendMessage: async () => {
          calls++;
          if (calls === 1) return '```tool\n{"name": "nonexistent_tool", "args": {}}\n```';
          return 'All done!';
        },
        onEvent: () => {},
      });
      assert.equal(session.status, 'done');
      assert.ok(calls >= 2);
    });

    it('executes read-only tools without approval', async () => {
      const session = agent.createSession('/tmp');
      session.plan = [{ id: 0, title: 'list files', status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
      let calls = 0;
      await agent.runAgent(session, {
        sendMessage: async () => {
          calls++;
          if (calls === 1) return '```tool\n{"name": "list_files", "args": {"path": ""}}\n```';
          return 'Done listing.';
        },
        listFiles: async (root, path) => ({
          entries: [{ name: 'file.txt', dir: false, size: 100 }],
        }),
        onEvent: () => {},
      });
      assert.equal(session.status, 'done');
      assert.equal(session.toolCalls, 1);
    });

    it('creates an approval request for mutating tools', async () => {
      const session = agent.createSession('/tmp');
      session.plan = [{ id: 0, title: 'write file', status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
      let calls = 0;
      let approvalSeen = false;
      const decisionPromise = new Promise((resolve) => {
        // Immediately approve.
        setTimeout(() => resolve({ approved: true }), 10);
      });
      await agent.runAgent(session, {
        sendMessage: async () => {
          calls++;
          if (calls === 1) return '```tool\n{"name": "write_file", "args": {"path": "out.txt", "content": "hello"}}\n```';
          return 'Written.';
        },
        writeFile: async (root, path, content) => ({ path, bytes: content.length }),
        onEvent: (e) => {
          if (e.type === 'approval') approvalSeen = true;
        },
        onDecision: (id, resolve) => {
          decisionPromise.then(d => resolve(d));
        },
      });
      assert.ok(approvalSeen, 'should have emitted an approval event');
      assert.equal(session.status, 'done');
    });

    it('handles rejection by continuing the conversation', async () => {
      const session = agent.createSession('/tmp');
      session.plan = [{ id: 0, title: 'edit', status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
      let calls = 0;
      await agent.runAgent(session, {
        sendMessage: async () => {
          calls++;
          if (calls === 1) return '```tool\n{"name": "write_file", "args": {"path": "bad.txt", "content": "nope"}}\n```';
          return 'OK, I won\'t do that.';
        },
        writeFile: async () => ({ path: 'bad.txt', bytes: 4 }),
        onEvent: () => {},
        onDecision: (id, resolve) => {
          resolve({ approved: false, reason: 'Not needed' });
        },
      });
      assert.equal(session.status, 'done');
      // The rejection message should be in the conversation.
      const rejection = session.messages.find(m => m.content.includes('rejected'));
      assert.ok(rejection, 'should have a rejection message in the conversation');
    });
  });
});
