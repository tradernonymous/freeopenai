'use strict';

(function attachTranscriptModule(root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FreeOpenAITranscript = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function transcriptFactory() {
  const TRANSCRIPT_BOTTOM_SLACK_PX = 120;
  const TRANSCRIPT_JUMP_SOURCES = ['own-message', 'user-request'];
  const TRANSCRIPT_QUIET_SOURCES = ['own-message', 'indicator', 'user-request'];

  function transcriptAtBottom(scrollTop, scrollHeight, clientHeight, slack = TRANSCRIPT_BOTTOM_SLACK_PX) {
    const top = Number(scrollTop) || 0;
    const height = Number(scrollHeight) || 0;
    const view = Number(clientHeight) || 0;
    if (height <= view) return true;
    return height - top - view <= Math.max(0, Number(slack) || 0);
  }

  function shouldFollowTranscript(source, pinned) {
    if (TRANSCRIPT_JUMP_SOURCES.includes(String(source || ''))) return true;
    return pinned === true;
  }

  function announcesUnread(source) {
    return !TRANSCRIPT_QUIET_SOURCES.includes(String(source || ''));
  }

  // Owns the transcript's mutable scroll state and its DOM seam. The page keeps
  // the public function names that old callers use, but they now delegate to one
  // controller instead of sharing state across ten unrelated append paths.
  function createTranscriptController(options = {}) {
    const element = options.element || null;
    const pill = options.pill || null;
    const windowRef = options.windowRef || (typeof window !== 'undefined' ? window : null);
    const documentRef = options.documentRef || (typeof document !== 'undefined' ? document : null);
    const raf = options.requestAnimationFrame || (windowRef && windowRef.requestAnimationFrame) ||
      (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
    const schedule = options.setTimeout || (windowRef && windowRef.setTimeout) || setTimeout;
    const cancel = options.clearTimeout || (windowRef && windowRef.clearTimeout) || clearTimeout;
    const isTyping = typeof options.isTyping === 'function' ? options.isTyping : () => false;
    let pinned = options.initialPinned !== false;
    let unread = 0;
    let layoutSettlingUntil = 0;
    let resizeTimer = 0;
    let attached = false;

    function labelElement() {
      if (pill && typeof pill.querySelector === 'function') return pill.querySelector('.scroll-bottom-label');
      return documentRef && typeof documentRef.querySelector === 'function'
        ? documentRef.querySelector('.scroll-bottom-label')
        : null;
    }

    function updateScrollBottomPill() {
      if (!pill) return;
      if (pill.classList && typeof pill.classList.toggle === 'function') pill.classList.toggle('visible', !pinned);
      const label = labelElement();
      if (!label) return;
      label.textContent = unread > 0 ? unread + ' new' : (isTyping() ? 'New output' : 'Newest');
    }

    function pinToBottom() {
      if (!element) return;
      element.scrollTop = element.scrollHeight;
      if (typeof raf !== 'function') return;
      let tries = 0;
      const settle = () => {
        if (!pinned) return;
        element.scrollTop = element.scrollHeight;
        const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
        if (gap > 4 && ++tries < 12) raf(settle);
      };
      raf(settle);
    }

    function setPinned(next) {
      const value = next === true;
      if (value === pinned) return;
      pinned = value;
      if (pinned) unread = 0;
      updateScrollBottomPill();
    }

    function append(child, source) {
      if (!element) return child;
      const detached = !pinned;
      element.appendChild(child);
      if (detached && announcesUnread(source)) unread += 1;
      if (shouldFollowTranscript(source, pinned)) {
        unread = 0;
        pinned = true;
        pinToBottom();
      }
      updateScrollBottomPill();
      return child;
    }

    function scroll(source) {
      if (element && shouldFollowTranscript(source, pinned)) element.scrollTop = element.scrollHeight;
    }

    function jumpToNewest() {
      unread = 0;
      pinned = true;
      pinToBottom();
      updateScrollBottomPill();
    }

    function handleScroll() {
      if (!element) return;
      const atBottom = transcriptAtBottom(element.scrollTop, element.scrollHeight, element.clientHeight);
      if (atBottom) unread = 0;
      else if (Date.now() < layoutSettlingUntil) return;
      setPinned(atBottom);
    }

    function handleResize() {
      const wasPinned = pinned;
      layoutSettlingUntil = Date.now() + 600;
      if (resizeTimer) cancel(resizeTimer);
      resizeTimer = schedule(() => {
        resizeTimer = 0;
        if (wasPinned) {
          pinned = true;
          pinToBottom();
        }
        updateScrollBottomPill();
      }, 150);
    }

    function handleVisualViewportResize() {
      if (!windowRef || !element) return;
      const viewport = windowRef.visualViewport;
      const keyboard = !!(windowRef.innerHeight && viewport && viewport.height < windowRef.innerHeight - 120);
      if (documentRef && documentRef.body && documentRef.body.classList) {
        documentRef.body.classList.toggle('keyboard-open', keyboard);
      }
      if (pinned) element.scrollTop = element.scrollHeight;
    }

    function attach() {
      if (attached) return;
      attached = true;
      element && element.addEventListener && element.addEventListener('scroll', handleScroll);
      windowRef && windowRef.addEventListener && windowRef.addEventListener('resize', handleResize);
      const viewport = windowRef && windowRef.visualViewport;
      viewport && viewport.addEventListener && viewport.addEventListener('resize', handleVisualViewportResize);
    }

    function destroy() {
      if (!attached) return;
      attached = false;
      element && element.removeEventListener && element.removeEventListener('scroll', handleScroll);
      windowRef && windowRef.removeEventListener && windowRef.removeEventListener('resize', handleResize);
      const viewport = windowRef && windowRef.visualViewport;
      viewport && viewport.removeEventListener && viewport.removeEventListener('resize', handleVisualViewportResize);
      if (resizeTimer) cancel(resizeTimer);
      resizeTimer = 0;
    }

    return {
      updateScrollBottomPill,
      pinToBottom,
      setPinned,
      append,
      scroll,
      jumpToNewest,
      handleScroll,
      handleResize,
      attach,
      destroy,
      get pinned() { return pinned; },
      get unread() { return unread; },
    };
  }

  return {
    TRANSCRIPT_BOTTOM_SLACK_PX,
    TRANSCRIPT_JUMP_SOURCES,
    TRANSCRIPT_QUIET_SOURCES,
    transcriptAtBottom,
    shouldFollowTranscript,
    announcesUnread,
    createTranscriptController,
  };
});
