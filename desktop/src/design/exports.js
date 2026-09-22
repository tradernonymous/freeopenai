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

  // ---- PPTX pictures ---------------------------------------------------------
  //
  // Each slide's <img> elements, for office.writePptx. Only pictures that can
  // be read here go in: PNG/JPEG `data:` URLs, or a same-document source the
  // host resolves to one (`resolve(src)`); a remote URL is skipped, never
  // fetched. Placement is proportional: an inline left/top/width/height (px
  // of the stage, or %) maps onto the slide; an image without a position
  // flows into a column on the right half, keeping its aspect ratio.

  var SLIDE_CX = 12192000; // 13.333 in, PowerPoint's 16:9 width in EMU

  function attr(tag, name) {
    var m = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
    return m ? decode(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]) : '';
  }

  /** A CSS length in the style attribute, as a fraction of `total` (px or %), or null. */
  function styleFraction(style, prop, total) {
    var m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*(-?[\\d.]+)(px|%)?', 'i').exec(style);
    if (!m) return null;
    var n = Number(m[1]);
    if (!isFinite(n)) return null;
    return m[2] === '%' ? n / 100 : n / total;
  }

  function base64Head(b64, count) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var clean = text(b64).replace(/[^A-Za-z0-9+/]/g, '');
    var out = [];
    var buf = 0, bits = 0;
    for (var i = 0; i < clean.length && out.length < count; i++) {
      buf = ((buf << 6) | chars.indexOf(clean.charAt(i))) & 0xFFFFFF;
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xFF); }
    }
    return out;
  }

  /** Natural { width, height } of a PNG/JPEG data URL, or null. */
  function naturalSize(dataUrl) {
    var m = /^data:image\/(png|jpe?g);base64,([\s\S]*)$/i.exec(dataUrl);
    if (!m) return null;
    if (/png/i.test(m[1])) {
      var h = base64Head(m[2], 24);
      if (h.length < 24 || h[0] !== 0x89 || h[1] !== 0x50) return null;
      var w = ((h[16] << 24) | (h[17] << 16) | (h[18] << 8) | h[19]) >>> 0;
      var ht = ((h[20] << 24) | (h[21] << 16) | (h[22] << 8) | h[23]) >>> 0;
      return w && ht ? { width: w, height: ht } : null;
    }
    var b = base64Head(m[2], 256 * 1024);
    if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
    var i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i += 1; continue; }
      var marker = b[i + 1];
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0xFF) { i += marker === 0xFF ? 1 : 2; continue; }
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        var jh = (b[i + 5] << 8) | b[i + 6];
        var jw = (b[i + 7] << 8) | b[i + 8];
        return jw && jh ? { width: jw, height: jh } : null;
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }

  function readableSrc(src, resolve) {
    var s = text(src).trim();
    if (/^data:image\/(png|jpe?g);base64,/i.test(s)) return s;
    if (!s || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(s)) return ''; // remote or another scheme: skipped
    if (typeof resolve !== 'function') return '';
    var out = text(resolve(s)).trim();
    return /^data:image\/(png|jpe?g);base64,/i.test(out) ? out : '';
  }

  /**
   * slideImages(slideHtml, { stage, size, resolve }) -> [{ src, x, y, cx, cy, name }]
   * in EMU on a slide of `size`, from a stage of `stage` px.
   */
  function slideImages(slideHtml, opts) {
    var o = opts || {};
    var stage = o.stage || { width: 1920, height: 1080 };
    var size = o.size || { cx: SLIDE_CX, cy: Math.round(SLIDE_CX * stage.height / stage.width) };
    var body = text(slideHtml).replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, '');
    var placed = [];
    var flowing = [];
    var re = /<img\b[^>]*>/gi;
    var m;
    while ((m = re.exec(body))) {
      var tag = m[0];
      var src = readableSrc(attr(tag, 'src'), o.resolve);
      if (!src) continue;
      var style = attr(tag, 'style');
      var natural = naturalSize(src);
      var aspect = natural ? natural.width / natural.height : 4 / 3;
      var fw = styleFraction(style, 'width', stage.width);
      var fh = styleFraction(style, 'height', stage.height);
      if (fw == null && Number(attr(tag, 'width')) > 0) fw = Number(attr(tag, 'width')) / stage.width;
      if (fh == null && Number(attr(tag, 'height')) > 0) fh = Number(attr(tag, 'height')) / stage.height;
      // One side known: the other follows the picture's own aspect ratio.
      if (fw != null && fh == null) fh = (fw * stage.width / aspect) / stage.height;
      if (fh != null && fw == null) fw = (fh * stage.height * aspect) / stage.width;
      var fx = styleFraction(style, 'left', stage.width);
      var fy = styleFraction(style, 'top', stage.height);
      var row = { src: src, fw: fw, fh: fh, aspect: aspect, name: attr(tag, 'alt').slice(0, 80) };
      if (fx != null && fy != null) { row.fx = fx; row.fy = fy; placed.push(row); } else flowing.push(row);
    }
    // The column for unpositioned pictures: right half, top to bottom.
    var col = { x: 0.52, y: 0.08, w: 0.44, h: 0.84 };
    flowing.forEach(function (row, i) {
      var cellH = col.h / flowing.length;
      var cellTop = col.y + i * cellH;
      // Fit inside the cell (in stage px, so the aspect ratio holds), never larger than asked.
      var maxW = col.w * stage.width;
      var maxH = cellH * stage.height * 0.94;
      var wantW = row.fw != null ? row.fw * stage.width : maxW;
      var wantH = row.fh != null ? row.fh * stage.height : wantW / row.aspect;
      var scale = Math.min(1, maxW / wantW, maxH / wantH);
      var pw = wantW * scale;
      var ph = wantH * scale;
      row.fw = pw / stage.width;
      row.fh = ph / stage.height;
      row.fx = col.x + (col.w - row.fw) / 2;
      row.fy = cellTop + (cellH - row.fh) / 2;
      placed.push(row);
    });
    return placed.map(function (row, i) {
      var fw = row.fw != null ? row.fw : 0.3;
      var fh = row.fh != null ? row.fh : (fw * stage.width / row.aspect) / stage.height;
      return {
        src: row.src,
        x: Math.round(Math.max(0, row.fx) * size.cx),
        y: Math.round(Math.max(0, row.fy) * size.cy),
        cx: Math.max(1, Math.round(fw * size.cx)),
        cy: Math.max(1, Math.round(fh * size.cy)),
        name: row.name || 'Picture ' + (i + 1),
      };
    });
  }

  /**
   * pptxDeck(html, { stage, resolve }) -> { size, slides: [{ text, images }] },
   * ready for office.writePptx(name, deck.slides, { size: deck.size }). The
   * slide keeps the stage's aspect ratio at PowerPoint's 16:9 width.
   */
  function pptxDeck(html, opts) {
    var o = opts || {};
    var stage = o.stage && o.stage.width > 0 && o.stage.height > 0 ? o.stage : { width: 1920, height: 1080 };
    var size = { cx: SLIDE_CX, cy: Math.round(SLIDE_CX * stage.height / stage.width) };
    var texts = slideTexts(html);
    var slides = slidesOf(html).map(function (s, i) {
      return { text: texts[i] || '', images: slideImages(s, { stage: stage, size: size, resolve: o.resolve }) };
    });
    return { size: size, slides: slides };
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

  // ---- framework exports -----------------------------------------------------
  //
  // React is a real, deterministic conversion: the page body as JSX, its CSS
  // in a stylesheet beside it, tokens.css imported. Flutter and SwiftUI have
  // no honest string-level mapping from HTML/CSS, so those are prompts: the
  // current model translates the page, with the tokens as theme constants.

  var VOID_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'];
  var ATTR_NAMES = {
    'class': 'className',
    'for': 'htmlFor',
    tabindex: 'tabIndex',
    readonly: 'readOnly',
    maxlength: 'maxLength',
    minlength: 'minLength',
    colspan: 'colSpan',
    rowspan: 'rowSpan',
    autocomplete: 'autoComplete',
    autofocus: 'autoFocus',
    autoplay: 'autoPlay',
    contenteditable: 'contentEditable',
    crossorigin: 'crossOrigin',
    srcset: 'srcSet',
    enctype: 'encType',
    novalidate: 'noValidate',
    allowfullscreen: 'allowFullScreen',
    datetime: 'dateTime',
    spellcheck: 'spellCheck',
    usemap: 'useMap',
    playsinline: 'playsInline',
    referrerpolicy: 'referrerPolicy',
    inputmode: 'inputMode',
    accesskey: 'accessKey',
    'xlink:href': 'xlinkHref',
    'xml:lang': 'xmlLang',
    'xml:space': 'xmlSpace',
    value: 'defaultValue',
    checked: 'defaultChecked',
  };

  /** "my landing page" -> "MyLandingPage" (a valid component name). */
  function componentName(name) {
    var words = text(name).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    var out = words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join('');
    if (!out) out = 'Design';
    if (/^[0-9]/.test(out)) out = 'Design' + out;
    return out;
  }

  function camel(name) {
    return name.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  /** "color: red; margin-top: 4px" -> "{ color: 'red', marginTop: '4px' }". */
  function styleObject(css) {
    var parts = [];
    text(css).split(';').forEach(function (decl) {
      var at = decl.indexOf(':');
      if (at < 0) return;
      var prop = decl.slice(0, at).trim();
      var value = decl.slice(at + 1).trim();
      if (!prop || !value) return;
      var key;
      if (prop.indexOf('--') === 0) key = "'" + prop + "'";
      else if (/^-ms-/i.test(prop)) key = camel(prop.slice(1).toLowerCase());
      else if (prop.charAt(0) === '-') key = camel(prop.slice(1).toLowerCase()).replace(/^./, function (c) { return c.toUpperCase(); });
      else key = camel(prop.toLowerCase());
      parts.push(key + ': ' + "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
    });
    return '{ ' + parts.join(', ') + ' }';
  }

  function jsxAttrName(raw) {
    var lower = raw.toLowerCase();
    if (ATTR_NAMES[lower]) return ATTR_NAMES[lower];
    if (/^(data|aria)-/.test(lower)) return lower;
    if (raw.indexOf('-') > 0) return camel(raw);
    if (raw.indexOf(':') > 0) return camel(raw.replace(':', '-'));
    return raw;
  }

  /** Attributes React types as numbers. */
  var NUMERIC_ATTRS = ['tabIndex', 'colSpan', 'rowSpan', 'maxLength', 'minLength', 'size', 'cols', 'rows', 'span'];

  /** One start tag's attributes, as JSX. Inline on* handlers are dropped. */
  function jsxAttrs(source, notes, tag) {
    var field = /^(input|textarea|select)$/i.test(tag || '');
    var out = [];
    var re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
    var m;
    while ((m = re.exec(source))) {
      var raw = m[1];
      var value = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
      if (/^on[a-z]+$/i.test(raw)) { notes.handlers += 1; continue; }
      // value/checked become defaultValue/defaultChecked on form fields only
      // (uncontrolled, as the page had them); an <option value> stays value.
      var name = !field && /^(value|checked)$/i.test(raw) ? raw.toLowerCase() : jsxAttrName(raw);
      if (raw.toLowerCase() === 'style') {
        var obj = styleObject(value);
        // React's CSSProperties has no index for custom properties, so an
        // object that sets one is asserted to the type.
        if (/'--/.test(obj)) { notes.customProps = true; out.push('style={' + obj + ' as CSSProperties}'); } else out.push('style={' + obj + '}');
      } else if (value == null) {
        out.push(name);
      } else if (NUMERIC_ATTRS.indexOf(name) >= 0 && /^-?\d+$/.test(value.trim())) {
        out.push(name + '={' + parseInt(value, 10) + '}');
      } else if (value.indexOf('"') >= 0) {
        out.push(name + "={'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'}");
      } else {
        out.push(name + '="' + value + '"');
      }
    }
    return out.length ? ' ' + out.join(' ') : '';
  }

  /** Text between tags, with JSX's braces escaped. */
  function jsxText(s) {
    return s.replace(/[{}>]/g, function (c) { return "{'" + c + "'}"; });
  }

  /**
   * HTML (a fragment) -> JSX. Comments, scripts and style blocks are removed
   * (the styles are the caller's to move); void tags self-close.
   */
  function htmlToJsx(html, notes) {
    var n = notes || { handlers: 0, scripts: 0 };
    var src = text(html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, function () { n.scripts += 1; return ''; })
      .replace(/<style\b[\s\S]*?<\/style>/gi, '');
    var out = '';
    var re = /<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
    var last = 0;
    var m;
    while ((m = re.exec(src))) {
      out += jsxText(src.slice(last, m.index));
      last = m.index + m[0].length;
      var closing = m[1] === '/';
      var tag = m[2];
      var isVoid = VOID_TAGS.indexOf(tag.toLowerCase()) >= 0;
      if (closing) {
        if (!isVoid) out += '</' + tag + '>';
        continue;
      }
      var rest = m[3];
      var selfClosed = /\/\s*$/.test(rest);
      if (selfClosed) rest = rest.replace(/\/\s*$/, '');
      out += '<' + tag + jsxAttrs(rest, n, tag) + (isVoid || selfClosed ? ' />' : '>');
    }
    out += jsxText(src.slice(last));
    return out;
  }

  /** The page's <body> content (or the whole fragment when there is no body). */
  function bodyOf(html) {
    var src = text(html);
    var m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(src);
    if (m) return m[1];
    return src.replace(/<!doctype[^>]*>/i, '').replace(/<head[^>]*>[\s\S]*?<\/head>/i, '').replace(/<\/?html[^>]*>/gi, '');
  }

  /**
   * The page as a React component: { name, tsx, css, tokens, files }. The
   * :root tokens go to tokens.css; every other rule to <Name>.css, which the
   * component imports alongside it.
   */
  function toReact(html, name) {
    var comp = componentName(name);
    var notes = { handlers: 0, scripts: 0, customProps: false };
    var body = htmlToJsx(bodyOf(html), notes).replace(/^\s*\n/, '').replace(/\s+$/, '');
    var css = cssOf(html).replace(/:root\s*\{[^}]*\}/g, '').replace(/\n{3,}/g, '\n\n').trim();
    var tokens = tokensCss(html, ':root {}\n');
    var dropped = [];
    if (notes.scripts) dropped.push(notes.scripts + ' <script> block(s)');
    if (notes.handlers) dropped.push(notes.handlers + ' inline event handler(s)');
    var indented = body.split('\n').map(function (line) { return line ? '      ' + line : line; }).join('\n');
    var tsx = [
      '// ' + comp + ' -- exported from the NeuraOS Design studio ("' + text(name).replace(/[\r\n]/g, ' ') + '").',
      '// A deterministic HTML -> JSX conversion: class -> className, for -> htmlFor,',
      '// style strings -> objects, void tags self-closed. Page styles are in',
      '// ' + comp + '.css, design tokens in tokens.css.',
      dropped.length ? '// Not carried over (wire these up in React): ' + dropped.join(', ') + '.' : '',
      notes.customProps ? "import type { CSSProperties } from 'react';" : '',
      "import './tokens.css';",
      "import './" + comp + ".css';",
      '',
      'export default function ' + comp + '() {',
      '  return (',
      '    <>',
      indented,
      '    </>',
      '  );',
      '}',
      '',
    ].filter(function (line, i) { return !((i === 4 || i === 5) && !line); }).join('\n');
    var cssFile = '/* ' + comp + ' -- the page styles; tokens live in tokens.css. */\n' + (css ? css + '\n' : '');
    return {
      name: comp,
      tsx: tsx,
      css: cssFile,
      tokens: tokens,
      files: [[comp + '.tsx', tsx], [comp + '.css', cssFile], ['tokens.css', tokens]],
    };
  }

  var PAGE_LIMIT = 24000;

  function frameworkPrompt(html, name, kind) {
    var vars = rootVars(html);
    var page = text(html).replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    if (page.length > PAGE_LIMIT) page = page.slice(0, PAGE_LIMIT) + '\n<!-- (truncated) -->';
    var flutter = kind === 'flutter';
    var suffix = flutter ? 'Page' : 'View';
    var base = componentName(name);
    var comp = new RegExp(suffix + '$').test(base) ? base : base + suffix;
    var tokenLines = vars.length
      ? vars.map(function (v) { return '  ' + v.name + ': ' + v.value; }).join('\n')
      : '  (the page declares no :root tokens; derive a small palette from its CSS)';
    var system = flutter
      ? 'You translate HTML/CSS pages into idiomatic Flutter (Dart 3, Material 3). Reply with ONE ```dart code block and nothing else.'
      : 'You translate HTML/CSS pages into idiomatic SwiftUI (iOS 17 / macOS 14). Reply with ONE ```swift code block and nothing else.';
    var rules = flutter
      ? [
        '- One file: a `' + comp + 'Theme` class of static const theme constants built from the tokens below (Color(0xFF......) for colours, double for lengths), then a StatelessWidget `' + comp + '` that uses only those constants.',
        '- Map the layout faithfully: flex rows/columns -> Row/Column, grids -> Wrap or GridView, max-width -> ConstrainedBox, scrolling page -> SingleChildScrollView.',
        '- Keep every piece of copy exactly as written. Buttons and links get empty onPressed/onTap callbacks with a TODO.',
        '- Imports: package:flutter/material.dart only. No third-party packages, no network images (use a placeholder Container with the token colour).',
      ]
      : [
        '- One file: an `enum ' + comp + 'Theme` (or struct) of static let theme constants built from the tokens below (Color(red:green:blue:) for colours, CGFloat for lengths), then a `struct ' + comp + ': View` that uses only those constants.',
        '- Map the layout faithfully: flex rows/columns -> HStack/VStack, grids -> LazyVGrid, max-width -> .frame(maxWidth:), a scrolling page -> ScrollView.',
        '- Keep every piece of copy exactly as written. Buttons and links get empty actions with a TODO.',
        '- Imports: SwiftUI only. Include a #Preview at the end.',
      ];
    var user = [
      'Translate this page into ' + (flutter ? 'a Flutter widget' : 'a SwiftUI view') + ' named `' + comp + '`.',
      '',
      'Design tokens (make these the theme constants):',
      tokenLines,
      '',
      'Rules:',
      rules.join('\n'),
      '',
      'The page:',
      '```html',
      page,
      '```',
    ].join('\n');
    return {
      name: comp,
      language: flutter ? 'dart' : 'swift',
      fileName: flutter ? comp.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() + '.dart' : comp + '.swift',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    };
  }

  /** A prompt for the current model: the page as a Flutter widget, tokens as theme constants. */
  function toFlutter(html, name) {
    return frameworkPrompt(html, name, 'flutter');
  }

  /** A prompt for the current model: the page as a SwiftUI view, tokens as theme constants. */
  function toSwiftUI(html, name) {
    return frameworkPrompt(html, name, 'swift');
  }

  /** The code from a model's reply: the longest fenced block (preferring `language`), else the reply. */
  function codeFromReply(reply, language) {
    var src = text(reply);
    var re = /```([\w+-]*)[^\n]*\n([\s\S]*?)```/g;
    var best = '';
    var bestTagged = '';
    var m;
    while ((m = re.exec(src))) {
      if (m[2].length > best.length) best = m[2];
      if (language && m[1].toLowerCase() === language && m[2].length > bestTagged.length) bestTagged = m[2];
    }
    var code = bestTagged || best || src;
    return code.replace(/\s+$/, '') + '\n';
  }

  return {
    componentName: componentName,
    htmlToJsx: htmlToJsx,
    toReact: toReact,
    toFlutter: toFlutter,
    toSwiftUI: toSwiftUI,
    codeFromReply: codeFromReply,
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
    slideImages: slideImages,
    pptxDeck: pptxDeck,
    readme: readme,
    handoffFiles: handoffFiles,
    handoffBrief: handoffBrief,
    projectFiles: projectFiles,
  };
});
