const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_CONVERSATIONS,
  MAX_MESSAGES_PER_CONVERSATION,
  deriveChatTitle,
  newConversation,
  sortConversations,
  upsertConversation,
  migrateLegacyMessages,
} = require('../chatlib.js');

test('a chat is titled by the first thing the user said', () => {
  assert.equal(deriveChatTitle([{ type: 'user', content: 'Fix my README' }]), 'Fix my README');
  // A greeting from the assistant is not a title.
  assert.equal(
    deriveChatTitle([{ type: 'bot', content: 'Hello!' }, { type: 'user', content: 'Real question' }]),
    'Real question'
  );
});

test('titles collapse whitespace and truncate with an ellipsis', () => {
  assert.equal(deriveChatTitle([{ type: 'user', content: 'a\n\n  b\tc' }]), 'a b c');
  const long = deriveChatTitle([{ type: 'user', content: 'x'.repeat(80) }]);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
});

test('an empty or blank chat still gets a usable title', () => {
  assert.equal(deriveChatTitle([]), 'New chat');
  assert.equal(deriveChatTitle(null), 'New chat');
  assert.equal(deriveChatTitle([{ type: 'user', content: '   ' }]), 'New chat');
});

test('conversations sort newest first', () => {
  const sorted = sortConversations([
    { id: 'a', updatedAt: 1 },
    { id: 'c', updatedAt: 3 },
    { id: 'b', updatedAt: 2 },
  ]);
  assert.deepEqual(sorted.map((c) => c.id), ['c', 'b', 'a']);
});

test('equal timestamps keep a stable order rather than reshuffling', () => {
  const input = [{ id: 'b', updatedAt: 5 }, { id: 'a', updatedAt: 5 }];
  assert.deepEqual(sortConversations(input).map((c) => c.id), ['a', 'b']);
  assert.deepEqual(sortConversations(sortConversations(input)).map((c) => c.id), ['a', 'b']);
});

test('sortConversations does not mutate its input', () => {
  const input = [{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 9 }];
  sortConversations(input);
  assert.equal(input[0].id, 'a');
});

test('upsert replaces a conversation instead of duplicating it', () => {
  const list = [newConversation('x', 1)];
  const updated = upsertConversation(list, { id: 'x', title: 'Renamed', messages: [], updatedAt: 2 });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].title, 'Renamed');
});

test('upsert adds a new conversation at the top', () => {
  const list = [{ id: 'old', updatedAt: 1 }];
  const updated = upsertConversation(list, newConversation('new', 99));
  assert.deepEqual(updated.map((c) => c.id), ['new', 'old']);
});

test('the conversation list is capped, dropping the oldest', () => {
  let list = [];
  for (let i = 0; i < MAX_CONVERSATIONS + 10; i++) {
    list = upsertConversation(list, newConversation('c' + i, i));
  }
  assert.equal(list.length, MAX_CONVERSATIONS);
  assert.equal(list[0].id, 'c' + (MAX_CONVERSATIONS + 9));
  assert.ok(!list.some((c) => c.id === 'c0'), 'the oldest must be dropped');
});

test('an existing single-chat history is carried over, not lost', () => {
  const legacy = [{ type: 'user', content: 'old question' }, { type: 'bot', content: 'old answer' }];
  const migrated = migrateLegacyMessages(legacy, 'id1', 42);
  assert.equal(migrated.title, 'old question');
  assert.equal(migrated.messages.length, 2);
  assert.equal(migrated.updatedAt, 42);
});

test('migration trims to the per-conversation cap', () => {
  const legacy = Array.from({ length: 500 }, (_, i) => ({ type: 'user', content: 'm' + i }));
  assert.equal(migrateLegacyMessages(legacy, 'id', 0).messages.length, MAX_MESSAGES_PER_CONVERSATION);
});

test('nothing to migrate returns null rather than an empty chat', () => {
  assert.equal(migrateLegacyMessages([], 'id', 0), null);
  assert.equal(migrateLegacyMessages(null, 'id', 0), null);
  assert.equal(migrateLegacyMessages('not an array', 'id', 0), null);
});

const { conversationToMarkdown } = require('../chatlib.js');

test('a conversation copies out as readable markdown', () => {
  const md = conversationToMarkdown(
    [{ type: 'user', content: 'What is flexbox?' }, { type: 'bot', content: 'A layout model.' }],
    'Layout question'
  );
  assert.equal(md, '# Layout question\n\n## You\n\nWhat is flexbox?\n\n## Assistant\n\nA layout model.');
});

test('tool-activity and error notices stay out of the copy', () => {
  // These are the app talking to itself; pasting them into an issue is noise.
  const md = conversationToMarkdown([
    { type: 'user', content: 'read my readme' },
    { type: 'system', content: 'Reading "README.md" from me/demo' },
    { type: 'system', content: 'Error: No usage left for request.' },
    { type: 'bot', content: 'Here it is.' },
  ]);
  assert.ok(!md.includes('Reading "README.md"'));
  assert.ok(!md.includes('No usage left'));
  assert.ok(md.includes('read my readme'));
  assert.ok(md.includes('Here it is.'));
});

test('the title is optional and blank messages are skipped', () => {
  assert.equal(conversationToMarkdown([{ type: 'user', content: 'hi' }]), '## You\n\nhi');
  assert.equal(conversationToMarkdown([{ type: 'user', content: '   ' }]), '');
  assert.equal(conversationToMarkdown([]), '');
  assert.equal(conversationToMarkdown(null), '');
});

test('code fences survive the round trip intact', () => {
  const md = conversationToMarkdown([{ type: 'bot', content: '```js\nconst x = 1;\n```' }]);
  assert.ok(md.includes('```js\nconst x = 1;\n```'));
});
