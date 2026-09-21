'use strict';

// The artifacts canvas: the state and decisions behind the preview pane.
//
// This used to live inline in index.html, where the only way to test it was to
// extract page functions with a brace-walking harness. The logic is here now,
// constructed with everything injectable, the way share-memory.js and
// image-store.js do it; the page keeps only the DOM half. index.html creates
// one instance at boot:
//
//   const canvasArtifacts = CanvasArtifacts.create({ ...seams... });
//
// Nothing in here touches document — the page injects a `frame` setter, an
// `onBlocks` hook, and element lookups, and renders from the module's state
// itself. The sandboxing rule this module carries: every artifact renders
// through `srcdoc` on an opaque-origin iframe (allow-scripts, never
// same-origin) — the module builds documents, never origins.

(function attachCanvasArtifacts(root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CanvasArtifacts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function CanvasArtifactsFactory() {
  const HIDDEN_KEY = 'freeopenaiCanvasHidden';
  // A block that opens with this marker is a JSX stage, not a plain page.
  const REACT_MARKER = '<!-- canvas react -->';
  // Fences in these languages get a Preview/Canvas button. jsx/tsx/js/javascript
  // run through the React+Babel stage directly -- the marker above stays only
  // for the rarer case of an html-fenced block that still wants React.
  const CANVAS_LANGS = ['html', 'jsx', 'tsx', 'js', 'javascript'];
  const REACT_LANGS = ['jsx', 'tsx', 'js', 'javascript'];
  const LANG_LABELS = { html: 'HTML', jsx: 'JSX', tsx: 'TSX', js: 'JS', javascript: 'JS' };

  function create(deps) {
    const {
      // Browser machinery, injected so a test can stand in.
      localStorage,               // getItem/setItem, try/catch'd by the module
      doc,                        // { getElementById, querySelector }
      chatMessages,               // { querySelectorAll } — the transcript root
      onBlocks,                   // optional: called after the block list changes
      onOpenPane,                 // optional: called when the pane opens (page closes the session panel)
      // Page-scope helper names stay injected: the page's own copies are
      // bare globals, so tests supply them either way.
      artifactDocument,           // (code) => full document for the frame
      canvasShell,                // () => the .chat-shell element (or null)
    } = deps;

    let blocks = [];
    let index = -1;

    // ---- document building ----------------------------------------------

    // Build the document a block runs in. Plain blocks are wrapped in a
    // bare shell so a fragment renders; a block that opens with the react
    // marker gets React + Babel so JSX actually runs. Script tags are
    // written as split strings so this page's own <script> never closes
    // early on the string content.
    function buildArtifactDocument(code, lang) {
      const text = String(code || '');
      const trimmed = text.replace(/^\s+/, '');
      const markedReact = trimmed.indexOf(REACT_MARKER) === 0;
      // A jsx/tsx/js fence is a JSX stage on its own -- the marker is only
      // needed to opt an html-fenced block into the same treatment.
      if (markedReact || REACT_LANGS.indexOf(lang) !== -1) {
        const body = markedReact ? trimmed.slice(REACT_MARKER.length) : trimmed;
        const tsPreset = lang === 'tsx' ? ' data-presets="typescript"' : '';
        return '<!doctype html><html><head><meta charset="utf-8">'
          + '<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"><' + '/script>'
          + '<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><' + '/script>'
          + '<script src="https://unpkg.com/@babel/standalone/babel.min.js"><' + '/script>'
          + '</head><body><div id="root"></div><script type="text/babel"' + tsPreset + '>'
          + body
          + '<' + '/script></body></html>';
      }
      const fullPage = /^<!doctype/i.test(trimmed) || /^<html/i.test(trimmed) || /^<head/i.test(trimmed) || /^<body/i.test(trimmed);
      if (fullPage) return trimmed;
      return '<!doctype html><html><head><meta charset="utf-8"></head><body>' + trimmed + '</body></html>';
    }

    // ---- block list ------------------------------------------------------

    function blocksList() {
      return blocks;
    }

    function currentIndex() {
      return index;
    }

    // The label names the block from its first content, so the picker is
    // readable without opening anything.
    function labelFor(code, lang) {
      const first = String(code || '').replace(/\s+/g, ' ').trim().slice(0, 42);
      const tag = LANG_LABELS[lang] || 'HTML';
      return tag + ' — ' + (first || 'empty block');
    }

    function codeOfPre(pre) {
      const codeEl = pre.querySelector('code');
      return codeEl ? codeEl.textContent : pre.textContent;
    }

    // Rebuild the block list from the HTML blocks currently on screen. Runs
    // on every message re-render (so streaming blocks join as they complete)
    // and when the canvas opens. A block only exists once its closing fence
    // is on screen, so this is always whole-block work.
    function collectBlocks() {
      const hadBlocks = blocks.length > 0;
      // Advance to the newest block only when the reader is following
      // the tail -- the pane was empty, or the last block they had open
      // is the newest again. An explicit pick of an older block stays
      // put when a newer one arrives.
      const wasFollowing = !hadBlocks || index === blocks.length - 1;
      blocks = [];
      const pres = chatMessages.querySelectorAll('.message .message-text pre[data-lang]');
      pres.forEach((pre) => {
        const lang = pre.dataset && pre.dataset.lang;
        if (CANVAS_LANGS.indexOf(lang) === -1) return;
        const code = codeOfPre(pre);
        if (blocks.some((b) => b.code === code)) return;
        blocks.push({ code, lang, label: labelFor(code, lang) });
      });
      if (!blocks.length) index = -1;
      else if (wasFollowing || index < 0) index = blocks.length - 1;
      if (onBlocks) onBlocks();
      return blocks;
    }

    function selectBlock(i) {
      if (!blocks.length) { index = -1; return; }
      index = Math.max(0, Math.min(i, blocks.length - 1));
    }

    // The Canvas button on a block: register the block and open the pane on
    // it. The block is a live copy of whatever is on screen.
    function openForPre(pre) {
      const code = codeOfPre(pre);
      const lang = pre.dataset && pre.dataset.lang;
      const hit = blocks.findIndex((b) => b.code === code);
      const at = hit === -1 ? blocks.length : hit;
      if (hit === -1) blocks.push({ code, lang, label: labelFor(code, lang) });
      selectBlock(at);
      showPane(true);
    }

    // ---- pane show/hide ---------------------------------------------------

    function shell() {
      const found = canvasShell ? canvasShell() : (doc && doc.querySelector ? doc.querySelector('#viewChat .chat-shell') : null);
      const el = typeof found === 'function' ? found() : found;
      return el && typeof el.classList !== 'undefined' && typeof el.classList.contains === 'function' ? el : null;
    }

    // force true shows, false hides, undefined toggles. persist false is
    // for restoring a stored choice or cross-panel closing.
    function showPane(force, persist) {
      if (persist === undefined) persist = true;
      const el = shell();
      if (!el) return;
      const hidden = force === undefined ? !el.classList.contains('canvas-hidden') : !force;
      el.classList.toggle('canvas-hidden', hidden);
      const pane = doc.getElementById('canvasPane');
      const scrim = doc.getElementById('canvasScrim');
      if (pane) {
        pane.setAttribute('aria-hidden', String(hidden));
        if (typeof pane.toggleAttribute === 'function') pane.toggleAttribute('inert', hidden);
        else if (hidden) pane.setAttribute('inert', '');
        else if (typeof pane.removeAttribute === 'function') pane.removeAttribute('inert');
      }
      if (scrim) scrim.setAttribute('aria-hidden', String(hidden));
      // The two right-hand panes cannot share a corner: opening one
      // closes the other, so the session work never sits under the
      // artifact being read.
      if (!hidden && onOpenPane) onOpenPane();
      if (!persist) return;
      try {
        localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '');
      } catch {
        // A browser refusing storage shouldn't break the toggle itself.
      }
    }

    function restorePane() {
      let stored = null;
      try {
        stored = localStorage.getItem(HIDDEN_KEY);
      } catch {
        stored = null;
      }
      // Closed by default, same reasoning as the session panel: it opens
      // when there is something to look at, not on load.
      const hidden = stored === null || stored === undefined ? true : stored === '1';
      showPane(!hidden, false);
    }

    function isHidden() {
      const el = shell();
      return !el || el.classList.contains('canvas-hidden');
    }

    return {
      buildArtifactDocument,
      blocksList,
      currentIndex,
      collectBlocks,
      selectBlock,
      openForPre,
      showPane,
      restorePane,
      isHidden,
      // exposed so a test can prove the key name too
      HIDDEN_KEY,
    };
  }

  return { create, REACT_MARKER, CANVAS_LANGS };
});
