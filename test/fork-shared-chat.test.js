// Forking a shared chat: the one server call the reader page's "Fork" link
// already makes (GET /api/share/<id>), replayed here to seed a brand-new
// local conversation. Nothing server-side changes -- chats are client-side
// by design -- so this is the whole feature.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const NAMES = ['forkSharedChat'];

function harness(overrides) {
  const state = {
    conversations: [],
    activeConversationId: 'old',
    messages: [{ type: 'user', content: 'stays untouched on failure' }],
    usageCount: 3,
    taskGraph: 'old-graph',
    workspaceFiles: { old: true },
    statuses: [],
    narrow: false,
    historyToggled: null,
    focused: false,
  };
  const deps = {
    fetch: overrides.fetch,
    newConversationId: () => 'new-id',
    upsertConversation: (list, convo) => [...list.filter((c) => c.id !== convo.id), convo],
    newTaskGraph: () => 'fresh-graph',
    updateUsageDisplay: () => {},
    renderTaskList: () => {},
    renderWorkspaceFiles: () => {},
    renderActiveConversation: () => {},
    writeConversations: () => {},
    isNarrowScreen: () => state.narrow,
    toggleHistory: (...args) => { state.historyToggled = args; },
    showStatus: (type, msg) => { state.statuses.push({ type, msg }); },
    chatInput: { focus: () => { state.focused = true; } },
    get conversations() { return state.conversations; },
    set conversations(v) { state.conversations = v; },
    get activeConversationId() { return state.activeConversationId; },
    set activeConversationId(v) { state.activeConversationId = v; },
    get messages() { return state.messages; },
    set messages(v) { state.messages = v; },
    get usageCount() { return state.usageCount; },
    set usageCount(v) { state.usageCount = v; },
    get taskGraph() { return state.taskGraph; },
    set taskGraph(v) { state.taskGraph = v; },
    get workspaceFiles() { return state.workspaceFiles; },
    set workspaceFiles(v) { state.workspaceFiles = v; },
  };
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, deps);
  return { state, loaded: loadFromIndex(NAMES, deps) };
}

test('a successful fork seeds a new conversation, converts bot images, and drops user images', async () => {
  const calledUrls = [];
  const { state, loaded } = harness({
    fetch: async (url) => {
      calledUrls.push(url);
      return new globalThis.Response(JSON.stringify({
        title: 'Original',
        messages: [
          { type: 'user', content: 'hi', images: ['data:image/png;base64,USER'] },
          { type: 'bot', content: 'hello', images: ['data:image/png;base64,BOT'] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  await loaded.forkSharedChat('abc123');
  assert.deepEqual(calledUrls, ['/api/share/abc123']);
  assert.equal(state.activeConversationId, 'new-id');
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0].images, undefined, 'a user message carries no images, matching how the rest of the app redraws saved messages');
  assert.deepEqual(state.messages[1].images, [{ url: 'data:image/png;base64,BOT' }], 'a bot image becomes the {url} shape storedImageUrl() reads');
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].title, 'Original (forked)');
  assert.equal(state.usageCount, 0);
  assert.equal(state.taskGraph, 'fresh-graph');
  assert.deepEqual(state.workspaceFiles, {});
  assert.equal(state.statuses.at(-1).type, 'success');
  assert.equal(state.focused, true);
});

test('a gone or revoked link is reported, and nothing local is touched', async () => {
  const { state, loaded } = harness({
    fetch: async () => new globalThis.Response('', { status: 404 }),
  });
  await loaded.forkSharedChat('missing');
  assert.equal(state.conversations.length, 0);
  assert.equal(state.activeConversationId, 'old', 'the current chat is left exactly as it was');
  assert.equal(state.statuses.at(-1).type, 'error');
  assert.match(state.statuses.at(-1).msg, /expired or been revoked/);
});

test('a share with nothing to fork is its own honest error', async () => {
  const { state, loaded } = harness({
    fetch: async () => new globalThis.Response(JSON.stringify({ title: 'Empty', messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  await loaded.forkSharedChat('empty-one');
  assert.equal(state.conversations.length, 0);
  assert.match(state.statuses.at(-1).msg, /nothing to fork/);
});

test('a network failure is reported rather than thrown', async () => {
  const { state, loaded } = harness({
    fetch: async () => { throw new Error('offline'); },
  });
  await loaded.forkSharedChat('x');
  assert.equal(state.conversations.length, 0);
  assert.match(state.statuses.at(-1).msg, /Could not reach the server/);
});
