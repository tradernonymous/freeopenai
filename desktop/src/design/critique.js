// The optional LLM critique, AFTER the deterministic gate (slop.js).
//
// The linter is the gate: free, instant, the same answer every time, shown
// first. The critique is a second opinion that costs a model call, so it is a
// button -- and it runs by itself after a draft only for cloud providers; a
// model on this PC (or a saved provider) is off by default, because a
// critique turn doubles the wait on a laptop GPU.
//
// The model answers in JSON: five scores 1-10 (hierarchy, typography, colour,
// spacing, originality) plus Keep / Fix / Quick wins. parse() is tolerant of
// fences and prose around the object and clamps everything it keeps;
// radar() lays the scores out as an SVG polygon.
//
// UMD (see chats.js); pure string and number work, node-tested.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UCritique = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var DIMENSIONS = [
    { id: 'hierarchy', label: 'Hierarchy' },
    { id: 'typography', label: 'Typography' },
    { id: 'color', label: 'Colour' },
    { id: 'spacing', label: 'Spacing' },
    { id: 'originality', label: 'Originality' },
  ];
  var MAX_ITEMS = 5;

  function text(value) {
    return String(value == null ? '' : value);
  }

  /** On by default only for a cloud provider; local and saved providers opt in. */
  function defaultOn(tier, saved) {
    return tier === 'cloud' && !saved;
  }

  /** The critique turn: the page (clipped) and the deterministic findings already known. */
  function messages(opts) {
    var o = opts || {};
    var html = text(o.html);
    var clip = o.tier === 'local' ? 16000 : 40000;
    if (html.length > clip) html = html.slice(0, clip) + '\n<!-- [truncated] -->';
    var known = (o.findings || []).map(function (f) { return '- ' + f.label + (f.detail ? ' (' + f.detail + ')' : ''); }).join('\n');
    return [
      {
        role: 'system',
        content: [
          'You are a demanding senior designer reviewing one HTML page for NeuraOS Design.',
          'Score it 1-10 on five dimensions: hierarchy, typography, color, spacing, originality. 5 is competent; 8+ is rare and earned.',
          'Then list what to Keep (strengths), what to Fix (the problems that matter most) and Quick wins (small changes with a big effect), at most 5 each, each one short and specific to THIS page (name the element).',
          'Reply with ONLY a JSON object, no prose: {"scores":{"hierarchy":6,"typography":5,"color":7,"spacing":6,"originality":4},"keep":["..."],"fix":["..."],"quickWins":["..."]}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: (known ? 'The automatic checks already flagged:\n' + known + '\n\n' : '') + 'Page:\n```html\n' + html + '\n```',
      },
    ];
  }

  function list(value) {
    return (Array.isArray(value) ? value : []).map(function (x) { return text(x).replace(/\s+/g, ' ').trim().slice(0, 200); }).filter(Boolean).slice(0, MAX_ITEMS);
  }

  /** The critique in a reply, clamped -- or null when there is no usable object. */
  function parse(reply) {
    var src = text(reply);
    var fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(src);
    if (fenced) src = fenced[1];
    var start = src.indexOf('{');
    var end = src.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    var obj;
    try { obj = JSON.parse(src.slice(start, end + 1)); } catch { return null; }
    if (!obj || typeof obj !== 'object') return null;
    var raw = obj.scores && typeof obj.scores === 'object' ? obj.scores : obj;
    var scores = {};
    var found = 0;
    DIMENSIONS.forEach(function (d) {
      var v = Number(raw[d.id] != null ? raw[d.id] : d.id === 'color' ? raw.colour : undefined);
      if (isFinite(v)) found += 1;
      scores[d.id] = isFinite(v) ? Math.max(1, Math.min(10, Math.round(v))) : 1;
    });
    if (found < 3) return null;
    return {
      scores: scores,
      keep: list(obj.keep),
      fix: list(obj.fix),
      quickWins: list(obj.quickWins || obj.quick_wins || obj.quickwins),
      average: Math.round(DIMENSIONS.reduce(function (s, d) { return s + scores[d.id]; }, 0) / DIMENSIONS.length * 10) / 10,
    };
  }

  function point(i, value, size) {
    // 40px kept round the 10-ring for the axis labels.
    var r = (size / 2 - 40) * (value / 10);
    var angle = -Math.PI / 2 + (i * 2 * Math.PI) / DIMENSIONS.length;
    return [Math.round((size / 2 + r * Math.cos(angle)) * 10) / 10, Math.round((size / 2 + r * Math.sin(angle)) * 10) / 10];
  }

  /** The radar's geometry: the score polygon, the 10-ring and 5-ring, and the axis label spots. */
  function radar(scores, size) {
    var s = size || 200;
    var join = function (pts) { return pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' '); };
    return {
      size: s,
      polygon: join(DIMENSIONS.map(function (d, i) { return point(i, (scores && scores[d.id]) || 0, s); })),
      ring: join(DIMENSIONS.map(function (_, i) { return point(i, 10, s); })),
      mid: join(DIMENSIONS.map(function (_, i) { return point(i, 5, s); })),
      axes: DIMENSIONS.map(function (d, i) {
        var end = point(i, 10, s);
        var label = point(i, 12.4, s);
        return { id: d.id, label: d.label, x: end[0], y: end[1], lx: label[0], ly: label[1], value: (scores && scores[d.id]) || 0 };
      }),
    };
  }

  return {
    DIMENSIONS: DIMENSIONS,
    MAX_ITEMS: MAX_ITEMS,
    defaultOn: defaultOn,
    messages: messages,
    parse: parse,
    radar: radar,
  };
});
