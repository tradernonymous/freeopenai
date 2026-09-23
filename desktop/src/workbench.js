// The two rails' memory (NEURA-069). Both the left sidebar and the right
// workbench peek open on hover and stay open when pinned, and the choice is
// the person's, so it outlives the window: three keys, one per decision.
//
// This module only decides; the components render the answer. Keeping it out
// of the .tsx means the "damaged storage" cases -- a private window where
// getItem throws, a key someone else wrote a JSON blob into -- are tested
// without a DOM, which is where every other persisted setting in this app is
// tested too.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FreeAI4UWorkbench = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var LEFT_KEY = 'freeai4u.rail.left.pinned';
  var RIGHT_KEY = 'freeai4u.rail.right.pinned';
  var TOOL_KEY = 'freeai4u.rail.right.tool';

  /**
   * The right rail's four tools, in rail order. `icon` names a path in
   * components/Icon.tsx; `blurb` is what the panel says the tool is for, in
   * the second person, because a panel that only repeats its own title has
   * told the reader nothing.
   */
  var TOOLS = [
    {
      id: 'design',
      label: 'Design',
      icon: 'design',
      blurb: 'Mockups, themes and the page the model drew, side by side with the chat that asked for them.',
    },
    {
      id: 'build',
      label: 'Build',
      icon: 'build',
      blurb: 'Long-running builds and the approvals they stop for, so a build keeps running while you read something else.',
    },
    {
      id: 'files',
      label: 'Files',
      icon: 'folder',
      blurb: 'The folder you opened, one level at a time.',
    },
    {
      id: 'changes',
      label: 'Changes',
      icon: 'activity',
      blurb: 'What the agent edited in the open folder, and what it has not committed.',
    },
  ];

  var DEFAULT_TOOL = TOOLS[0].id;

  function toolIds() {
    return TOOLS.map(function (t) { return t.id; });
  }

  function toolAt(id) {
    for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].id === id) return TOOLS[i];
    return null;
  }

  /** Anything that is not one of the four tools is the first one. */
  function cleanTool(value) {
    return toolAt(String(value || '')) ? String(value) : DEFAULT_TOOL;
  }

  function storage(store) {
    return store || (typeof globalThis !== 'undefined' ? globalThis.localStorage : null);
  }

  /**
   * A rail is pinned only when it was written as pinned. Every other answer --
   * never set, a blob of JSON, a store that throws -- means "not pinned",
   * which is the state that hides nothing and loses nothing.
   */
  function readPinned(key, store) {
    try {
      return storage(store).getItem(key) === '1';
    } catch (e) {
      return false;
    }
  }

  function writePinned(key, value, store) {
    try {
      storage(store).setItem(key, value ? '1' : '0');
    } catch (e) {
      /* A rail that forgets its pin is still a usable rail. */
    }
  }

  function readTool(store) {
    try {
      return cleanTool(storage(store).getItem(TOOL_KEY));
    } catch (e) {
      return DEFAULT_TOOL;
    }
  }

  function writeTool(id, store) {
    try {
      storage(store).setItem(TOOL_KEY, cleanTool(id));
    } catch (e) {
      /* see writePinned */
    }
  }

  /** The `data-pinned` attribute the stylesheet switches the layout on. */
  function pinnedAttr(pinned) {
    return pinned ? 'true' : 'false';
  }

  /**
   * Escape closes a rail that is only peeking. A pinned rail is a place the
   * person put there on purpose, so Escape leaves it alone -- the pin button
   * is the way back out of that one.
   */
  function closesOnEscape(pinned) {
    return !pinned;
  }

  return {
    LEFT_KEY: LEFT_KEY,
    RIGHT_KEY: RIGHT_KEY,
    TOOL_KEY: TOOL_KEY,
    TOOLS: TOOLS,
    DEFAULT_TOOL: DEFAULT_TOOL,
    toolIds: toolIds,
    toolAt: toolAt,
    cleanTool: cleanTool,
    readPinned: readPinned,
    writePinned: writePinned,
    readTool: readTool,
    writeTool: writeTool,
    pinnedAttr: pinnedAttr,
    closesOnEscape: closesOnEscape,
  };
});
