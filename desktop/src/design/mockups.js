// The viralai mockup generator, ported (NEURA-070).
//
// What transfers, plainly: only the slide compositor. viralai's
// generate_carousel_image (backend/app/services/content_generator.py) draws a
// 1080x1080 card -- dark paper, a 12px accent bar whose hue comes from the
// text itself, the copy word-wrapped to measured width and centred in white
// 56px bold on a 70px rhythm -- and build_carousel_images maps it over a list
// of slides. That compositor is the mockup generator. Everything else in that
// repo (FastAPI, Celery, the platform copy prompts, Telegram/Slack approvals)
// is pipeline around it and stays where it is.
//
// Three things change in the port, each because the original is wrong or
// missing here:
//   1. Python's hash() is salted per process, so Pillow's accent hue changed
//      on every restart for the same text. The hue comes from FNV-1a instead:
//      the same idea (a colour derived from the copy), stable across runs.
//   2. The Pillow metrics are fixed at 56/70 whatever the canvas size, and
//      the width/height arguments are then ignored for type; here every
//      metric scales with width/1080, so the 1080x1350 and 1200x675 social
//      formats keep the same composition.
//   3. font_small was loaded and never drawn. Not carried over.
//
// The text is untrusted (it is model copy): LIMITS bound it, and wrap stops
// at the last fitting line with an ellipsis rather than running off the card.
//
// UMD (see social.js): pure planning plus one canvas painter. node tests use
// an arithmetic measure and a recorded context, so nothing here needs a
// browser.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UMockups = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var LIMITS = {
    /** Characters of copy per slide. */
    text: 2000,
    /** Wrapped lines kept on the card; the rest is elided. */
    lines: 12,
    /** Slides in one carousel (the ZIP export is the bound that matters). */
    slides: 30,
  };

  // viralai's constants, on its 1080 square. Every other size scales from
  // these, so the square keeps the original composition exactly.
  var BASE = {
    width: 1080,
    height: 1080,
    paper: '#1e1e1e', // PIL color=(30, 30, 30)
    ink: '#ffffff',
    bar: 12,
    margin: 80,
    size: 56,
    lineHeight: 70,
    weight: 'bold',
    family: 'sans-serif',
  };

  /** FNV-1a: the stable stand-in for Python's salted hash(). */
  function hash32(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /** colorsys.hsv_to_rgb(hash % 360 / 360, 0.6, 0.5) -- viralai's exact s and v. */
  function accentFor(text) {
    var hue = (hash32(String(text)) % 360) / 360;
    var s = 0.6;
    var v = 0.5;
    var i = Math.floor(hue * 6);
    var f = hue * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    var rgb;
    switch (i % 6) {
      case 0: rgb = [v, t, p]; break;
      case 1: rgb = [q, v, p]; break;
      case 2: rgb = [p, v, t]; break;
      case 3: rgb = [p, q, v]; break;
      case 4: rgb = [t, p, v]; break;
      default: rgb = [v, p, q]; break;
    }
    var hex = rgb
      .map(function (c) {
        var n = Math.round(c * 255).toString(16);
        return n.length === 1 ? '0' + n : n;
      })
      .join('');
    return '#' + hex;
  }

  /**
   * viralai's greedy wrap: grow a line while it fits the measured width, then
   * start the next. Past LIMITS.lines the tail is dropped and the last kept
   * line takes an ellipsis, so a long copy never runs off the card.
   * `widthOf(line)` returns a pixel width.
   */
  function wrap(text, maxWidth, widthOf) {
    var words = String(text).split(/\s+/).filter(Boolean);
    var lines = [];
    var current = [];
    for (var i = 0; i < words.length; i += 1) {
      var test = current.concat([words[i]]).join(' ');
      if (current.length === 0 || widthOf(test) <= maxWidth) current.push(words[i]);
      else {
        lines.push(current.join(' '));
        current = [words[i]];
      }
    }
    if (current.length) lines.push(current.join(' '));
    if (lines.length > LIMITS.lines) {
      lines = lines.slice(0, LIMITS.lines);
      lines[LIMITS.lines - 1] += '…';
    }
    return lines;
  }

  /**
   * The slide as pure numbers: colours, the accent bar, and every line placed
   * at its measured x (centred) and y (the 70px rhythm, block centred).
   * `measure(text, size, weight)` returns a pixel width -- the browser passes
   * canvas measureText, the tests pass arithmetic.
   */
  function plan(spec, measure) {
    spec = spec || {};
    var text = String(spec.text == null ? '' : spec.text).slice(0, LIMITS.text);
    var width = Math.max(1, Math.min(4096, spec.width || BASE.width));
    var height = Math.max(1, Math.min(4096, spec.height || BASE.height));
    var scale = width / BASE.width;
    var size = BASE.size * scale;
    var lineHeight = BASE.lineHeight * scale;
    var margin = BASE.margin * scale;
    var bar = BASE.bar * scale;
    var widthOf = function (line) {
      return measure(line, size, BASE.weight);
    };
    var lines = wrap(text, width - margin * 2, widthOf);
    var y = Math.floor(height / 2 - (lines.length * lineHeight) / 2);
    var placed = lines.map(function (line) {
      var x = Math.floor((width - widthOf(line)) / 2);
      var out = { text: line, x: x, y: y };
      y += lineHeight;
      return out;
    });
    return {
      width: width,
      height: height,
      paper: spec.paper || BASE.paper,
      ink: spec.ink || BASE.ink,
      accent: spec.accent || accentFor(text),
      bar: bar,
      margin: margin,
      font: { size: size, weight: BASE.weight, family: BASE.family },
      lineHeight: lineHeight,
      lines: placed,
    };
  }

  /** A whole carousel: one plan per slide (viralai's build_carousel_images). */
  function carousel(texts, spec, measure) {
    var list = Array.isArray(texts) ? texts.slice(0, LIMITS.slides) : [];
    return list.map(function (text) {
      return plan(Object.assign({}, spec, { text: text }), measure);
    });
  }

  /**
   * The painter. textBaseline 'top' because the plan places lines the way
   * Pillow does: y is the top of the line box, not the baseline.
   */
  function paint(ctx, p) {
    ctx.fillStyle = p.paper;
    ctx.fillRect(0, 0, p.width, p.height);
    ctx.fillStyle = p.accent;
    ctx.fillRect(0, 0, p.width, p.bar);
    ctx.fillStyle = p.ink;
    ctx.font = p.font.weight + ' ' + p.font.size + 'px ' + p.font.family;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (var i = 0; i < p.lines.length; i += 1) {
      ctx.fillText(p.lines[i].text, p.lines[i].x, p.lines[i].y);
    }
  }

  return {
    LIMITS: LIMITS,
    BASE: BASE,
    hash32: hash32,
    accentFor: accentFor,
    wrap: wrap,
    plan: plan,
    carousel: carousel,
    paint: paint,
  };
});
