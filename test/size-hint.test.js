// The size hint in the composer.
//
// The size a request carries is read out of the prompt, and the only place that
// showed it was the status line after the picture arrived — one turn too late to
// change anything, which is how "I asked for a size and got a square" survived
// being noticed. This is that reading, in the composer.
//
// What matters is that the hint cannot promise something the request will not
// send: it appears only for a turn the app would treat as image work, and with
// something attached it reads only a spelled-out size, because an attachment is
// what turns the turn into an edit and an edit ignores shape words.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  imageAction,
  imageSizeFromPrompt,
  imageSizeBody,
} = require('../chatlib.js');
const { loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const NAMES = ['imageAttachmentIsPending', 'imageWorkIsPossible', 'updateImageSizeHint'];

function stubHint() {
  return {
    hidden: true,
    textContent: '',
    title: '',
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    removeAttribute(name) { delete this.attrs[name]; },
    remove() { this.removed = true; },
  };
}

function harness({ text = '', imageMode = false, attachment = null } = {}) {
  const hint = stubHint();
  const deps = {
    // The real rules, so this exercises the shipped reading rather than a
    // description of it.
    imageAction,
    imageSizeFromPrompt,
    imageSizeBody,
    imageMode,
    pendingAttachment: attachment,
    chatInput: { value: text },
    document: { getElementById: (id) => (id === 'sizeHint' ? hint : null) },
  };
  return { deps, hint, loaded: loadFromIndex(NAMES, deps) };
}

const IMAGE_FILE = { kind: 'image', name: 'car.png' };
const TEXT_FILE = { kind: 'text', name: 'notes.md', content: 'hi' };

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('a shape in the words is shown while it can still be changed', () => {
  const h = harness({ text: 'draw a 16:9 banner for the shop front', imageMode: true });
  h.loaded.updateImageSizeHint();
  assert.equal(h.hint.hidden, false);
  assert.equal(h.hint.textContent, '16:9');
  // The pixels are the answer to "what size", so they are on the hint rather
  // than only in the code: the title on a pointer, the label for a screen
  // reader, and the status line after the picture arrives.
  assert.match(h.hint.title, /1536x864/);
  assert.match(h.hint.title, /16:9/);
  assert.equal(h.hint.getAttribute('aria-label'), 'Image size 16:9, drawn at 1536x864');
});

test('nothing asked for means no hint, at all', () => {
  for (const text of ['draw a fox', '', 'what is the weather']) {
    const h = harness({ text, imageMode: true });
    h.loaded.updateImageSizeHint();
    assert.equal(h.hint.hidden, true, `"${text}" promised a shape`);
    assert.equal(h.hint.textContent, '');
    assert.equal(h.hint.getAttribute('title'), undefined, 'a stale title is a hint that will not go away');
  }
});

test('a turn the app would not treat as image work is not promised a shape', () => {
  // "a 16:9 banner for the shop" with no draw request and no toggle is a chat
  // turn: the size in it is never sent anywhere, so showing it would be a lie of
  // the most annoying kind -- a hint about a picture that is not coming.
  const chat = harness({ text: 'a 16:9 banner for the shop', imageMode: false });
  chat.loaded.updateImageSizeHint();
  assert.equal(chat.hint.hidden, true);

  const forced = harness({ text: 'a 16:9 banner for the shop', imageMode: true });
  forced.loaded.updateImageSizeHint();
  assert.equal(forced.hint.hidden, false, 'the toggle is one of the ways a turn becomes image work');
});

test('an attachment reads only a spelled-out size, because it makes the turn an edit', () => {
  // "make it a tall wallpaper" attached to a photo is an instruction about that
  // photo, and the request follows the same rule: the edit reads 1536x1024 out
  // of "resize to 1536x1024" and ignores the shape words.
  const words = harness({ text: 'make it a tall phone wallpaper', imageMode: false, attachment: IMAGE_FILE });
  words.loaded.updateImageSizeHint();
  assert.equal(words.hint.hidden, true, 'a shape word is not a size an edit will send');

  const spelled = harness({ text: 'resize this to 1536x1024', imageMode: false, attachment: IMAGE_FILE });
  spelled.loaded.updateImageSizeHint();
  assert.equal(spelled.hint.hidden, false);
  assert.equal(spelled.hint.textContent, '3:2');

  // A text attachment is not a picture: the turn is still a generation, and the
  // generator reads shape words like it always did. Reading every attachment as
  // an edit would have hidden the shape from a prompt that is going to use it.
  const document = harness({ text: 'draw a tall poster', imageMode: true, attachment: TEXT_FILE });
  document.loaded.updateImageSizeHint();
  assert.equal(document.hint.hidden, false);
  assert.equal(document.hint.textContent, '2:3');
});

test('the hint lives in the row that already exists, and is styled as a hint', () => {
  // In the input row with the textarea and Send: a hint that costs a row of
  // height is a control, and the composer has enough of those.
  const row = HTML.indexOf('class="composer-input-row"');
  const input = HTML.indexOf('id="chatInput"');
  const hint = HTML.indexOf('id="sizeHint"');
  const send = HTML.indexOf('id="sendButton"');
  assert.ok(row !== -1 && input > row && hint > input && send > hint, 'the hint belongs between the input and Send');
  assert.match(HTML, /id="chatInput"[^>]*oninput="[^"]*updateImageSizeHint\(\)/, 'typing has to update it');
  const css = HTML.match(/\.size-hint \{[\s\S]*?\n        \}/);
  assert.ok(css, '.size-hint is gone -- re-point this test');
  assert.match(css[0], /font-size: 11px/, 'a hint is not a headline');
  assert.match(css[0], /white-space: nowrap/, 'the label is one token, not a paragraph');
  assert.doesNotMatch(css[0], /position: absolute|position: fixed/, 'the row owns its layout');
  assert.match(HTML, /\.size-hint\[hidden\] \{ display: none; \}/);
});
