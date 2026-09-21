// The scroll policy, wired to the page.
//
// The rules are unit-tested in transcript.test.js; this file is about the
// wiring -- that a streamed chunk which arrives while the reader is reading
// above the fold leaves them where they are, that the pill appears with a count
// of what landed, and that tapping it puts them back. A rule nothing calls, or a
// pill nothing fills in, is a feature that looks finished in a diff and does
// nothing at runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  transcriptAtBottom,
  shouldFollowTranscript,
  announcesUnread,
  TRANSCRIPT_BOTTOM_SLACK_PX,
} = require('../chatlib.js');
const { HTML, loadFromIndex, assertScannerCanRead, assertSandboxCovers } = require('./helpers/index-html.js');
const fs = require('node:fs');
const path = require('node:path');
// The resize/rotation policy now lives in the transcript module, so its source
// is read there rather than from the page.
const TRANSCRIPT_MODULE = fs.readFileSync(path.join(__dirname, '..', 'transcript-controller.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const NAMES = [
  'updateScrollBottomPill',
  'setTranscriptPinned',
  'appendToTranscript',
  'scrollTranscript',
  'pinTranscriptToBottom',
  'jumpToNewest',
];

function harness({ pinned = true, typing = false, grows = 0 } = {}) {
  const label = { textContent: 'Newest' };
  const classes = new Set();
  const pill = {
    classes,
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    querySelector: (selector) => (selector === '.scroll-bottom-label' ? label : null),
  };
  const appended = [];
  const transcript = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    writes: 0,
    appendChild(el) {
      appended.push(el);
      // Appending grows the content, which is what makes "at the bottom" a
      // moving target and the pin worth having.
      transcript.scrollHeight += 100;
    },
  };
  Object.defineProperty(transcript, 'scrollTop', {
    get() { return this._top || 0; },
    set(value) {
      this._top = value;
      this.writes += 1;
      // `grows` stands in for the lazily laid out bubbles below the fold: each
      // write to the maximum reveals more of them, which moves the maximum.
      this.scrollHeight += grows;
    },
  });
  const deps = {
    transcriptAtBottom,
    shouldFollowTranscript,
    announcesUnread,
    TRANSCRIPT_BOTTOM_SLACK_PX,
    transcriptPinned: pinned,
    unreadWhileDetached: 0,
    isTyping: typing,
    chatMessages: transcript,
    // Runs the frame callback immediately, so a settle loop is testable in the
    // same tick. The real one defers to the next frame.
    requestAnimationFrame: (fn) => { fn(); },
    document: { getElementById: (id) => (id === 'scrollBottom' ? pill : null) },
  };
  const loaded = loadFromIndex(NAMES, deps);
  return { ...loaded, deps, transcript, pill, label, classes, appended };
}

test('the extracted source is the shipped one, and the sandbox covers it', () => {
  assertScannerCanRead(NAMES);
  assertSandboxCovers(NAMES, harness().deps);
});

test('a pinned transcript follows the newest output', () => {
  const h = harness({ pinned: true });
  h.appendToTranscript({}, 'follow');
  assert.equal(h.transcript.scrollTop, h.transcript.scrollHeight, 'a pinned reader stays on the newest line');
  assert.equal(h.classes.has('visible'), false, 'nothing to jump back to, so no pill');
});

test('a detached transcript is left where the reader put it', () => {
  const h = harness({ pinned: false });
  const before = h.transcript.scrollTop;
  h.appendToTranscript({}, 'follow');
  assert.equal(h.transcript.scrollTop, before, 'this is the bug: a streamed chunk used to drag the reader down');
  assert.equal(h.deps.unreadWhileDetached, 1);
  assert.equal(h.classes.has('visible'), true);
  assert.equal(h.label.textContent, '1 new');

  h.appendToTranscript({}, 'system');
  assert.equal(h.deps.unreadWhileDetached, 2);
  assert.equal(h.label.textContent, '2 new');
});

test('the reader\'s own message and the typing indicator are not output they missed', () => {
  const h = harness({ pinned: false });
  // Sending a message is the one thing allowed to move them -- they are waiting
  // for what it produces.
  h.appendToTranscript({}, 'own-message');
  assert.equal(h.transcript.scrollTop, h.transcript.scrollHeight, 'your own message lands on screen');
  assert.equal(h.deps.unreadWhileDetached, 0, 'and it is not counted as something you missed');
  // The state follows the scroll in the same turn. It used to wait for the
  // scroll event, which cannot fire until this function returns -- so the pill
  // sat over a transcript that was already at the bottom.
  assert.equal(h.deps.transcriptPinned, true, 'landing on the newest output re-pins');
  assert.equal(h.classes.has('visible'), false, 'and takes the pill away with it');

  // Detach again, then let a placeholder that removes itself arrive.
  h.deps.transcriptPinned = false;
  h.appendToTranscript({}, 'indicator');
  assert.equal(h.deps.unreadWhileDetached, 0);
});

test('a streamed reply that is already on screen obeys the pin too', () => {
  const h = harness({ pinned: true });
  h.scrollTranscript('follow');
  assert.equal(h.transcript.scrollTop, h.transcript.scrollHeight);

  h.deps.transcriptPinned = false;
  const before = h.transcript.scrollTop;
  h.scrollTranscript('follow');
  assert.equal(h.transcript.scrollTop, before, 'the flush interval must not fight the reader');
});

