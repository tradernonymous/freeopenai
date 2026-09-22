// Design systems for the studio: a set of tokens plus a DESIGN.md that says
// how to use them. The model is told to style ONLY through these custom
// properties, which is what makes the rest cheap: Tweaks edits them live,
// variants are token swaps done here (no second generation on a local model),
// and a handoff ships tokens.css next to the page.
//
// The three presets are original and neutral on purpose. A brand extracted by
// the brand engine (brand.js) folds into the same shape; a DESIGN.md or
// tokens.css file can be imported.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UDesignSystems = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var STORE_KEY = 'freeai4u.design_systems';

  /** The token names every system defines and every generated page must use. */
  var TOKENS = ['--paper', '--ink', '--muted', '--accent', '--line', '--font-display', '--font-body', '--radius', '--space', '--measure'];

  var PRESETS = [
    {
      id: 'neutral-minimal',
      name: 'Neutral Minimal',
      notes: 'Quiet, warm-neutral surfaces; one green accent used sparingly; generous whitespace.',
      tokens: {
        '--paper': '#f6f5f1', '--ink': '#1b1c1a', '--muted': '#5d5f58', '--accent': '#2f6f4f', '--line': '#dcdad3',
        '--font-display': "Georgia, 'Times New Roman', serif", '--font-body': "'Segoe UI', system-ui, sans-serif",
        '--radius': '6px', '--space': '8px', '--measure': '68ch',
      },
    },
    {
      id: 'editorial',
      name: 'Editorial',
      notes: 'Magazine rhythm: serif display, strong rules between sections, a single brick accent for emphasis.',
      tokens: {
        '--paper': '#fbf8f3', '--ink': '#221f1a', '--muted': '#6a5e4f', '--accent': '#a63a24', '--line': '#e6dccd',
        '--font-display': "'Palatino Linotype', Palatino, 'Book Antiqua', serif", '--font-body': "Georgia, 'Times New Roman', serif",
        '--radius': '2px', '--space': '8px', '--measure': '64ch',
      },
    },
    {
      id: 'terminal',
      name: 'Terminal',
      notes: 'Dark, monospaced, dense; hairline borders; the accent is the prompt colour.',
      tokens: {
        '--paper': '#0f1411', '--ink': '#d7e3d4', '--muted': '#94a38f', '--accent': '#7fd49b', '--line': '#253028',
        '--font-display': "'Cascadia Mono', Consolas, monospace", '--font-body': "'Cascadia Mono', Consolas, monospace",
        '--radius': '0px', '--space': '6px', '--measure': '80ch',
      },
    },
  ];

  function byId(id, extra) {
    var all = PRESETS.concat(Array.isArray(extra) ? extra : []);
    for (var i = 0; i < all.length; i += 1) if (all[i].id === id) return all[i];
    return null;
  }

  function tokensCss(system) {
    var t = (system && system.tokens) || {};
    var lines = Object.keys(t).map(function (k) { return '  ' + k + ': ' + t[k] + ';'; });
    return ':root {\n' + lines.join('\n') + '\n}\n';
  }

  /** The nine-section DESIGN.md the model is handed and a handoff ships. */
  function designMd(system) {
    var s = system || PRESETS[0];
    var t = s.tokens || {};
    var row = function (k, what) { return '| `' + k + '` | `' + (t[k] || '') + '` | ' + what + ' |'; };
    return [
      '# DESIGN.md — ' + s.name,
      '',
      '## 1. Overview',
      s.notes || 'A small, strict system. Style only through the tokens below.',
      '',
      '## 2. Colour',
      '| Token | Value | Use |',
      '| :-- | :-- | :-- |',
      row('--paper', 'page background'),
      row('--ink', 'body text and headings'),
      row('--muted', 'secondary text, captions (still AA on paper)'),
      row('--accent', 'links, the one primary action, key numbers — sparingly'),
      row('--line', 'borders and rules'),
      '',
      '## 3. Typography',
      row('--font-display', 'headings'),
      row('--font-body', 'everything else'),
      'Scale: 0.875 / 1 / 1.25 / 1.563 / 1.953 / 2.441rem. Body 1rem at line-height 1.55; measure ' + (t['--measure'] || '68ch') + '.',
      '',
      '## 4. Spacing and layout',
      row('--space', 'the unit; every gap is a multiple (1, 2, 3, 4, 6, 8, 12)'),
      'One clear column for reading; grids only where content is genuinely parallel.',
      '',
      '## 5. Shape',
      row('--radius', 'corners on cards, inputs and buttons'),
      '',
      '## 6. Components',
      'Buttons: solid accent for the single primary action, outlined for the rest. Cards: one level, border in --line, no shadow stacks.',
      '',
      '## 7. Motion',
      'Short ease-out fades and moves (150–250ms). Nothing loops. Respect prefers-reduced-motion.',
      '',
      '## 8. Voice',
      'Plain, specific, confident. Real copy — names, numbers, verbs — never placeholder text.',
      '',
      "## 9. Don'ts",
      'No colour outside the tokens. No gradient washes. No emoji as icons. No pure black or pure white. No cards inside cards. Every interactive element has a visible :focus-visible style.',
      '',
    ].join('\n');
  }

  function hexToHsl(hex) {
    var m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var h = m[1].length === 3 ? m[1].split('').map(function (c) { return c + c; }).join('') : m[1];
    var r = parseInt(h.slice(0, 2), 16) / 255;
    var g = parseInt(h.slice(2, 4), 16) / 255;
    var b = parseInt(h.slice(4, 6), 16) / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var s = 0;
    var hue = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
    }
    return { h: hue, s: s, l: l };
  }

  function hslToHex(hsl) {
    var h = ((hsl.h % 360) + 360) % 360 / 360;
    var s = Math.min(1, Math.max(0, hsl.s));
    var l = Math.min(1, Math.max(0, hsl.l));
    function channel(t) {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var rgb = s === 0 ? [l, l, l] : [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
    return '#' + rgb.map(function (c) { return ('0' + Math.round(c * 255).toString(16)).slice(-2); }).join('');
  }

  function shift(hex, change) {
    var hsl = hexToHsl(hex);
    if (!hsl) return hex;
    return hslToHex({ h: hsl.h + (change.h || 0), s: hsl.s + (change.s || 0), l: hsl.l + (change.l || 0) });
  }

  function scaleLength(value, factor) {
    var m = /^(-?\d*\.?\d+)(px|rem|em)$/.exec(String(value || ''));
    if (!m) return value;
    var n = Math.round(Number(m[1]) * factor * 100) / 100;
    return n + m[2];
  }

  /** A brand from the brand engine, as a system. */
  function fromBrand(brand, name) {
    var roles = (brand && brand.roles) || {};
    var base = PRESETS[0].tokens;
    var tokens = Object.assign({}, base, {
      '--paper': roles.paper || base['--paper'],
      '--ink': roles.ink || base['--ink'],
      '--muted': roles.muted || base['--muted'],
      '--accent': roles.accent || base['--accent'],
    });
    if (brand && brand.fontStack) tokens['--font-body'] = String(brand.fontStack).replace(/[;{}<]/g, '').slice(0, 120);
    tokens['--line'] = shift(tokens['--paper'], { l: hexToHsl(tokens['--paper']) && hexToHsl(tokens['--paper']).l > 0.5 ? -0.12 : 0.12 });
    return { id: 'brand', name: (name ? name + ' brand' : 'Brand') , notes: 'Extracted from ' + ((brand && brand.url) || 'a page') + '.', tokens: tokens };
  }

  /** Every `--name: value` in a DESIGN.md or tokens.css. */
  function parseTokens(source) {
    var out = {};
    var text = String(source || '');
    var m;
    // DESIGN.md's own table rows: | `--accent` | `#0b7285` | ...
    var row = /\|\s*`(--[\w-]+)`\s*\|\s*`([^`]+)`/g;
    while ((m = row.exec(text))) out[m[1]] = m[2].trim();
    // CSS declarations: --accent: #0b7285;
    var decl = /(--[\w-]+)\s*:\s*([^;`|\n}]+)/g;
    while ((m = decl.exec(text))) {
      var value = m[2].trim();
      if (value) out[m[1]] = value;
    }
    return out;
  }

  /** An imported file as a system: its tokens over the neutral base. */
  function importSystem(source, name) {
    var found = parseTokens(source);
    if (!Object.keys(found).length) return null;
    var title = /^#\s*(?:DESIGN\.md\s*[—-]\s*)?(.+)$/m.exec(String(source || ''));
    var label = (name || (title && title[1]) || 'Imported').trim().slice(0, 40);
    return {
      id: 'import:' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: label,
      notes: 'Imported from a file.',
      tokens: Object.assign({}, PRESETS[0].tokens, found),
      source: String(source).slice(0, 20000),
    };
  }

  function readStore(store) {
    try {
      var s = store || (typeof globalThis !== 'undefined' && globalThis.localStorage);
      var list = JSON.parse((s && s.getItem(STORE_KEY)) || '[]');
      return Array.isArray(list) ? list.filter(function (x) { return x && x.id && x.tokens; }) : [];
    } catch {
      return [];
    }
  }

  function saveImported(system, store) {
    var list = readStore(store).filter(function (x) { return x.id !== system.id; });
    list.unshift(system);
    try {
      var s = store || (typeof globalThis !== 'undefined' && globalThis.localStorage);
      if (s) s.setItem(STORE_KEY, JSON.stringify(list.slice(0, 12)));
    } catch { /* the session keeps it */ }
    return list.slice(0, 12);
  }

  /**
   * Three directions from one set of tokens, ordered by the book -> refined ->
   * novel, each with its caption. They are token swaps: on a local model the
   * page is generated once and these cost nothing.
   */
  function variants(tokens) {
    var t = Object.assign({}, tokens || PRESETS[0].tokens);
    var paperL = (hexToHsl(t['--paper']) || { l: 0.95 }).l;
    var refined = Object.assign({}, t, {
      '--accent': shift(t['--accent'], { s: -0.18, l: paperL > 0.5 ? -0.06 : 0.04 }),
      '--radius': scaleLength(t['--radius'], 0.5),
      '--space': scaleLength(t['--space'], 1.25),
    });
    var dark = paperL > 0.5;
    var novel = Object.assign({}, t, {
      '--paper': dark ? shift(t['--ink'], { l: 0.03 }) : shift(t['--ink'], { l: -0.02 }),
      '--ink': t['--paper'],
      '--muted': shift(t['--paper'], { l: dark ? -0.28 : 0.28 }),
      '--line': shift(t['--ink'], { l: dark ? 0.12 : -0.12 }),
      '--accent': shift(t['--accent'], { h: 150, l: dark ? 0.12 : -0.12 }),
      '--font-display': t['--font-body'],
      '--font-body': t['--font-display'],
    });
    return [
      { id: 'book', label: 'By the book', caption: 'The system exactly as written.', vars: t },
      { id: 'refined', label: 'Refined', caption: 'Quieter accent, tighter corners, more air.', vars: refined },
      { id: 'novel', label: 'Novel', caption: 'Inverted surface, complementary accent, swapped type roles.', vars: novel },
    ];
  }

  return {
    STORE_KEY: STORE_KEY,
    TOKENS: TOKENS,
    PRESETS: PRESETS,
    byId: byId,
    tokensCss: tokensCss,
    designMd: designMd,
    fromBrand: fromBrand,
    parseTokens: parseTokens,
    importSystem: importSystem,
    readStore: readStore,
    saveImported: saveImported,
    variants: variants,
    hexToHsl: hexToHsl,
    hslToHex: hslToHex,
  };
});
