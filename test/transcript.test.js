// Two decisions the transcript makes about what to keep and what to move.
//
// The scroll half is the one a person feels: a streamed reply used to drag them
// back to the bottom every 40ms, and a scroll-to-bottom control had no state to
// read. The image half is the one a person notices only when it is wrong -- a
// gallery with the prompt and no picture.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRANSCRIPT_BOTTOM_SLACK_PX,
  transcriptAtBottom,
  shouldFollowTranscript,
  announcesUnread,
  storedImagePlan,
  capConversationImages,
  stripStoredImages,
  MAX_STORED_IMAGES_PER_CONVERSATION,
} = require('../chatlib.js');

test('the bottom of the transcript is where the reader last was, not a rounding error', () => {
  // 1000px of content in a 400px window: scrolled to the very bottom.
  assert.equal(transcriptAtBottom(600, 1000, 400), true);
  // One line off the bottom still counts -- a fractional scrollHeight or a
  // device-pixel rounding must not read as the reader having scrolled away.
  assert.equal(transcriptAtBottom(600 - TRANSCRIPT_BOTTOM_SLACK_PX + 1, 1000, 400), true);
  // Genuinely up in the reply: the reader is reading, so this is a detach.
  assert.equal(transcriptAtBottom(160, 1000, 400), false);
  assert.equal(transcriptAtBottom(0, 1000, 400), false);
});

test('a transcript too short to scroll is always at the bottom', () => {
  // Otherwise the first few messages of a conversation would look detached and
  // the app would stop following the very output that fits on screen.
  assert.equal(transcriptAtBottom(0, 200, 400), true);
  assert.equal(transcriptAtBottom(0, 400, 400), true);
});

test('only the reader\'s own actions may move the transcript against them', () => {
  // The message they just sent, and something they asked for.
  assert.equal(shouldFollowTranscript('own-message', false), true);
  assert.equal(shouldFollowTranscript('user-request', false), true);
  // A streamed chunk, a tool notice, an image finishing: obey the pin.
  assert.equal(shouldFollowTranscript('follow', false), false);
  assert.equal(shouldFollowTranscript('follow', true), true);
  // An unknown source is treated as an ordinary follow, never as a jump.
  assert.equal(shouldFollowTranscript('', false), false);
  assert.equal(shouldFollowTranscript(undefined, false), false);
});

test('only output counts as something you missed', () => {
  // A tool line or a reply that landed is news.
  assert.equal(announcesUnread('follow'), true);
  assert.equal(announcesUnread('system'), true);
  // The typing indicator removes itself, and your own message is what you just
  // did -- neither is a thing to be told you missed.
  assert.equal(announcesUnread('indicator'), false);
  assert.equal(announcesUnread('own-message'), false);
  assert.equal(announcesUnread('user-request'), false);
  // An unknown source is treated as ordinary output, since that is the safe way
  // to be wrong: it says something arrived rather than hiding it.
  assert.equal(announcesUnread(''), true);
  assert.equal(announcesUnread(undefined), true);
});

test('an image is stored by link or re-encoded, and anything else is refused', () => {
  // A remote link is kept as it is: the bytes were never ours.
  assert.equal(storedImagePlan('https://cdn.example/a.png'), 'remote');
  assert.equal(storedImagePlan('http://cdn.example/a.png'), 'remote');
  // This is the case the gallery lost: every Puter image is a data URL.
  assert.equal(storedImagePlan('data:image/png;base64,AAAA'), 'encode');
  assert.equal(storedImagePlan('blob:http://x/9b1c'), 'encode');
  // Not an image at all -- a data:text/html or javascript: URL must never be
  // kept, and neither should an empty value.
  assert.equal(storedImagePlan('data:text/html,<script>'), 'skip');
  assert.equal(storedImagePlan('javascript:alert(1)'), 'skip');
  assert.equal(storedImagePlan(''), 'skip');
  assert.equal(storedImagePlan(null), 'skip');
});

test('the newest images stay and the oldest are dropped', () => {
  const messages = Array.from({ length: 5 }, (_, i) => ({
    type: 'bot',
    content: `[Generated image: p${i}]`,
    images: [{ url: `data:image/png;base64,${i}`, prompt: `p${i}` }],
  }));
  const capped = capConversationImages(messages, 2);
  assert.equal(capped.length, messages.length, 'the messages themselves are kept -- only their pictures go');
  assert.deepEqual(capped.map((m) => m.images.length), [0, 0, 0, 1, 1]);
  // The text placeholder still names the prompt, so a dropped picture is still
  // visible as something that was generated.
  assert.equal(capped[0].content, '[Generated image: p0]');

  // Under the cap nothing is touched, and neither is a message with no images.
  const few = [{ type: 'user', content: 'hi' }, messages[4]];
  assert.deepEqual(capConversationImages(few, 2).map((m) => m.images && m.images.length), [undefined, 1]);
  // A cap of zero is a real instruction, not an accident.
  assert.deepEqual(capConversationImages(messages, 0).map((m) => m.images.length), [0, 0, 0, 0, 0]);
});

test('when storage is full the pictures go before the history does', () => {
  const conversations = [
    { id: 'old', title: 'A', messages: [{ images: [{ url: 'data:image/png;base64,1' }] }, { content: 'text' }] },
    { id: 'active', title: 'B', messages: [{ images: [{ url: 'data:image/png;base64,2' }] }] },
  ];
  // First pass: everything except the chat the reader is looking at.
  const first = stripStoredImages(conversations, 'active');
  assert.equal(first[0].messages[0].images.length, 0);
  assert.equal(first[1].messages[0].images.length, 1, 'the active chat keeps its picture on the first pass');
  assert.equal(first[0].messages[1].content, 'text', 'text is never touched');
  assert.equal(conversations[0].messages[0].images.length, 1, 'the input is not mutated');

  // Second pass: no protection left.
  const second = stripStoredImages(conversations, '');
  assert.equal(second[1].messages[0].images.length, 0);

  // A conversation with no images is returned as the same object, so a write of
  // an unchanged list stays cheap.
  const plain = [{ id: 'x', messages: [{ content: 'hi' }] }];
  assert.equal(stripStoredImages(plain, 'x')[0], plain[0]);
  assert.ok(MAX_STORED_IMAGES_PER_CONVERSATION >= 1);
});
