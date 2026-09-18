// The share modal is the page's translator: the module reports what happened
// as a machine reason, the modal turns it into the sentence a person reads.
// A dictionary that drifts from the module's contract would collapse every
// failure into the generic "try again" line -- silent, and invisible to the
// module's own tests. So this pins the mapping: drive openShareModal against
// each reason and assert the exact sentence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFromIndex } = require('./helpers/index-html.js');

const NICE_URL = 'http://localhost:3000/s/abc123';

function modalHarness({ publishResult, convo }) {
  const overlay = { open: false, classList: { add(c) { if (c === 'open') this._o = true; }, remove(c) { if (c === 'open') this._o = false; }, contains() { return !!this._o; } } };
  const els = {
    shareOverlay: overlay,
    shareStatus: { textContent: '' },
    shareLinkBox: { value: '' },
    shareCopyBtn: { value: '' },
  };
  const deps = {
    document: { getElementById: (id) => els[id] || null },
    conversations: [convo],
    shareMemory: { publish: async () => publishResult },
    location: { origin: 'http://localhost:3000' },
  };
  const loaded = loadFromIndex(['openShareModal'], deps);
  return { run: () => loaded.openShareModal('c1'), status: els.shareStatus, box: els.shareLinkBox, overlay };
}

test('a successful publish fills the box with a link that includes the origin', async () => {
  const h = modalHarness({ publishResult: { ok: true, url: '/s/abc123' }, convo: { id: 'c1', title: 'T', messages: [{ type: 'user', content: 'x' }] } });
  await h.run();
  assert.equal(h.box.value, NICE_URL);
  assert.equal(h.status.textContent, 'Read-only link ready:');
});

test('every module failure reason gets its own honest sentence', async () => {
  const cases = [
    [{ ok: false, reason: 'busy' }, 'Already making a link…'],
    [{ ok: false, reason: 'empty' }, 'Nothing to share yet — send a message first.'],
    [{ ok: false, reason: 'too-large' }, 'This conversation is too large to share.'],
    [{ ok: false, reason: 'network' }, 'Sharing failed — the server did not answer.'],
    [{ ok: false, reason: 'server' }, 'Sharing failed — try again in a moment.'],
    [{ ok: false, reason: 'server', detail: 'Store is read-only' }, 'Store is read-only'],
    [{ ok: false, reason: 'martian' }, 'Sharing failed — try again in a moment.'],
  ];
  for (const [result, sentence] of cases) {
    const h = modalHarness({ publishResult: result, convo: { id: 'c1', title: 'T', messages: [{ type: 'user', content: 'x' }] } });
    await h.run();
    assert.equal(h.status.textContent, sentence, 'reason ' + JSON.stringify(result.reason) + ' must read as its own sentence');
  }
});

test('a conversation the page cannot find opens nothing at all', async () => {
  const h = modalHarness({ publishResult: { ok: true, url: '/s/x' }, convo: { id: 'c9', title: 'T', messages: [] } });
  await h.run();
  assert.equal(h.box.value, '');
  assert.equal(h.status.textContent, '', 'no status, no overlay fiddling: the modal simply never opened');
});
