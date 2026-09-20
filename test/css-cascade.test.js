// A media query adds no specificity. That is the whole bug this file exists for:
// three phone clamps on the composer row were written as `.model-trigger
// span#modelLabel` and `.effort-select`, while the unconditional rules were
// `.composer-controls .model-trigger #modelLabel` and `.composer-controls
// .effort-select`. One id and two classes beats one id, one class and an element,
// so every phone rendered the desktop widths: the row wanted 383px, a 390px
// screen gave it 350px, and the mode chip sat entirely past the right edge.
//
// Nothing flagged it. eslint does not read CSS, the unit tests do not render, and
// the browser smoke only checked that those controls existed. A narrow rule that
// silently loses reads exactly like a fix.
//
// So: for every declaration inside a @media block, find the unconditional rules
// that set the same property on the same kind of element, and fail if one of them
// wins. Comparison is limited to rules whose rightmost compound selector is
// identical -- enough to catch this class without guessing which selectors can
// match the same element.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const PSEUDO_ELEMENT = '\u0001';

function styleBlocks(html) {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

// a = ids, b = classes/attributes/pseudo-classes, c = elements/pseudo-elements.
function specificity(selector) {
  const cleaned = selector
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/::[\w-]+/g, ' ' + PSEUDO_ELEMENT)
    .replace(/:(?:not|is|where)\([^)]*\)/g, ' ')
    .replace(/\s*[>+~]\s*/g, ' ');
  let a = 0;
  let b = 0;
  let c = 0;
  for (const token of cleaned.split(/\s+/).filter(Boolean)) {
    a += (token.match(/#[\w-]+/g) || []).length;
    b += (token.match(/\.[\w-]+/g) || []).length;
    b += (token.match(/\[[^\]]*\]/g) || []).length;
    b += (token.match(/:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
    if (token.includes(PSEUDO_ELEMENT)) c += 1;
    // A bare element name only counts when the compound starts with one.
    else if (/^[a-zA-Z][\w-]*/.test(token)) c += 1;
  }
  return a * 10000 + b * 100 + c;
}

// The rightmost compound -- `#modelLabel` from `.a .b #modelLabel`. Two rules with
// the same one are aimed at the same thing, which is what makes them comparable
// without a DOM.
function target(selector) {
  const parts = selector.trim().replace(/\s*[>+~]\s*/g, ' ').split(/\s+/);
  return parts[parts.length - 1] || '';
}

// Whether a rule applies whenever its element is on the page, or only in some
// state of it. A rule that needs a state cannot be said to beat a media rule:
// `.chat-shell.history-hidden .history-sidebar` sets a width only while the
// sidebar is closed, and `.history-item:hover .history-delete` only under a
// pointer -- so the media rule still governs the rest of the time, which is the
// whole point of it. Without this the check reports those as dead and is wrong.
function needsAState(selector) {
  const compounds = selector.trim().replace(/\s*[>+~]\s*/g, ' ').split(/\s+/);
  return compounds.some((compound) => {
    if (/:(?!:)[\w-]/.test(compound)) return true; // :hover, :focus-within, :not(...)
    if (/\[/.test(compound)) return true; // [data-theme="light"], [hidden]
    // Two or more simple selectors chained onto one element -- `.a.b` -- is that
    // element in a particular state, not the element itself.
    const simples = (compound.match(/[.#][\w-]+/g) || []).length;
    return simples >= 2;
  });
}

// Flat list of { media, selector, prop, value, order } from a stylesheet, with
// nesting tracked so a declaration knows which @media it sits inside.
function declarations(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rows = [];
  const stack = [];
  let buffer = '';
  let order = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
      continue;
    }
    if (ch === '}') {
      const head = stack.pop();
      if (head && !head.startsWith('@')) {
        const media = stack.filter((s) => s.startsWith('@media')).join(' and ');
        for (const piece of buffer.split(';')) {
          const at = piece.indexOf(':');
          if (at < 1) continue;
          const prop = piece.slice(0, at).trim();
          const value = piece.slice(at + 1).trim();
          if (!/^[a-z-]+$/.test(prop) || !value) continue;
          for (const selector of head.split(',')) {
            if (!selector.trim()) continue;
            rows.push({ media, selector: selector.trim(), prop, value, order: order++ });
          }
        }
      }
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  return rows;
}

test('the specificity model agrees with the cases that caused the bug', () => {
  // The exact pair that went wrong, so a change to the scorer is caught here
  // rather than letting the real check below pass for the wrong reason.
  assert.ok(
    specificity('.composer-controls .model-trigger #modelLabel') >
      specificity('.model-trigger span#modelLabel'),
    'one id and two classes has to outrank one id, one class and an element',
  );
  assert.equal(specificity('#a'), 10000);
  assert.equal(specificity('.a'), 100);
  assert.equal(specificity('div'), 1);
  assert.equal(specificity('.a .b #c'), 10200);
  assert.equal(specificity('.a span#c'), 10101);
  assert.equal(specificity('a:hover'), 101);
  assert.equal(specificity('.x::after'), 101);
});

test('a rule that needs a state is not treated as beating a media rule', () => {
  // These were the false readings the first version of this check produced.
  assert.equal(needsAState('.chat-shell.history-hidden .history-sidebar'), true);
  assert.equal(needsAState('.history-item:hover .history-delete'), true);
  assert.equal(needsAState('html[data-theme="light"] .message-text pre'), true);
  assert.equal(needsAState('.chat-messages.no-anim .message'), true);
  // And these apply whenever the element is there, so they really do beat one.
  assert.equal(needsAState('.composer-controls .model-trigger #modelLabel'), false);
  assert.equal(needsAState('.composer-controls .effort-select'), false);
  assert.equal(needsAState('.message-text pre'), false);
});

test('no rule inside a @media is overruled by one outside it', () => {
  const blocks = styleBlocks(HTML);
  assert.ok(blocks.length >= 1, 'expected an inline stylesheet');
  const rows = blocks.flatMap((css) => declarations(css));
  assert.ok(rows.length > 500, `only parsed ${rows.length} declarations -- the parser has drifted`);

  const unconditional = rows.filter((r) => !r.media);
  const dead = [];
  for (const row of rows) {
    if (!row.media) continue;
    const mine = specificity(row.selector);
    const aim = target(row.selector);
    if (!aim) continue;
    for (const rival of unconditional) {
      if (rival.prop !== row.prop) continue;
      if (target(rival.selector) !== aim) continue;
      if (needsAState(rival.selector)) continue;
      const theirs = specificity(rival.selector);
      // A rule outside a media query wins if it is more specific, or as specific
      // and written later. Either way the narrow rule never applies.
      if (theirs > mine || (theirs === mine && rival.order > row.order)) {
        dead.push(
          `${row.media} { ${row.selector} { ${row.prop} } } never applies -- ` +
            `"${rival.selector}" (${theirs}) beats "${row.selector}" (${mine})`,
        );
        break;
      }
    }
  }
  assert.deepEqual(dead, [], 'these narrow rules are dead; raise their specificity to match the wide rule');
});
