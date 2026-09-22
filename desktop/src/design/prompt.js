// What the Design studio asks a model, split by tier.
//
// One short charter (our own words, well under 3k tokens) that every model
// gets, plus rules that differ by tier:
//   * cloud: may answer a vague brief with a <question-form> (1-3 questions,
//     never more than 5, never about style when a system is chosen);
//   * local: never asks -- it decides and lists an <assumptions> block, gets a
//     tighter slice of the current page, and one generation per turn (the
//     variants are token swaps done by the host, systems.js).
// Comment edits send ONE element, not the page: that is what lets a 7-14B
// local model do this job.
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UDesignPrompt = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  // systems.js publishes its global unconditionally (in node too), so it is
  // read at call time: load it first, as DesignScreen and the tests do.
  function systems() {
    return root && root.FreeAI4UDesignSystems;
  }

  var CHARTER = [
    'You are the designer in NeuraOS Design. Each turn you produce ONE self-contained HTML document: inline <style>, no external stylesheets, fonts, images, scripts or frameworks, nothing loaded from the network.',
    'Contract: put the whole page inside <artifact type="text/html"> ... </artifact>. Outside it, only the optional blocks your instructions allow.',
    'Style ONLY through the design-system tokens. Declare them once in a :root block at the top of the <style> (--paper, --ink, --muted, --accent, --line, --font-display, --font-body, --radius, --space, --measure) and use them with var(). No literal colours anywhere else.',
    'Honour the DESIGN.md contract you are given: its roles, type, spacing unit and its don\'ts.',
    'Accessibility: text contrast meets WCAG AA (4.5:1, or 3:1 for large text); every link and button has a visible :focus-visible style; headings go in order; icons are inline SVG with a label.',
    'Write real copy for the brief: names, numbers, verbs. No lorem ipsum and no "your text here".',
    'Avoid the generated look: no purple-to-blue gradient washes, no emoji as icons, no pure #000 or #fff, no cards inside cards, no coloured left-bar cards, and no three identical feature columns unless the content truly is three parallel things.',
    'Layout: one clear reading column, spacing in multiples of var(--space), a real type scale, and @media (max-width: 640px) rules so it holds on a phone.',
  ].join('\n');

  var CLOUD_RULES = [
    'If the brief is too vague to design well and no design system was chosen, you may instead reply with ONLY a <question-form> holding JSON: {"questions":[{"id":"audience","label":"Who is this for?","options":["...","..."]}]} -- 1 to 3 questions, never more than 5, never about visual style. Otherwise design straight away.',
  ].join('\n');

  var LOCAL_RULES = [
    'Never ask questions. Where the brief leaves something open, decide, and list what you assumed in an <assumptions> block (one per line) BEFORE the artifact.',
    'Keep the page to what the brief needs; a finished smaller page beats an unfinished large one.',
  ].join('\n');

  var DECK_RULES = 'This is a deck: each slide is a <section class="slide"> sized 16:9 (width 100vw, aspect-ratio 16/9, overflow hidden), one idea per slide, and the <style> ends with @media print { .slide { break-after: page; } }.';

  /** 'local' for models on this machine, 'cloud' for everything else. */
  function tierOf(provider) {
    var p = String(provider || '');
    return p === 'local' || p === 'ollama-local' || p === 'unsloth-local' ? 'local' : 'cloud';
  }

  function clip(value, max) {
    var s = String(value || '');
    return s.length > max ? s.slice(0, max) + '\n<!-- [truncated] -->' : s;
  }

  /**
   * The messages for one design turn.
   * opts: { brief, system, tier, format: {label,width,height,unit,deck}, html, answers: [{label, answer}] }
   */
  function buildMessages(opts) {
    var o = opts || {};
    var lib = systems();
    var tier = o.tier === 'local' ? 'local' : 'cloud';
    var system = o.system || (lib && lib.PRESETS[0]);
    var sys = [CHARTER, tier === 'local' ? LOCAL_RULES : CLOUD_RULES];
    if (o.format && o.format.deck) sys.push(DECK_RULES);
    var user = ['Brief: ' + String(o.brief || '').trim()];
    if (o.format && o.format.label) {
      user.push('Format: ' + o.format.label + (o.format.width ? ' (' + o.format.width + 'x' + o.format.height + (o.format.unit || 'px') + ')' : '') + '.');
    }
    if (system && lib) {
      user.push('DESIGN.md contract:\n' + lib.designMd(system));
      user.push('tokens.css (declare exactly these in :root):\n' + lib.tokensCss(system));
    }
    if (Array.isArray(o.answers) && o.answers.length) {
      user.push('Answers to your questions:\n' + o.answers.map(function (a) { return '- ' + a.label + ' ' + a.answer; }).join('\n'));
    }
    if (o.html) {
      user.push('Current page -- revise it and keep what the brief does not change:\n```html\n' + clip(o.html, tier === 'local' ? 24000 : 60000) + '\n```');
    }
    return [
      { role: 'system', content: sys.join('\n\n') },
      { role: 'user', content: user.join('\n\n') },
    ];
  }

  /** One element and one comment -> the replacement element. */
  function commentMessages(opts) {
    var o = opts || {};
    var tokens = o.tokens || {};
    var list = Object.keys(tokens).map(function (k) { return k + ': ' + tokens[k]; }).join('; ');
    return [
      {
        role: 'system',
        content: [
          'You edit ONE element of an HTML page for NeuraOS Design.',
          'Reply with only the replacement element, inside <artifact type="text/html-fragment"> ... </artifact>.',
          'Keep its tag unless the request needs another. Style only through the tokens with var(--...), keep copy real, and keep text contrast at WCAG AA.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: 'Element:\n```html\n' + clip(o.outer, 6000) + '\n```\n\nRequest: ' + String(o.comment || '').trim() + (list ? '\n\nTokens: ' + list : ''),
      },
    ];
  }

  return {
    CHARTER: CHARTER,
    CLOUD_RULES: CLOUD_RULES,
    LOCAL_RULES: LOCAL_RULES,
    DECK_RULES: DECK_RULES,
    tierOf: tierOf,
    buildMessages: buildMessages,
    commentMessages: commentMessages,
  };
});
