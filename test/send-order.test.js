// The image-edit pass reordered sendMessage so that `imageAction(...)` read
// `attachedImageFile` before its `const` declaration. That is a temporal dead
// zone: every sendMessage() call threw ReferenceError before doing anything,
// and the whole UI went dead -- Enter, the send button, all of it. No stub
// harness can catch a TDZ (the error happens on any execution), so this test
// reads the shipped source: the attachment reads must sit above the image
// decision that consumes them, and the composer path must still be first.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, sourceOf } = require('./helpers/index-html.js');

// The page defines sendMessage inside a <script> block; the shared extractor
// finds it the same way every other wiring test does.
const send = sourceOf('sendMessage');

test('sendMessage reads the attachment before the image decision consumes it', () => {
  // The exact reads that were once below the declaration that feeds them.
  const attachmentRead = send.indexOf('const attachedImageFile =');
  const imageActionCall = send.indexOf('imageAction(raw,');
  assert.notEqual(attachmentRead, -1, 'sendMessage still reads pendingAttachment into attachedImageFile');
  assert.notEqual(imageActionCall, -1, 'sendMessage still consults imageAction()');
  assert.ok(
    attachmentRead < imageActionCall,
    'attachedImageFile is declared after imageAction() reads it -- that is the TDZ that killed the send button',
  );
});

test('the composer command path still runs before the attachment reads', () => {
  // Commands (/help, /compact, ...) answer without touching attachments, so
  // their position is also the earliest possible escape hatch: a regression
  // that hoists attachment handling above it changes what /help costs.
  const commandGate = send.indexOf('resolveComposerCommand(raw)');
  const attachmentRead = send.indexOf('const attachedImageFile =');
  assert.notEqual(commandGate, -1, 'sendMessage still routes commands through resolveComposerCommand');
  assert.ok(commandGate < attachmentRead, 'resolveComposerCommand must run before attachment handling');
});

test('the page still binds Enter and the send button to sendMessage', () => {
  // The keyboard path and the button path are separate; both must reach the
  // same function, or one input dies while tests on the other stay green.
  assert.match(HTML, /onkeydown="handleKeyDown\(event\)"/, 'the textarea lost its key handler');
  assert.match(HTML, /e\.key === 'Enter' && !e\.shiftKey[\s\S]{0,80}sendMessage\(\)/, 'Enter no longer calls sendMessage');
  assert.match(HTML, /id="sendButton"[\s\S]{0,200}?onclick="isTyping \? stopGeneration\(\) : sendMessage\(\)"/, 'the send button no longer calls sendMessage');
});