test('the pill counts what is arriving while the turn still runs', () => {
  // Nothing has landed yet, but output is on its way -- "Newest" would be a
  // lie about a reply that is being written.
  const h = harness({ pinned: false, typing: true });
  h.updateScrollBottomPill();
  assert.equal(h.label.textContent, 'New output');

  // With a count in hand, the count wins: it answers whether it is worth going
  // back down.
  h.deps.unreadWhileDetached = 3;
  h.updateScrollBottomPill();
  assert.equal(h.label.textContent, '3 new');
});

test('jumping back down clears the count and hides the pill', () => {
  const h = harness({ pinned: false });
  h.appendToTranscript({}, 'follow');
  assert.equal(h.classes.has('visible'), true);

  h.jumpToNewest();
  assert.equal(h.deps.transcriptPinned, true);
  assert.equal(h.deps.unreadWhileDetached, 0);
  assert.equal(h.transcript.scrollTop, h.transcript.scrollHeight);
  assert.equal(h.classes.has('visible'), false, 'the way back is gone once you are back');
});

test('scrolling back to the bottom yourself re-pins, and scrolling away detaches', () => {
  const h = harness({ pinned: true });
  // Mid-transcript: 160px from the top of 1000px of content in a 400px window.
  h.transcript.scrollTop = 160;
  assert.equal(transcriptAtBottom(h.transcript.scrollTop, h.transcript.scrollHeight, h.transcript.clientHeight), false);
  h.setTranscriptPinned(false);
  assert.equal(h.classes.has('visible'), true);

  h.transcript.scrollTop = h.transcript.scrollHeight - h.transcript.clientHeight;
  h.setTranscriptPinned(transcriptAtBottom(h.transcript.scrollTop, h.transcript.scrollHeight, h.transcript.clientHeight));
  assert.equal(h.deps.transcriptPinned, true);
  assert.equal(h.classes.has('visible'), false);
  // And a transcript too short to scroll never reads as detached in the first
  // place, or the first few messages of a conversation would stop following.
  assert.equal(transcriptAtBottom(0, 200, 400), true);
});

test('a jump to the bottom settles instead of landing at a stale maximum', () => {
  // Lazy layout means the maximum moves after the write that aimed at it, which
  // is how a jump to the newest output stops a few lines short.
  // A maximum that does not move takes the write, plus one settle that finds
  // nothing left to chase and stops.
  const still = harness({ pinned: true, grows: 0 });
  still.pinTranscriptToBottom();
  assert.equal(still.transcript.writes, 2);

  // A reader who is not following is moved once -- the write they asked for --
  // and the settle stops there rather than chasing them.
  const detached = harness({ pinned: false, grows: 500 });
  detached.pinTranscriptToBottom();
  assert.equal(detached.transcript.writes, 1);

  // A maximum that keeps moving is chased, and chased no further than the bound
  // -- so a layout that never settles cannot spin forever.
  const moving = harness({ pinned: true, grows: 500 });
  moving.pinTranscriptToBottom();
  assert.equal(moving.transcript.writes, 13, 'one write plus twelve settles');
});

test('a rotation keeps a reader who was at the bottom at the bottom', () => {
  // Nothing tells the reader the re-layout happened; they just find themselves
  // at the top of an old reply. The transcript module owns the resize policy
  // now: it remembers the pin before the re-layout, waits out the scroll
  // events the layout itself fires, and rewrites the bottom on a settle timer
  // so the write lands on the layout it describes.
  assert.match(TRANSCRIPT_MODULE, /handleResize[\s\S]{0,400}wasPinned/, 'the controller has to remember the pin from before the layout');
  assert.match(TRANSCRIPT_MODULE, /layoutSettlingUntil = Date\.now\(\) \+ \d+/);
  assert.match(TRANSCRIPT_MODULE, /if \(wasPinned\) \{[\s\S]{0,160}pinToBottom\(\)/);
  // The scroll listener ignores the events the layout itself fires...
  assert.match(TRANSCRIPT_MODULE, /else if \(Date\.now\(\) < layoutSettlingUntil\) return;/);
  // ...and the write waits for the layout it describes.
  assert.match(TRANSCRIPT_MODULE, /if \(resizeTimer\) cancel\(resizeTimer\);[\s\S]{0,400}resizeTimer = 0/);
  // And the page delegates to it rather than keeping a second copy.
  assert.match(APP_JS, /transcriptController\.handleResize\(\)/);
});

test('the markup carries the id and the label the wiring looks for', () => {
  // The wiring asks for #scrollBottom and fills .scroll-bottom-label. If either
  // name drifts, the pill renders with its default text forever and nothing
  // fails -- which is exactly the shape of bug this file exists to catch.
  assert.match(HTML, /id="scrollBottom"/);
  assert.match(HTML, /class="scroll-bottom-label"/);
  assert.match(HTML, /onclick="jumpToNewest\(\)"/);

  // And the lookup is for the id the markup has.
  const asked = [];
  const h = harness({ pinned: false });
  h.deps.document.getElementById = (id) => {
    asked.push(id);
    return { classList: { toggle() {} }, querySelector: () => null };
  };
  h.updateScrollBottomPill();
  assert.deepEqual(asked, ['scrollBottom']);
});
