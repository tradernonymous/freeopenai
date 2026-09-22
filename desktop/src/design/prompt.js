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

  // The Tweaks protocol (tweaks.js): a schema of a few controls bound to the
  // page's own custom properties, and a marked block holding their values.
  var TWEAKS_RULES = [
    'Tweaks: offer 3 to 8 controls for the choices a person would most want to adjust on THIS page (accent colour, a type size, density/spacing, corner radius, a dark/light toggle, a layout variant).',
    'Declare them in the <head> as <script type="application/neura-tweaks+json">{"version":1,"controls":[...]}</script>. Each control binds ONE custom property: {"var":"--accent","label":"Accent","type":"color","default":"#2f6f4f"}; types are only "slider" (with "min","max","step","unit"), "color" (a #hex default), "toggle" (with "on" and "off" values) and "select" (with "options":[{"value":"...","label":"..."}]).',
    'Make the CSS read those properties with var(), and end the <style> with their current values between the markers: /* neura-tweaks:start */ :root { --accent: #2f6f4f; } /* neura-tweaks:end */',
  ].join('\n');

  // Diagrams are drawn by the host (diagram-layout.js): the model only sends
  // the graph, so the house rules hold whatever model made it.
  var DIAGRAM_RULES = [
    'You design diagrams for NeuraOS Design. Reply with ONLY the graph, as JSON inside <diagram> ... </diagram>:',
    '{"nodes":[{"id":"api","label":"API gateway","group":"core"}],"edges":[{"from":"api","to":"db","label":"reads"}]}',
    'At most 9 nodes: merge or leave out detail rather than exceed it. Labels are 1 to 4 words. Use "group" for at most 2 groups that matter (they get the accent colours); leave the rest ungrouped. Edge labels only where the relationship is not obvious.',
    'The flow reads left to right, so list nodes roughly in the order things happen. No layout, colours or SVG: the studio draws it.',
  ].join('\n');

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
    var sys = [CHARTER, tier === 'local' ? LOCAL_RULES : CLOUD_RULES, TWEAKS_RULES];
    if (o.format && o.format.deck) sys.push(deckRules(o.format));
    if (o.platform) sys.push(String(o.platform));
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

  /**
   * The deck rules for a stage: 16:9 1920x1080 by default, or a carousel's own
   * size. Either way the slides are what deck mode navigates and what the
   * exports split on, and the print block is required.
   */
  function deckRules(format) {
    var w = Number(format && format.width);
    var h = Number(format && format.height);
    var own = w >= 320 && h >= 320 && (!format.unit || format.unit === 'px') && !(w === 1920 && h === 1080);
    if (!own) {
      return DECK_RULES + ' The stage is 1920x1080: design each slide at that size. Include @media print { @page { size: 1920px 1080px; margin: 0; } } so a PDF has one slide per page.';
    }
    return 'This is a set of slides: each slide is a <section class="slide"> exactly ' + w + 'x' + h + 'px (width ' + w + 'px, height ' + h + 'px, overflow hidden), stacked vertically with no gap, one idea per slide. The <style> ends with @media print { @page { size: ' + w + 'px ' + h + 'px; margin: 0; } .slide { break-after: page; } }.';
  }

  /** One diagram turn: the brief (and the current graph, when revising) -> graph JSON. */
  function diagramMessages(opts) {
    var o = opts || {};
    var user = ['Brief: ' + String(o.brief || '').trim()];
    if (o.graph && Array.isArray(o.graph.nodes) && o.graph.nodes.length) {
      user.push('Current diagram -- revise it and keep what the brief does not change:\n' + JSON.stringify({ nodes: o.graph.nodes, edges: o.graph.edges || [] }));
    }
    return [
      { role: 'system', content: DIAGRAM_RULES },
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
    TWEAKS_RULES: TWEAKS_RULES,
    DIAGRAM_RULES: DIAGRAM_RULES,
    tierOf: tierOf,
    deckRules: deckRules,
    buildMessages: buildMessages,
    diagramMessages: diagramMessages,
    commentMessages: commentMessages,
  };
});
