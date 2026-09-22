// The anti-slop linter: deterministic rules a demanding reviewer applies to
// generated HTML/CSS, checked before the user ever sees a design. Pure text
// analysis -- regexes over the artifact -- so it runs in tests and in the app
// unchanged, and every finding names its fix rather than just its sin.
(function (root, factory) {
  // Unconditional global publish -- see chats.js for why the traditional
  // fallback-branch UMD shape breaks in a Vite production bundle.
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4USlop = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RULES = [
    {
      id: 'gradient-splash',
      label: 'Purple-blue gradient hero',
      why: 'The default AI look: a purple-to-blue gradient says nothing about the brand.',
      test: (src) => {
        const gradients = String(src).match(/linear-gradient\([^)]*\)/gi) || [];
        const purple = /(purple|#7c3aed|#8000ff|#6366f1|#8b5cf6|violet)/i;
        const blue = /(blue|#3b82f6|#2563eb|#1d4ed8|#60a5fa)/i;
        return gradients.some((g) => purple.test(g) && blue.test(g));
      },
      fix: 'Use the extracted brand palette; one accent, not a gradient.',
    },
    {
      id: 'gradient-count',
      label: 'More than three gradients on one page',
      why: 'Gradients everywhere flatten hierarchy and read as generated.',
      test: (src) => (src.match(/gradient\(/g) || []).length > 3,
      fix: 'Keep at most three; flat color does most of the work.',
    },
    {
      id: 'inter-display',
      label: 'Inter as the display face',
      why: 'Inter is a fine UI font and a forgettable headline font.',
      test: (src) => /font-family:[^;}]*\binter\b/i.test(src) && /<(h1|h2|title)[^>]*>/i.test(src),
      fix: 'Pick a display face with a point of view; keep Inter for body only if you must.',
    },
    {
      id: 'emoji-icons',
      label: 'Emoji standing in for icons',
      why: 'Emoji render differently on every machine and read as filler.',
      // An emoji alone in an element, or leading the label of a button, link,
      // list item or heading ("🚀 Fast setup") -- both are icon duty. Emoji in
      // running text or in code samples is left alone.
      test: (src) => {
        const withoutCode = src.replace(/```[\s\S]*?```/g, '').replace(/<(pre|code)[^>]*>[\s\S]*?<\/\1>/gi, '');
        const emoji = '(?:[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]\\uFE0F?)';
        const alone = new RegExp('<(span|div|button|i|a|li|p|td)[^>]*>\\s*' + emoji + '\\s*<\\/\\1>', 'u');
        const leading = new RegExp('<(button|a|li|h[1-6])[^>]*>\\s*' + emoji + '\\s+\\S', 'u');
        return alone.test(withoutCode) || leading.test(withoutCode);
      },
      fix: 'Use inline SVG icons; they inherit color and scale.',
    },
    {
      id: 'bounce-easing',
      label: 'Bounce/elastic easing',
      why: 'Bounce easing was charming in 2016; now it reads as a template.',
      test: (src) => /cubic-bezier\((0\.\d+,\s*){3}0\.\d+\)|ease-(in-out-)?bounce|elastic/i.test(src)
        && /cubic-bezier\(\s*0\.\d+\s*,\s*1\.(4|5|6|7|8)/i.test(src),
      fix: 'Use ease-out or a gentle custom curve; motion should calm, not perform.',
    },
    {
      id: 'gray-on-color',
      label: 'Low-contrast gray text on a colored background',
      why: 'Fails WCAG AA and looks washed out on brand surfaces.',
      test: (src) => /background(-color)?:\s*[^;]*(#(1-9a-f)?)\s*;?[^\n]*\n?[^\n]*color:\s*#(8|9|a)[0-9a-f]{2}(6?)/i.test(src),
      fix: 'Meet 4.5:1 against the surface -- check the contrast report in the brand panel.',
    },
    {
      id: 'card-in-card',
      label: 'Cards nested inside cards',
      why: 'A card inside a card has no edge left to cast; the layout blurs.',
      test: (src) => /class="[^"]*card[^"]*"[^>]*>\s*<[^>]*class="[^"]*card/i.test(src),
      fix: 'Flatten: one elevation level per region.',
    },
    {
      id: 'uniform-three-col',
      label: 'Three identical feature columns',
      why: 'The most-generated layout on earth; says nothing was decided.',
      test: (src) => {
        const grids = src.match(/grid-template-columns:\s*repeat\(\s*3\s*,/gi) || [];
        return grids.length >= 1 && /feature|services|benefit/i.test(src);
      },
      fix: 'Break the symmetry: one column wide, or vary the blocks deliberately.',
    },
    {
      id: 'generic-copy',
      label: 'Generic placeholder copy',
      why: '"Lorem ipsum" or "Your text here" shipped to production.',
      // A NEGATED mention is an instruction, not shipped copy: a design prompt
      // that says "no lorem ipsum" is asking for the opposite of this rule, and
      // flagging it made the linter unusable on its own prompts. Only an
      // unqualified occurrence is the sin this catches.
      test: (src) => {
        const re = /lorem ipsum|your (text|content) here|placeholder text/gi;
        let match;
        while ((match = re.exec(String(src || '')))) {
          const before = String(src).slice(Math.max(0, match.index - 24), match.index).toLowerCase();
          if (/\b(no|not|never|without|avoid|instead of)\W*$/.test(before)) continue;
          return true;
        }
        return false;
      },
      fix: 'Write one real sentence per block, in the brand voice.',
    },
    // The rules below judge a finished page (Phase 4.11's quality gate), so
    // they only look at a full HTML document -- a snippet of CSS in a source
    // file is not a design and must not be graded as one.
    {
      id: 'pure-black-white',
      label: 'Pure black or pure white',
      why: '#000 on #fff is harsher than any printed page and reads as unconsidered.',
      test: (src) => isDoc(src) && /(?:^|[\s;{])(?:color|background(?:-color)?|fill|stroke|border(?:-color)?)\s*:\s*(?:#000(?:000)?|#fff(?:fff)?|black|white)\s*[;}!]/im.test(styleOf(src)),
      fix: 'Use the paper and ink tokens: an off-white and a near-black.',
    },
    {
      id: 'no-focus-style',
      label: 'No visible focus style',
      why: 'Keyboard users cannot see where they are; it fails WCAG 2.4.7.',
      test: (src) => isDoc(src) && /<(a|button|input|select|textarea)[\s>]/i.test(src) && !/:focus-visible/i.test(styleOf(src)),
      fix: 'Add a :focus-visible outline in the accent colour to links, buttons and fields.',
    },
    {
      id: 'untokened-colour',
      label: 'Colours outside the tokens',
      why: 'Literal colours scattered through the CSS drift from the system and defeat Tweaks.',
      test: (src) => {
        if (!isDoc(src)) return false;
        const css = styleOf(src);
        const tokens = (css.match(/:root\s*\{[^}]*\}/g) || []).join('');
        // A var(--token, #fallback) is traceable to its token; only bare literals count.
        const rest = css.replace(/:root\s*\{[^}]*\}/g, '').replace(/var\(\s*--[\w-]+\s*,[^)]*\)/g, '');
        const literal = new Set((rest.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || []).map((c) => c.toLowerCase()));
        return /--[\w-]+\s*:/.test(tokens) ? literal.size > 3 : literal.size > 6;
      },
      fix: 'Declare colours once as :root custom properties and use var(--token) everywhere else.',
    },
    {
      id: 'left-bar-card',
      label: 'Coloured left-bar cards',
      why: 'A thick coloured left border on every card is the most generated callout there is.',
      test: (src) => isDoc(src) && /border-left\s*:\s*([3-9]|\d{2})px\s+solid/i.test(styleOf(src)),
      fix: 'Separate with space or a hairline rule; emphasise with type, not a stripe.',
    },
    {
      id: 'off-scale-spacing',
      label: 'Spacing off the scale',
      why: 'Many one-off margins and gaps (13px, 22px, 37px) make the rhythm wobble.',
      test: (src) => {
        if (!isDoc(src)) return false;
        const odd = new Set();
        const re = /(?:margin|padding|gap)(?:-[a-z]+)?\s*:\s*([^;}]+)/gi;
        let m;
        while ((m = re.exec(styleOf(src)))) {
          (m[1].match(/\d+px/g) || []).forEach((v) => { if (parseInt(v, 10) % 4 !== 0) odd.add(v); });
        }
        return odd.size >= 5;
      },
      fix: 'Space in multiples of one unit (var(--space)): 4, 8, 12, 16, 24, 32…',
    },
    {
      id: 'banned-display-font',
      label: 'A default font as the display face',
      why: 'Poppins, Montserrat, Roboto and friends are the fonts every template ships with; as headlines they say nothing.',
      test: (src) => {
        if (!isDoc(src)) return false;
        const css = styleOf(src);
        const faces = [];
        const token = /--font-display\s*:\s*([^;}]+)/i.exec(css);
        if (token) faces.push(token[1]);
        const re = /(^|[}\s,>])(h1|h2|h3|\.display|\.hero[\w-]*)\b[^{}]*\{([^}]*)\}/gi;
        let m;
        while ((m = re.exec(css))) {
          const ff = /font-family\s*:\s*([^;}]+)/i.exec(m[3]);
          if (ff) faces.push(ff[1]);
        }
        const hit = faces.map(firstFamily).find((f) => BANNED_DISPLAY.includes(f));
        return hit ? hit : false;
      },
      fix: 'Use the system\'s --font-display (a serif or a face with character); keep default sans faces for body text if at all.',
    },
    {
      id: 'purple-wash',
      label: 'Purple gradient wash',
      why: 'A violet-to-anything gradient behind a section is the stock generated backdrop.',
      test: (src) => {
        const gradients = String(src).match(/(?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\)/gi) || [];
        const blue = /(blue|#3b82f6|#2563eb|#1d4ed8|#60a5fa)/i;
        // Purple AND blue together is gradient-splash's finding; this is the rest.
        return gradients.some((g) => !blue.test(g) && isPurpleGradient(g));
      },
      fix: 'Drop the wash: a flat var(--paper) surface, with the accent kept for one element.',
    },
    {
      id: 'contrast-fail',
      label: 'Text contrast below WCAG AA',
      why: 'A colour and background that resolve to less than 4.5:1 (3:1 for headings) are hard to read and fail WCAG 1.4.3.',
      test: (src) => {
        if (!isDoc(src)) return false;
        const fails = contrastFailures(styleOf(src));
        return fails.length ? fails.slice(0, 3).map((f) => f.where + ' ' + f.ratio + ':1').join('; ') : false;
      },
      fix: 'Darken the text or lighten the surface until the pair reaches 4.5:1; the brand panel shows each role\'s ratio.',
    },
  ];

  /** Display faces that read as "nobody chose this" in a headline. */
  const BANNED_DISPLAY = ['poppins', 'montserrat', 'roboto', 'open sans', 'lato', 'arial', 'helvetica', 'raleway', 'nunito', 'comic sans ms', 'papyrus', 'lobster', 'pacifico'];

  function firstFamily(stack) {
    return String(stack || '').split(',')[0].replace(/["']/g, '').replace(/!important/i, '').trim().toLowerCase();
  }

  // ---- colour, for the purple and contrast rules -----------------------------

  const NAMED = { black: '#000000', white: '#ffffff', red: '#ff0000', gray: '#808080', grey: '#808080', purple: '#800080', violet: '#ee82ee', indigo: '#4b0082', magenta: '#ff00ff', fuchsia: '#ff00ff', navy: '#000080', silver: '#c0c0c0' };

  /** '#rrggbb' from a hex, rgb() or a few names; null for anything else. */
  function hexOf(raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (NAMED[v]) return NAMED[v];
    let m = /^#([0-9a-f]{3})$/.exec(v);
    if (m) return '#' + m[1].split('').map((c) => c + c).join('');
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
    if (m) return m[2] && m[2] !== 'ff' ? null : '#' + m[1];
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
    if (m) {
      if (m[4] && parseFloat(m[4]) < (m[4].endsWith('%') ? 100 : 1)) return null;
      return '#' + [m[1], m[2], m[3]].map((n) => ('0' + Math.min(255, Number(n)).toString(16)).slice(-2)).join('');
    }
    return null;
  }

  function rgbOf(hex) {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  }

  function luminance(hex) {
    const [r, g, b] = rgbOf(hex).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function hueSat(hex) {
    const [r, g, b] = rgbOf(hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (!d) return { h: 0, s: 0 };
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    const l = (max + min) / 2;
    return { h, s: d / (1 - Math.abs(2 * l - 1)) };
  }

  function isPurpleGradient(g) {
    if (/\b(purple|violet|indigo|magenta|fuchsia)\b/i.test(g)) return true;
    const colours = g.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi) || [];
    return colours.some((c) => {
      const hex = hexOf(c);
      if (!hex) return false;
      const { h, s } = hueSat(hex);
      return h >= 255 && h <= 320 && s >= 0.35;
    });
  }

  /** A declared value as a solid colour, following var(--token, fallback) chains. */
  function resolve(value, tokens, depth) {
    const v = String(value || '').replace(/!important/i, '').trim();
    if ((depth || 0) > 6) return null;
    const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(v);
    if (ref) {
      if (tokens[ref[1]] != null) return resolve(tokens[ref[1]], tokens, (depth || 0) + 1);
      return ref[2] ? resolve(ref[2], tokens, (depth || 0) + 1) : null;
    }
    return hexOf(v);
  }

  /** The background colour a `background` shorthand sets, when it is one plain colour. */
  function backgroundColour(value, tokens) {
    const v = String(value || '').trim();
    if (/gradient\(|url\(/i.test(v)) return null;
    const direct = resolve(v, tokens);
    if (direct) return direct;
    const parts = v.match(/var\([^)]*\)|#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b/gi) || [];
    for (const part of parts) {
      const hex = resolve(part, tokens);
      if (hex) return hex;
    }
    return null;
  }

  /**
   * Colour/background pairs the CSS states outright -- in one rule, or the
   * system's own --ink/--muted on --paper -- that fall below AA.
   */
  function contrastFailures(css) {
    const source = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
    const tokens = {};
    const roots = source.match(/:root\s*\{[^}]*\}/g) || [];
    roots.forEach((block) => {
      const re = /(--[\w-]+)\s*:\s*([^;}]+)/g;
      let m;
      while ((m = re.exec(block))) tokens[m[1]] = m[2].trim();
    });
    const out = [];
    const paper = resolve('var(--paper)', tokens);
    ['--ink', '--muted'].forEach((role) => {
      const fg = resolve('var(' + role + ')', tokens);
      if (paper && fg) {
        const ratio = contrast(fg, paper);
        if (ratio < 4.5) out.push({ where: role + ' on --paper', ratio: Math.round(ratio * 100) / 100 });
      }
    });
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = rule.exec(source))) {
      const selector = m[1].trim();
      if (/^:root$|^@/.test(selector)) continue;
      const decls = {};
      m[2].split(';').forEach((d) => {
        const i = d.indexOf(':');
        if (i > 0) decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
      });
      if (!decls.color) continue;
      const bg = decls['background-color'] ? resolve(decls['background-color'], tokens) : decls.background ? backgroundColour(decls.background, tokens) : null;
      const fg = resolve(decls.color, tokens);
      if (!bg || !fg) continue;
      const ratio = contrast(fg, bg);
      const large = /(^|[\s,>])h[12]\b/i.test(selector);
      if (ratio < (large ? 3 : 4.5)) out.push({ where: selector.replace(/\s+/g, ' ').slice(0, 40), ratio: Math.round(ratio * 100) / 100 });
    }
    return out;
  }

  function isDoc(src) {
    return /<!doctype html|<html[\s>]/i.test(String(src || ''));
  }

  /** The page's CSS: every <style> block and every inline style attribute. */
  function styleOf(src) {
    const s = String(src || '');
    const blocks = (s.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join('\n');
    const inline = (s.match(/style="[^"]*"/gi) || []).map((a) => '{' + a.slice(7, -1) + '}').join('\n');
    return blocks + '\n' + inline;
  }

  /** Runs every rule over an HTML/CSS artifact -> findings with fixes. */
  function lint(source) {
    const src = String(source || '');
    const findings = [];
    for (const rule of RULES) {
      let hit = false;
      try { hit = rule.test(src); } catch { /* a broken rule stays silent */ }
      if (!hit) continue;
      const finding = { id: rule.id, label: rule.label, why: rule.why, fix: rule.fix };
      // A rule that can say WHERE (a selector, a ratio, a font) returns it.
      if (typeof hit === 'string') finding.detail = hit;
      findings.push(finding);
    }
    return findings;
  }

  /** Score: 100 with no findings; every finding costs its weight. */
  function score(source) {
    const findings = lint(source);
    const penalty = findings.reduce((sum, f) => sum + (f.id === 'gray-on-color' || f.id === 'contrast-fail' ? 20 : 12), 0);
    return { findings, score: Math.max(0, 100 - penalty) };
  }

  return { RULES, BANNED_DISPLAY, lint, score, contrastFailures, hexOf };
});
