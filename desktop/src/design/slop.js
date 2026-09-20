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
      test: (src) => {
        const withoutFences = src.replace(/```[\s\S]*?```/g, '');
        return /<(span|div|button)[^>]*>\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s*<\/\1>/u.test(withoutFences);
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
      test: (src) => /lorem ipsum|your (text|content) here|placeholder text/i.test(src),
      fix: 'Write one real sentence per block, in the brand voice.',
    },
  ];

  /** Runs every rule over an HTML/CSS artifact -> findings with fixes. */
  function lint(source) {
    const src = String(source || '');
    const findings = [];
    for (const rule of RULES) {
      let hit = false;
      try { hit = rule.test(src); } catch { /* a broken rule stays silent */ }
      if (hit) findings.push({ id: rule.id, label: rule.label, why: rule.why, fix: rule.fix });
    }
    return findings;
  }

  /** Score: 100 with no findings; every finding costs its weight. */
  function score(source) {
    const findings = lint(source);
    const penalty = findings.reduce((sum, f) => sum + (f.id === 'gray-on-color' ? 20 : 12), 0);
    return { findings, score: Math.max(0, 100 - penalty) };
  }

  return { RULES, lint, score };
});
