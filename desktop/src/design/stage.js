// The canvas stage: device presets, the browser-chrome frame, and deck mode.
//
// A preset is the CSS size the page is laid out at; "Fit" scales it down into
// the stage (never up). Deck mode lays the page out on a fixed stage -- 1920x1080
// for a talk, the platform's own size for a social carousel -- letterboxed and
// scaled to fit, one <section class="slide"> at a time. The frame reports
// neura:deck {index, count}; the studio asks for neura:deck-go {index}.
//
// UMD (see chats.js); pure numbers, node-tested.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UStage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var PRESETS = {
    phone: { label: 'Phone', width: 390, height: 844, frame: 'phone' },
    tablet: { label: 'Tablet', width: 834, height: 1194, frame: 'tablet' },
    desktop: { label: 'Desktop', width: 1440, height: 900, frame: 'none' },
    browser: { label: 'Browser', width: 1440, height: 900, frame: 'browser' },
    deck: { label: 'Deck', width: 1920, height: 1080, frame: 'deck' },
  };
  /** Height of the drawn browser chrome (tab strip + address bar), in CSS px. */
  var CHROME_HEIGHT = 40;
  /** The padding kept around a fitted device on the stage. */
  var GUTTER = 32;

  /** The deck stage for a format: its own size when it has one, else 16:9 1080p. */
  function deckSize(format) {
    var w = Number(format && format.width);
    var h = Number(format && format.height);
    var px = !format || !format.unit || format.unit === 'px';
    if (px && w >= 320 && h >= 320 && w <= 4096 && h <= 4096) return { width: w, height: h };
    return { width: PRESETS.deck.width, height: PRESETS.deck.height };
  }

  /** The preset with the deck stage resolved and the chrome's height included. */
  function device(id, format) {
    var p = PRESETS[id] || PRESETS.desktop;
    var size = id === 'deck' ? deckSize(format) : { width: p.width, height: p.height };
    return {
      id: PRESETS[id] ? id : 'desktop',
      label: p.label,
      frame: p.frame,
      width: size.width,
      height: size.height,
      // What the outer box needs: the page plus any chrome drawn around it.
      outerHeight: size.height + (p.frame === 'browser' ? CHROME_HEIGHT : 0),
    };
  }

  /** The scale that fits a device into a box, letterboxed: 0.1..1, never up. */
  function fitScale(box, dev) {
    var w = Number(box && box.w) || 0;
    var h = Number(box && box.h) || 0;
    var dw = Number(dev && dev.width) || 1;
    var dh = Number(dev && (dev.outerHeight || dev.height)) || 1;
    return Math.max(0.1, Math.min(1, (w - GUTTER) / dw, (h - GUTTER) / dh));
  }

  /** The slide index after a move, clamped to the deck. */
  function clampSlide(index, count, delta) {
    var n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return 0;
    var i = Math.floor(Number(index) || 0) + Math.floor(Number(delta) || 0);
    return Math.max(0, Math.min(n - 1, i));
  }

  /** How many <section class="slide"> a page has (the deck's artboards). */
  function countSlides(html) {
    var m = String(html || '').match(/<section\b[^>]*\bclass\s*=\s*["'][^"']*\bslide\b[^"']*["']/gi);
    return m ? m.length : 0;
  }

  /** "3 / 12", the counter under the stage. */
  function counter(index, count) {
    return count ? (clampSlide(index, count, 0) + 1) + ' / ' + count : '';
  }

  return {
    PRESETS: PRESETS,
    CHROME_HEIGHT: CHROME_HEIGHT,
    GUTTER: GUTTER,
    deckSize: deckSize,
    device: device,
    fitScale: fitScale,
    clampSlide: clampSlide,
    countSlides: countSlides,
    counter: counter,
  };
});
