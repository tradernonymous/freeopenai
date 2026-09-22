// The Tweaks protocol (version 1): a page offers a handful of controls bound
// to its own CSS custom properties, the studio renders them, and the page
// applies the values on :root.
//
//   * the page carries its schema in <script type="application/neura-tweaks+json">
//     -- {"version":1,"controls":[{"var":"--accent","label":"Accent","type":"color"}]}
//     -- and the host script inside the sandbox posts it as
//     neura:tweaks-available {version, schema};
//   * the studio validates it here (strictly: unknown types dropped, 8 at most,
//     only --custom-property names) and posts neura:set-tweaks {vars} back;
//   * the chosen values persist IN the page, between marker comments inside a
//     <style> -- slash-star neura-tweaks:start ... neura-tweaks:end -- so a
//     saved version keeps them and an export ships them.
//
// UMD (see chats.js); pure string work, node-tested.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UTweaks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var VERSION = 1;
  var MIN_CONTROLS = 1;
  var MAX_CONTROLS = 8;
  var TYPES = ['slider', 'color', 'toggle', 'select'];
  var START = '/* neura-tweaks:start */';
  var END = '/* neura-tweaks:end */';
  var SCRIPT_TYPE = 'application/neura-tweaks+json';
  var VAR_RE = /^--[a-zA-Z][\w-]{0,40}$/;
  var HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  var UNITS = ['', 'px', 'rem', 'em', '%', 'vw', 'vh', 'ch', 'deg', 'ms', 's'];

  function text(value) {
    return String(value == null ? '' : value);
  }

  /** A value safe inside a declaration: no way out of the rule or the block. */
  function clean(value) {
    return text(value).replace(/[;{}<>]/g, '').replace(/\/\*|\*\//g, '').trim().slice(0, 120);
  }

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function control(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var type = text(raw.type).toLowerCase();
    if (TYPES.indexOf(type) < 0) return null;
    var name = text(raw.var || raw.variable || raw.name).trim();
    if (!VAR_RE.test(name)) return null;
    var out = { var: name, label: clean(raw.label || name.slice(2)).slice(0, 40) || name, type: type };
    if (type === 'slider') {
      var min = num(raw.min, 0);
      var max = num(raw.max, 100);
      if (max <= min) return null;
      var step = num(raw.step, (max - min) / 100);
      if (!(step > 0)) step = (max - min) / 100;
      var unit = text(raw.unit).trim();
      if (UNITS.indexOf(unit) < 0) return null;
      out.min = min;
      out.max = max;
      out.step = step;
      out.unit = unit;
      out.default = Math.min(max, Math.max(min, num(parseFloat(raw.default), min)));
    } else if (type === 'color') {
      out.default = HEX_RE.test(text(raw.default).trim()) ? text(raw.default).trim().toLowerCase() : '#777777';
    } else if (type === 'toggle') {
      out.on = clean(raw.on != null ? raw.on : '1') || '1';
      out.off = clean(raw.off != null ? raw.off : '0') || '0';
      out.default = raw.default === true || clean(raw.default) === out.on ? out.on : out.off;
    } else {
      var options = (Array.isArray(raw.options) ? raw.options : []).map(function (o) {
        if (o && typeof o === 'object') return { value: clean(o.value), label: clean(o.label || o.value).slice(0, 40) };
        return { value: clean(o), label: clean(o).slice(0, 40) };
      }).filter(function (o) { return o.value; }).slice(0, 8);
      if (options.length < 2) return null;
      out.options = options;
      var want = clean(raw.default);
      out.default = options.some(function (o) { return o.value === want; }) ? want : options[0].value;
    }
    return out;
  }

  /**
   * A schema as the studio will render it, or null. Strict: a control of an
   * unknown type or with a bad name is dropped, a repeated variable keeps its
   * first control, and more than MAX_CONTROLS are cut.
   */
  function validateSchema(raw) {
    var src = raw;
    if (typeof src === 'string') {
      try { src = JSON.parse(src); } catch { return null; }
    }
    if (Array.isArray(src)) src = { version: VERSION, controls: src };
    if (!src || typeof src !== 'object') return null;
    if (src.version != null && Number(src.version) !== VERSION) return null;
    var seen = {};
    var controls = [];
    (Array.isArray(src.controls) ? src.controls : []).forEach(function (c) {
      if (controls.length >= MAX_CONTROLS) return;
      var ok = control(c);
      if (!ok || seen[ok.var]) return;
      seen[ok.var] = true;
      controls.push(ok);
    });
    return controls.length >= MIN_CONTROLS ? { version: VERSION, controls: controls } : null;
  }

  /** The schema a page declares, validated -- or null. */
  function schemaFromHtml(html) {
    var re = new RegExp('<script[^>]*type=["\']' + SCRIPT_TYPE.replace(/[+.]/g, '\\$&') + '["\'][^>]*>([\\s\\S]*?)<\\/script>', 'i');
    var m = re.exec(text(html));
    return m ? validateSchema(m[1].trim()) : null;
  }

  /** One value made legal for its control (clamped, whitelisted, or refused). */
  function sanitize(ctrl, value) {
    if (!ctrl) return null;
    var v = text(value).trim();
    if (ctrl.type === 'slider') {
      var n = parseFloat(v);
      if (!isFinite(n)) n = ctrl.default;
      n = Math.min(ctrl.max, Math.max(ctrl.min, n));
      n = Math.round(n * 1000) / 1000;
      return n + ctrl.unit;
    }
    if (ctrl.type === 'color') return HEX_RE.test(v) ? v.toLowerCase() : null;
    if (ctrl.type === 'toggle') return v === ctrl.on || v === 'true' ? ctrl.on : ctrl.off;
    var hit = (ctrl.options || []).some(function (o) { return o.value === v; });
    return hit ? v : null;
  }

  /** The values persisted between the markers, as {--var: value}. */
  function readDefaults(html) {
    var src = text(html);
    var a = src.indexOf(START);
    var b = a >= 0 ? src.indexOf(END, a) : -1;
    var out = {};
    if (a < 0 || b < 0) return out;
    var re = /(--[\w-]+)\s*:\s*([^;}]+)/g;
    var body = src.slice(a + START.length, b);
    var m;
    while ((m = re.exec(body))) out[m[1]] = m[2].trim();
    return out;
  }

  /** The declarations for a set of values (bad names and values dropped). */
  function css(vars) {
    var out = '';
    Object.keys(vars || {}).forEach(function (k) {
      if (!VAR_RE.test(k)) return;
      var v = clean(vars[k]);
      if (v) out += k + ':' + v + ';';
    });
    return ':root{' + out + '}';
  }

  /**
   * The page with `vars` written between the markers -- replacing what was
   * there -- or, when the page has no markers yet, a new marked <style> just
   * before </head> (last in the head, so it wins the cascade).
   */
  function writeDefaults(html, vars) {
    var src = text(html);
    var block = START + css(vars) + END;
    var a = src.indexOf(START);
    var b = a >= 0 ? src.indexOf(END, a) : -1;
    if (a >= 0 && b >= 0) return src.slice(0, a) + block + src.slice(b + END.length);
    var style = '<style id="neura-tweak-defaults">' + block + '</style>';
    var head = src.search(/<\/head>/i);
    if (head >= 0) return src.slice(0, head) + style + src.slice(head);
    var body = src.search(/<body[\s>]/i);
    return body >= 0 ? src.slice(0, body) + style + src.slice(body) : style + src;
  }

  /** What each control shows now: the persisted value, else its default. */
  function initialValues(schema, html) {
    var saved = readDefaults(html);
    var out = {};
    ((schema && schema.controls) || []).forEach(function (c) {
      var v = saved[c.var] != null ? sanitize(c, saved[c.var]) : null;
      out[c.var] = v != null ? v : sanitize(c, c.default);
    });
    return out;
  }

  /** {vars} for neura:set-tweaks: only the schema's variables, each sanitised. */
  function message(schema, values) {
    var vars = {};
    ((schema && schema.controls) || []).forEach(function (c) {
      var v = sanitize(c, values && values[c.var]);
      if (v != null) vars[c.var] = v;
    });
    return { type: 'neura:set-tweaks', version: VERSION, vars: vars };
  }

  return {
    VERSION: VERSION,
    MIN_CONTROLS: MIN_CONTROLS,
    MAX_CONTROLS: MAX_CONTROLS,
    TYPES: TYPES,
    START: START,
    END: END,
    SCRIPT_TYPE: SCRIPT_TYPE,
    validateSchema: validateSchema,
    schemaFromHtml: schemaFromHtml,
    sanitize: sanitize,
    readDefaults: readDefaults,
    writeDefaults: writeDefaults,
    css: css,
    initialValues: initialValues,
    message: message,
  };
});
