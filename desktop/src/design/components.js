// The Design studio's component palette: token-bound snippets a person can
// drop onto the canvas. Every colour, face, corner and gap comes from the
// page's own custom properties (var(--paper), var(--accent), var(--space)...)
// with a fallback, so a snippet takes on whatever system the page uses and
// moves with Tweaks. Each one passes the anti-slop linter (slop.js) -- that is
// tested, not hoped for.
//
// A snippet is CSS + markup. insertInto() puts the CSS once per page (a
// <style data-neura-component="id"> in the head) and the markup before the
// last </main>, else before </body>.
//
// UMD (see chats.js); node-tested.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UDesignComponents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Shared fallbacks: the neutral-minimal preset's values.
  var S = 'var(--space, 8px)';
  var FOCUS = 'outline: 2px solid var(--accent, #2f6f4f); outline-offset: 2px;';

  var COMPONENTS = [
    {
      id: 'button',
      label: 'Button',
      note: 'One primary action and a quiet secondary',
      css: '.nx-actions { display: flex; flex-wrap: wrap; gap: ' + S + '; margin: calc(' + S + ' * 2) 0; }\n' +
        '.nx-btn { font: 600 1rem/1.2 var(--font-body, system-ui, sans-serif); padding: calc(' + S + ' * 1.5) calc(' + S + ' * 3); border-radius: var(--radius, 6px); border: 1px solid var(--accent, #2f6f4f); cursor: pointer; }\n' +
        '.nx-btn-primary { background: var(--accent, #2f6f4f); color: var(--paper, #f6f5f1); }\n' +
        '.nx-btn-quiet { background: var(--paper, #f6f5f1); color: var(--accent, #2f6f4f); }\n' +
        '.nx-btn:focus-visible { ' + FOCUS + ' }',
      html: '<div class="nx-actions">\n  <button class="nx-btn nx-btn-primary" type="button">Start the trial</button>\n  <button class="nx-btn nx-btn-quiet" type="button">See pricing</button>\n</div>',
    },
    {
      id: 'card',
      label: 'Card',
      note: 'A titled block with a hairline border',
      css: '.nx-card { background: var(--paper, #f6f5f1); color: var(--ink, #1b1c1a); border: 1px solid var(--line, #dcdad3); border-radius: var(--radius, 6px); padding: calc(' + S + ' * 3); max-width: var(--measure, 68ch); }\n' +
        '.nx-card h3 { font-family: var(--font-display, Georgia, serif); margin: 0 0 ' + S + '; }\n' +
        '.nx-card p { color: var(--muted, #5d5f58); margin: 0; }',
      html: '<article class="nx-card">\n  <h3>Weekly report</h3>\n  <p>Orders rose eleven percent after the checkout change shipped on Tuesday.</p>\n</article>',
    },
    {
      id: 'input',
      label: 'Input',
      note: 'A labelled text field with a hint',
      css: '.nx-field { display: grid; gap: ' + S + '; max-width: 32rem; margin: calc(' + S + ' * 2) 0; font-family: var(--font-body, system-ui, sans-serif); color: var(--ink, #1b1c1a); }\n' +
        '.nx-field input { font: inherit; padding: calc(' + S + ' * 1.5); border: 1px solid var(--line, #dcdad3); border-radius: var(--radius, 6px); background: var(--paper, #f6f5f1); color: var(--ink, #1b1c1a); }\n' +
        '.nx-field input:focus-visible { ' + FOCUS + ' }\n' +
        '.nx-field small { color: var(--muted, #5d5f58); }',
      html: '<label class="nx-field">\n  <span>Work email</span>\n  <input type="email" name="email" autocomplete="email" placeholder="name@company.com">\n  <small>We send one message a month, never more.</small>\n</label>',
    },
    {
      id: 'nav',
      label: 'Nav bar',
      note: 'Wordmark, three links and an action',
      css: '.nx-nav { display: flex; align-items: center; gap: calc(' + S + ' * 3); padding: calc(' + S + ' * 2) calc(' + S + ' * 3); border-bottom: 1px solid var(--line, #dcdad3); background: var(--paper, #f6f5f1); font-family: var(--font-body, system-ui, sans-serif); }\n' +
        '.nx-nav strong { font-family: var(--font-display, Georgia, serif); color: var(--ink, #1b1c1a); margin-right: auto; }\n' +
        '.nx-nav a { color: var(--ink, #1b1c1a); text-decoration: none; }\n' +
        '.nx-nav a:hover { color: var(--accent, #2f6f4f); }\n' +
        '.nx-nav a:focus-visible { ' + FOCUS + ' }\n' +
        '.nx-nav .nx-nav-cta { color: var(--accent, #2f6f4f); font-weight: 600; }',
      html: '<nav class="nx-nav" aria-label="Main">\n  <strong>Fieldnote</strong>\n  <a href="#product">Product</a>\n  <a href="#customers">Customers</a>\n  <a href="#pricing">Pricing</a>\n  <a class="nx-nav-cta" href="#signup">Sign up</a>\n</nav>',
    },
    {
      id: 'hero',
      label: 'Hero',
      note: 'A headline, one sentence and one action',
      css: '.nx-hero { padding: calc(' + S + ' * 12) calc(' + S + ' * 3); background: var(--paper, #f6f5f1); color: var(--ink, #1b1c1a); }\n' +
        '.nx-hero h1 { font-family: var(--font-display, Georgia, serif); font-size: clamp(2.2rem, 5vw, 3.8rem); line-height: 1.05; max-width: 18ch; margin: 0 0 calc(' + S + ' * 3); }\n' +
        '.nx-hero p { font-family: var(--font-body, system-ui, sans-serif); color: var(--muted, #5d5f58); max-width: var(--measure, 68ch); margin: 0 0 calc(' + S + ' * 4); }\n' +
        '.nx-hero a { display: inline-block; padding: calc(' + S + ' * 1.5) calc(' + S + ' * 3); border-radius: var(--radius, 6px); background: var(--accent, #2f6f4f); color: var(--paper, #f6f5f1); text-decoration: none; font-weight: 600; }\n' +
        '.nx-hero a:focus-visible { ' + FOCUS + ' }',
      html: '<section class="nx-hero">\n  <h1>Field notes that file themselves</h1>\n  <p>Record a site visit on your phone; the report is written, tagged and shared before you reach the car.</p>\n  <a href="#signup">Try it on your next visit</a>\n</section>',
    },
    {
      id: 'stat',
      label: 'Stat tile',
      note: 'One number, what it counts, and the change',
      css: '.nx-stat { display: inline-grid; gap: calc(' + S + ' / 2); padding: calc(' + S + ' * 2) calc(' + S + ' * 3); border: 1px solid var(--line, #dcdad3); border-radius: var(--radius, 6px); background: var(--paper, #f6f5f1); font-family: var(--font-body, system-ui, sans-serif); }\n' +
        '.nx-stat-value { font-family: var(--font-display, Georgia, serif); font-size: 2.4rem; line-height: 1; color: var(--ink, #1b1c1a); }\n' +
        '.nx-stat-label { color: var(--muted, #5d5f58); }\n' +
        '.nx-stat-delta { color: var(--accent, #2f6f4f); font-weight: 600; }',
      html: '<div class="nx-stat">\n  <span class="nx-stat-label">Active teams</span>\n  <span class="nx-stat-value">1,284</span>\n  <span class="nx-stat-delta">+6.2% since March</span>\n</div>',
    },
    {
      id: 'table',
      label: 'Table',
      note: 'A captioned data table with hairline rows',
      css: '.nx-table { border-collapse: collapse; width: 100%; max-width: 48rem; font-family: var(--font-body, system-ui, sans-serif); color: var(--ink, #1b1c1a); margin: calc(' + S + ' * 3) 0; }\n' +
        '.nx-table caption { text-align: left; color: var(--muted, #5d5f58); padding-bottom: ' + S + '; }\n' +
        '.nx-table th, .nx-table td { text-align: left; padding: ' + S + ' calc(' + S + ' * 2); border-bottom: 1px solid var(--line, #dcdad3); }\n' +
        '.nx-table th { font-weight: 600; }\n' +
        '.nx-table td.nx-num { text-align: right; font-variant-numeric: tabular-nums; }',
      html: '<table class="nx-table">\n  <caption>Open invoices, by region</caption>\n  <thead><tr><th scope="col">Region</th><th scope="col">Invoices</th><th scope="col">Amount due</th></tr></thead>\n  <tbody>\n    <tr><td>North</td><td class="nx-num">42</td><td class="nx-num">18,400</td></tr>\n    <tr><td>Coast</td><td class="nx-num">17</td><td class="nx-num">6,950</td></tr>\n    <tr><td>Valley</td><td class="nx-num">29</td><td class="nx-num">11,210</td></tr>\n  </tbody>\n</table>',
    },
    {
      id: 'modal',
      label: 'Modal',
      note: 'A confirm dialog, drawn in place',
      css: '.nx-modal { max-width: 28rem; padding: calc(' + S + ' * 3); border: 1px solid var(--line, #dcdad3); border-radius: var(--radius, 6px); background: var(--paper, #f6f5f1); color: var(--ink, #1b1c1a); box-shadow: 0 12px 32px color-mix(in srgb, var(--ink, #1b1c1a) 18%, transparent); font-family: var(--font-body, system-ui, sans-serif); margin: calc(' + S + ' * 4) auto; }\n' +
        '.nx-modal h2 { font-family: var(--font-display, Georgia, serif); margin: 0 0 ' + S + '; font-size: 1.4rem; }\n' +
        '.nx-modal p { color: var(--muted, #5d5f58); margin: 0 0 calc(' + S + ' * 3); }\n' +
        '.nx-modal-actions { display: flex; justify-content: flex-end; gap: ' + S + '; }\n' +
        '.nx-modal button { font: inherit; padding: ' + S + ' calc(' + S + ' * 2); border-radius: var(--radius, 6px); border: 1px solid var(--accent, #2f6f4f); background: var(--paper, #f6f5f1); color: var(--accent, #2f6f4f); cursor: pointer; }\n' +
        '.nx-modal button.nx-modal-confirm { background: var(--accent, #2f6f4f); color: var(--paper, #f6f5f1); }\n' +
        '.nx-modal button:focus-visible { ' + FOCUS + ' }',
      html: '<div class="nx-modal" role="dialog" aria-labelledby="nx-modal-title">\n  <h2 id="nx-modal-title">Archive this project?</h2>\n  <p>It leaves the dashboard, and everyone on the team can still restore it for thirty days.</p>\n  <div class="nx-modal-actions">\n    <button type="button">Keep it</button>\n    <button type="button" class="nx-modal-confirm">Archive</button>\n  </div>\n</div>',
    },
    {
      id: 'badge',
      label: 'Badge',
      note: 'A small status label',
      css: '.nx-badge { display: inline-block; padding: calc(' + S + ' / 2) ' + S + '; border-radius: 999px; border: 1px solid var(--accent, #2f6f4f); color: var(--accent, #2f6f4f); background: var(--paper, #f6f5f1); font: 600 0.8rem/1.2 var(--font-body, system-ui, sans-serif); letter-spacing: 0.02em; }',
      html: '<span class="nx-badge">In review</span>',
    },
    {
      id: 'footer',
      label: 'Footer',
      note: 'Links, an address line and the fine print',
      css: '.nx-footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: calc(' + S + ' * 3); padding: calc(' + S + ' * 4) calc(' + S + ' * 3); border-top: 1px solid var(--line, #dcdad3); background: var(--paper, #f6f5f1); color: var(--muted, #5d5f58); font-family: var(--font-body, system-ui, sans-serif); }\n' +
        '.nx-footer nav { display: flex; gap: calc(' + S + ' * 2); }\n' +
        '.nx-footer a { color: var(--ink, #1b1c1a); }\n' +
        '.nx-footer a:focus-visible { ' + FOCUS + ' }',
      html: '<footer class="nx-footer">\n  <p>Fieldnote Ltd · 12 Harbour Street, Leith</p>\n  <nav aria-label="Footer">\n    <a href="#privacy">Privacy</a>\n    <a href="#terms">Terms</a>\n    <a href="#status">Status</a>\n  </nav>\n</footer>',
    },
  ];

  function get(id) {
    for (var i = 0; i < COMPONENTS.length; i += 1) if (COMPONENTS[i].id === id) return COMPONENTS[i];
    return null;
  }

  function styleTag(c) {
    return '<style data-neura-component="' + c.id + '">\n' + c.css + '\n</style>';
  }

  /** A snippet on its own: its style block and its markup. */
  function snippet(id) {
    var c = get(id);
    return c ? styleTag(c) + '\n' + c.html : '';
  }

  function lastIndexOfTag(src, tag) {
    var re = new RegExp('</' + tag + '\\s*>', 'gi');
    var at = -1;
    var m;
    while ((m = re.exec(src))) at = m.index;
    return at;
  }

  /**
   * The page with the component added: its CSS once (in the head when there
   * is one), its markup before the last </main>, else before </body>, else at
   * the end. An unknown id returns the page unchanged.
   */
  function insertInto(html, id) {
    var c = get(id);
    var src = String(html == null ? '' : html);
    if (!c) return src;
    var marker = 'data-neura-component="' + c.id + '"';
    var style = src.indexOf(marker) === -1 ? styleTag(c) : '';
    var markup = c.html;
    if (style) {
      var head = lastIndexOfTag(src, 'head');
      if (head >= 0) {
        src = src.slice(0, head) + style + '\n' + src.slice(head);
      } else {
        markup = style + '\n' + markup;
      }
    }
    var at = lastIndexOfTag(src, 'main');
    if (at < 0) at = lastIndexOfTag(src, 'body');
    if (at < 0) return src + '\n' + markup + '\n';
    return src.slice(0, at) + markup + '\n' + src.slice(at);
  }

  return {
    COMPONENTS: COMPONENTS,
    get: get,
    snippet: snippet,
    insertInto: insertInto,
  };
});
