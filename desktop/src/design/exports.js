// Exports and the handoff to Code, as pure string work. The host (the
// Design screen) does the parts that need a DOM or a file dialog; what goes
// INTO each file is decided here, so it is tested.
//
//   * tokensCss(html): the page's own custom properties (tweaks included) as
//     a tokens.css -- what the page actually uses, not the preset it began from;
//   * artboards(html, ...): one artboard per <section class="slide"> in a
//     deck, else the page itself;
//   * scopeCss + artboardSvg: an artboard as SVG through <foreignObject>.
//     Inside an SVG image, :root is the <svg>, so the page's :root/html/body
//     rules are re-pointed at a wrapper element that carries them instead;
//   * slideTexts: the text of each slide, for the PPTX writer (office.js);
//   * handoffFiles / handoffBrief / projectFiles: what a handoff and a
//     project ZIP contain.
//
// UMD (see chats.js); node-tested.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UDesignExports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ARTBOARD_CLASS = 'neura-artboard';

  function text(value) {
    return String(value == null ? '' : value);
  }

  function slug(name) {
    return text(name || 'design').toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design';
  }

  /** Custom properties declared on :root anywhere in the page, a later block winning. */
  function rootVars(html) {
    var out = {};
    var order = [];
    var src = text(html).replace(/<script[\s\S]*?<\/script>/gi, '');
    (src.match(/:root\s*\{[^}]*\}/g) || []).forEach(function (block) {
      var re = /(--[\w-]+)\s*:\s*([^;}]+)/g;
      var m;
      while ((m = re.exec(block))) {
        if (!(m[1] in out)) order.push(m[1]);
        out[m[1]] = m[2].trim();
      }
    });
    return order.map(function (k) { return { name: k, value: out[k] }; });
  }

  /** tokens.css from the page itself; `fallback` (a tokens.css string) when it declares none. */
  function tokensCss(html, fallback) {
    var vars = rootVars(html);
    if (!vars.length) return text(fallback);
    return '/* Extracted from the approved design: every custom property it declares on :root. */\n:root {\n' +
      vars.map(function (v) { return '  ' + v.name + ': ' + v.value + ';'; }).join('\n') + '\n}\n';
  }

  // ---- artboards -------------------------------------------------------------

  /** The slides of a deck as HTML strings (outer), in order. */
  function slidesOf(html) {
    var src = text(html);
    var out = [];
    var re = /<section\b[^>]*\bclass\s*=\s*["'][^"']*\bslide\b[^"']*["'][^>]*>/gi;
    var m;
    while ((m = re.exec(src))) {
      // Find the matching </section>, counting nested sections.
      var depth = 1;
      var i = m.index + m[0].length;
      var tag = /<(\/?)section\b[^>]*>/gi;
      tag.lastIndex = i;
      var t;
      while (depth && (t = tag.exec(src))) depth += t[1] ? -1 : 1;
      var end = t ? t.index + t[0].length : src.length;
      out.push(src.slice(m.index, end));
      re.lastIndex = end;
    }
    return out;
  }

  /**
   * What to export as pictures: every slide of a deck at the stage size, or
   * the page at its width and full height.
   */
  function artboards(html, stage, page) {
    var slides = slidesOf(html);
    if (slides.length) {
      return slides.map(function (s, i) {
        return { name: 'slide-' + (i < 9 ? '0' : '') + (i + 1), index: i, width: stage.width, height: stage.height };
      });
    }
    return [{ name: 'page', index: -1, width: page.width, height: Math.max(page.height, 1) }];
  }

  /** The page's CSS with :root, html and body re-pointed at the artboard wrapper. */
  function scopeCss(css, cls) {
    var c = '.' + (cls || ARTBOARD_CLASS);
    return text(css)
      .replace(/:root\b/g, c)
      .replace(/(^|[{},\s>+~])(html|body)(?=[\s,{.:#[>+~])/gi, function (_, pre) { return pre + c; });
  }

  /** The CSS in a page's <style> blocks, joined. */
  function cssOf(html) {
    return (text(html).match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).map(function (s) {
      return s.replace(/^<style[^>]*>/i, '').replace(/<\/style>$/i, '');
    }).join('\n');
  }

  /**
   * One artboard as a standalone SVG. `xhtml` must already be well-formed
   * XHTML (the host serialises it with XMLSerializer); CSS goes in a <style>
   * inside the foreignObject, scoped to the wrapper.
   */
  function artboardSvg(opts) {
    var o = opts || {};
    var w = Math.max(1, Math.round(Number(o.width) || 1));
    var h = Math.max(1, Math.round(Number(o.height) || 1));
    var css = scopeCss(o.css, ARTBOARD_CLASS).replace(/<\/style/gi, '<\\/style').replace(/]]>/g, ']] >');
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<foreignObject x="0" y="0" width="' + w + '" height="' + h + '">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" class="' + ARTBOARD_CLASS + '" style="width:' + w + 'px;height:' + h + 'px;overflow:hidden;margin:0">' +
      '<style><![CDATA[' + css + ']]></style>' + text(o.xhtml) +
      '</div></foreignObject></svg>';
  }

  // ---- PPTX ------------------------------------------------------------------

  function decode(s) {
    return text(s).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  /** Each slide's text, one line per heading / paragraph / list item, for writePptx. */
  function slideTexts(html) {
    return slidesOf(html).map(function (s) {
      var body = s.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, '').replace(/<aside class="caption"[\s\S]*?<\/aside>/gi, '');
      var lines = [];
      var re = /<(h[1-6]|p|li|blockquote|figcaption|td|th|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      var m;
      while ((m = re.exec(body))) {
        var line = decode(m[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        if (line) lines.push(/^li$/i.test(m[1]) ? '• ' + line : line);
      }
      if (!lines.length) {
        var bare = decode(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        if (bare) lines.push(bare.slice(0, 400));
      }
      return lines.join('\n');
    });
  }

  // ---- handoff ---------------------------------------------------------------

  /** An implementation README: what is on the page and how to rebuild it. */
  function readme(name, html, tokens) {
    var src = text(html);
    var count = function (re) { return (src.match(re) || []).length; };
    var landmarks = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'].map(function (t) {
      var n = count(new RegExp('<' + t + '[\\s>]', 'gi'));
      return n ? '- `<' + t + '>` × ' + n : '';
    }).filter(Boolean);
    var slides = slidesOf(src).length;
    return [
      '# ' + text(name || 'Design') + ' — implementation handoff',
      '',
      '## Files',
      '- `index.html` — the approved design, self-contained (inline CSS, no network).',
      '- `tokens.css` — every custom property the page declares, tweaks included. This is the source of truth for colour, type, spacing and radius.',
      '- `DESIGN.md` — the design system it was made with: roles, type scale, spacing unit and the don\'ts.',
      '',
      '## Structure',
      landmarks.length ? landmarks.join('\n') : '- (no landmark elements; add header/main/footer when rebuilding)',
      slides ? '- ' + slides + ' slide(s) as `<section class="slide">` — a deck; keep one component per slide layout.' : '',
      '- ' + count(/<(a|button)[\s>]/gi) + ' interactive element(s) (links and buttons).',
      '',
      '## Tokens',
      tokens.length ? tokens.map(function (t) { return '- `' + t.name + '`: `' + t.value + '`'; }).join('\n') : '- (none declared — take them from DESIGN.md)',
      '',
      '## How to implement',
      '1. Load `tokens.css` globally (or map each token into your theme config). Never hard-code a colour, font or spacing value that a token covers.',
      '2. Rebuild the page top-down as components, one per landmark/section above; keep the class names as a guide, not a contract.',
      '3. Match the spacing scale (multiples of `--space`) and the type scale from DESIGN.md; compare against `index.html` side by side at 390, 834 and 1440px wide.',
      '4. Accessibility: keep text at WCAG AA contrast, a visible `:focus-visible` style on every interactive element, headings in order, and labels on icon-only controls.',
      '5. Replace any inline SVG icons with your icon set only if it keeps their size and stroke.',
      '',
    ].filter(function (l, i, all) { return l !== '' || all[i - 1] !== ''; }).join('\n');
  }

  /** The handoff bundle: [[file, text]] -- page, tokens.css, DESIGN.md, README.md. */
  function handoffFiles(opts) {
    var o = opts || {};
    var html = text(o.html);
    var tokens = rootVars(html);
    return [
      ['index.html', html],
      ['tokens.css', tokensCss(html, o.fallbackTokens)],
      ['DESIGN.md', text(o.designMd)],
      ['README.md', readme(o.name, html, tokens)],
    ];
  }

  /** What the Code screen is asked to do with a handoff folder. */
  function handoffBrief(opts) {
    var o = opts || {};
    var dir = text(o.dir).replace(/\/+$/, '');
    return [
      'Implement the approved design "' + text(o.name || 'design') + '" from the handoff in `' + dir + '/`.',
      'Read `' + dir + '/README.md` first, then `' + dir + '/DESIGN.md` and `' + dir + '/tokens.css`; `' + dir + '/index.html` is the reference rendering.',
      'Use the tokens as CSS custom properties (or map them into the project\'s theme), rebuild the page as components in this project\'s stack, and keep WCAG AA contrast and visible :focus-visible styles.',
      o.target ? 'Target: ' + text(o.target) + '.' : 'Put the result where this project keeps its pages; if unsure, propose a location before writing.',
    ].join('\n');
  }

  /** A project ZIP: the page, its system, the history and a manifest. */
  function projectFiles(opts) {
    var o = opts || {};
    var s = slug(o.name);
    var files = handoffFiles(o).map(function (f) { return [s + '/' + f[0], f[1]]; });
    (o.versions || []).forEach(function (v, i) {
      files.push([s + '/history/' + (i < 9 ? '0' : '') + (i + 1) + '-' + slug(v.label).slice(0, 30) + '.html', text(v.html)]);
    });
    files.push([s + '/project.json', JSON.stringify({
      name: text(o.name),
      template: text(o.template),
      system: text(o.systemName),
      exportedAt: new Date(Number(o.now) || Date.now()).toISOString(),
      versions: (o.versions || []).map(function (v, i) { return { file: 'history/' + (i < 9 ? '0' : '') + (i + 1) + '-' + slug(v.label).slice(0, 30) + '.html', label: text(v.label), ts: v.ts }; }),
    }, null, 2)]);
    return files;
  }

  return {
    ARTBOARD_CLASS: ARTBOARD_CLASS,
    slug: slug,
    rootVars: rootVars,
    tokensCss: tokensCss,
    slidesOf: slidesOf,
    artboards: artboards,
    scopeCss: scopeCss,
    cssOf: cssOf,
    artboardSvg: artboardSvg,
    slideTexts: slideTexts,
    readme: readme,
    handoffFiles: handoffFiles,
    handoffBrief: handoffBrief,
    projectFiles: projectFiles,
  };
});
