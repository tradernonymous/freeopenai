// The brand engine: palette extraction, semantic roles, WCAG AA contrast and
// the DESIGN.md contract. Pure functions on strings and arrays -- no DOM, no
// fetch -- so node:test can exercise every rule and the desktop imports the
// same code Vite bundles.
//
// UMD like the repo's other shared modules (share-memory.js, provider-routing.js):
// node gets module.exports, the browser build imports it through Vite.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FreeAI4UBrand = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- color parsing -------------------------------------------------------

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  /** '#rgb' | '#rrggbb' | 'rgb(r,g,b)' -> {r,g,b} | null. Never throws. */
  function parseColor(raw) {
    const s = String(raw || '').trim().toLowerCase();
    const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
    if (hex) {
      const h = hex[1];
      if (h.length === 3) {
        return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
      }
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    const rgb = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
    if (rgb) {
      return { r: clamp(+rgb[1], 0, 255), g: clamp(+rgb[2], 0, 255), b: clamp(+rgb[3], 0, 255) };
    }
    return null;
  }

  /** Relative luminance per WCAG 2.1 (sRGB, gamma-expanded). */
  function luminance(rgb) {
    const channel = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  /** The WCAG contrast ratio, 1:1 (same color) to 21:1 (black on white). */
  function contrastRatio(a, b) {
    const ca = parseColor(a);
    const cb = parseColor(b);
    if (!ca || !cb) return null;
    const la = luminance(ca);
    const lb = luminance(cb);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /** WCAG verdicts for a pair: normal text needs 4.5, large text 3.0, UI 3.0. */
  function contrastReport(fg, bg) {
    const ratio = contrastRatio(fg, bg);
    if (ratio == null) return { ratio: null, passAA: false, passAALarge: false, passAAA: false };
    return {
      ratio: Math.round(ratio * 100) / 100,
      passAA: ratio >= 4.5,
      passAALarge: ratio >= 3,
      passAAA: ratio >= 7,
    };
  }

  /** Nearest of the well-known CSS colors, so extracted values get names. */
  const NAMED = [
    ['black', '#000000'], ['white', '#ffffff'], ['red', '#ff0000'], ['green', '#008000'],
    ['blue', '#0000ff'], ['yellow', '#ffff00'], ['orange', '#ffa500'], ['purple', '#800080'],
    ['pink', '#ffc0cb'], ['brown', '#a52a2a'], ['gray', '#808080'], ['grey', '#808080'],
    ['navy', '#000080'], ['teal', '#008080'], ['olive', '#808000'], ['maroon', '#800000'],
    ['silver', '#c0c0c0'], ['lime', '#00ff00'], ['aqua', '#00ffff'], ['fuchsia', '#ff00ff'],
    ['beige', '#f5f5dc'], ['ivory', '#fffff0'], ['gold', '#ffd700'], ['indigo', '#4b0082'],
    ['coral', '#ff7f50'], ['crimson', '#dc143c'], ['khaki', '#f0e68c'], ['lavender', '#e6e6fa'],
  ];

  function colorName(raw) {
    const c = parseColor(raw);
    if (!c) return '';
    let best = '';
    let bestDist = Infinity;
    for (const [name, hex] of NAMED) {
      const n = parseColor(hex);
      const dist = Math.pow(c.r - n.r, 2) + Math.pow(c.g - n.g, 2) + Math.pow(c.b - n.b, 2);
      if (dist < bestDist) { bestDist = dist; best = name; }
    }
    return best;
  }

  // ---- palette extraction from a page -------------------------------------

  /** Pulls hex/rgb colors out of HTML or CSS text, most frequent first. */
  function paletteFromText(text, limit = 8) {
    const source = String(text || '');
    const counts = new Map();
    const bump = (raw) => {
      const c = parseColor(raw);
      if (!c) return;
      const key = '#' + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('');
      counts.set(key, (counts.get(key) || 0) + 1);
    };
    const hexes = source.match(/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g) || [];
    for (const h of hexes) bump(h);
    const rgbs = source.match(/rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/g) || [];
    for (const r of rgbs) bump(r);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([hex]) => hex);
  }

  /**
   * The DESIGN.md contract: dominant colors assigned to semantic roles.
   * paper = lightest, ink = darkest, accent = most saturated of the rest.
   */
  function semanticRoles(palette) {
    const colors = (palette || []).map(parseColor).filter(Boolean);
    if (!colors.length) return null;
    const scored = colors.map((c) => ({ ...c, hex: '#' + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join(''), lum: luminance(c) }));
    const sorted = scored.slice().sort((a, b) => b.lum - a.lum);
    const paper = sorted[0];
    const ink = sorted[sorted.length - 1];
    const saturated = scored
      .filter((c) => c.hex !== paper.hex && c.hex !== ink.hex)
      .map((c) => ({ ...c, sat: Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) }))
      .sort((a, b) => b.sat - a.sat);
    const accent = saturated[0] || (paper.lum > ink.lum ? ink : paper);
    const mid = sorted[Math.floor((sorted.length - 1) / 2)];
    return {
      paper: paper.hex,
      ink: ink.hex,
      accent: accent.hex,
      muted: (mid && mid.hex) || paper.hex,
    };
  }

  /** The DESIGN.md document, rendered as text the model and the human share. */
  function designMd(brand, title) {
    if (!brand || !brand.palette || !brand.palette.length) {
      return '# DESIGN.md\n\nNo brand extracted yet.';
    }
    const roles = brand.roles || semanticRoles(brand.palette) || {};
    const lines = [
      '# DESIGN.md' + (title ? ' — ' + title : ''),
      '',
      '## Palette',
      ...(brand.palette || []).map((hex) => '- ' + hex + ' (' + colorName(hex) + ')'),
      '',
      '## Semantic roles',
      '- paper (background): ' + (roles.paper || '—'),
      '- ink (primary text): ' + (roles.ink || '—'),
      '- accent (links, CTAs): ' + (roles.accent || '—'),
      '- muted (secondary text): ' + (roles.muted || '—'),
      '',
      '## Font stack',
      (brand.fontStack || '-(system stack)-'),
      '',
      '## Contrast (WCAG AA must pass)',
      ...(Object.keys(roles).length ? [
        '- ink on paper: ' + JSON.stringify(contrastReport(roles.ink, roles.paper)),
        '- accent on paper: ' + JSON.stringify(contrastReport(roles.accent, roles.paper)),
      ] : ['- (roles pending)']),
      '',
      '## Dials',
      '- DESIGN_VARIANCE: ' + (brand.variance != null ? brand.variance : 5) + ' / 10',
      '- MOTION_INTENSITY: ' + (brand.motion != null ? brand.motion : 3) + ' / 10',
      '- VISUAL_DENSITY: ' + (brand.density != null ? brand.density : 5) + ' / 10',
      '',
      brand.url ? 'Extracted from: ' + brand.url : '',
    ];
    return lines.filter((l) => l !== '').join('\n');
  }

  return {
    parseColor,
    luminance,
    contrastRatio,
    contrastReport,
    colorName,
    paletteFromText,
    semanticRoles,
    designMd,
  };
});
