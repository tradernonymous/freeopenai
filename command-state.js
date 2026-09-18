'use strict';

(function attachCommandState(root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.NeuraOSCommandState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function commandStateFactory() {
  const COMMAND_STATES = ['ready', 'plan', 'build', 'draw', 'running'];

  function commandStateOf({ isTyping = false, imageMode = false, selectedMode = 'chat' } = {}) {
    if (isTyping) return 'running';
    if (imageMode) return 'draw';
    if (selectedMode === 'plan' || selectedMode === 'build') return selectedMode;
    return 'ready';
  }

  function commandStateLabel(state) {
    return COMMAND_STATES.includes(state) ? state.toUpperCase() : 'READY';
  }

  return { COMMAND_STATES, commandStateOf, commandStateLabel };
});
