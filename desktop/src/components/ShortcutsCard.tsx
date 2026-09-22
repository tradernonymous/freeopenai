import { useState } from 'react';
import { NAV_ITEMS } from '../Sidebar';
import { pushToast } from './Toasts';
import { hasShell, quickHotkeySet, selectionHotkeySet } from '../bridge';
import '../keymap.js';

const keymap: typeof import('../keymap.js') = (globalThis as any).FreeAI4UKeymap;

/** The Quick window's global hotkey, as the person set it (the shell's default otherwise). */
export const QUICK_HOTKEY_KEY = 'freeai4u.quick_hotkey';
const QUICK_DEFAULT = 'Alt+Space';
/** The selection hotkey: copies what is selected in any app into Quick. */
export const SELECTION_HOTKEY_KEY = 'freeai4u.selection_hotkey';
const SELECTION_DEFAULT = 'Alt+Shift+Space';

// Shortcuts, in Settings: the one table App.tsx resolves keys from, shown as a
// list you can change. "Change" records the next combo pressed; a clash with
// another action or a navigation key is named at once, not discovered later.

const COMPOSER_KEYS: Array<[string, string]> = [
  ['Enter / Shift+Enter', 'Send / new line'],
  ['Tab / Shift+Tab', 'Chat → Plan → Build'],
  ['! at the start', 'Run a command in the open folder'],
  ['/ and @', 'Commands; models, files and MCP servers'],
  ['Backspace at start, Esc', 'Leave the mode; Esc also stops a reply'],
  ['Up in an empty box', 'Bring back the last message'],
];

export default function ShortcutsCard() {
  const [overrides, setOverrides] = useState(() => keymap.readOverrides());
  const [on, setOn] = useState(() => keymap.enabled());
  const [recording, setRecording] = useState('');
  const [quickKey, setQuickKey] = useState(() => { try { return localStorage.getItem(QUICK_HOTKEY_KEY) || QUICK_DEFAULT; } catch { return QUICK_DEFAULT; } });
  const [selectionKey, setSelectionKey] = useState(() => { try { return localStorage.getItem(SELECTION_HOTKEY_KEY) || SELECTION_DEFAULT; } catch { return SELECTION_DEFAULT; } });

  // A global hotkey belongs to the whole desktop, so it is taken by the shell
  // and can fail when another app owns the chord -- which is said, not hidden.
  const recordQuick = (e: React.KeyboardEvent) => {
    e.preventDefault();
    if (e.key === 'Escape') { setRecording(''); return; }
    const combo = keymap.comboOf(e);
    if (!combo || !/^(Ctrl|Alt)\+/.test(combo)) return;
    quickHotkeySet(combo.toLowerCase())
      .then(() => {
        try { localStorage.setItem(QUICK_HOTKEY_KEY, combo); } catch { /* this session has it */ }
        setQuickKey(combo);
        pushToast('ok', `The Quick window now opens with ${combo}, from any app.`);
      })
      .catch((err: unknown) => pushToast('error', ((err as Error).message || String(err)).split('\n')[0]))
      .finally(() => setRecording(''));
  };
  const recordSelection = (e: React.KeyboardEvent) => {
    e.preventDefault();
    if (e.key === 'Escape') { setRecording(''); return; }
    const combo = keymap.comboOf(e);
    if (!combo || !/^(Ctrl|Alt)\+/.test(combo)) return;
    selectionHotkeySet(combo.toLowerCase())
      .then(() => {
        try { localStorage.setItem(SELECTION_HOTKEY_KEY, combo); } catch { /* this session has it */ }
        setSelectionKey(combo);
        pushToast('ok', `Select text in any app and press ${combo} to ask about it.`);
      })
      .catch((err: unknown) => pushToast('error', ((err as Error).message || String(err)).split('\n')[0]))
      .finally(() => setRecording(''));
  };
  const bindings = keymap.withOverrides(overrides);
  const reserved = NAV_ITEMS.map((n) => ({ id: `go to ${n.label}`, keys: n.keys }));
  const clashes = keymap.conflicts(bindings, reserved);

  const record = (id: string, e: React.KeyboardEvent) => {
    e.preventDefault();
    if (e.key === 'Escape') { setRecording(''); return; }
    const combo = keymap.comboOf(e);
    if (!combo || !/^(Ctrl|Alt)\+/.test(combo)) return; // wait for a real chord
    setOverrides(keymap.setOverride(id, combo));
    setRecording('');
    pushToast('ok', `${id} is now ${combo}.`);
  };

  return (
    <div className="settings-card">
      <label className="toggle">
        <input type="checkbox" checked={on} onChange={(e) => { keymap.setEnabled(e.target.checked); setOn(e.target.checked); }} />
        Keyboard shortcuts on
      </label>
      <p className="settings-hint">
        With them off, only Ctrl+K, Esc and Ctrl+Shift+Z still answer — the ways back in are never switched off.
      </p>
      <div className="shortcut-table">
        {bindings.map((b) => (
          <div key={b.id} className="shortcut-row">
            <span className="shortcut-label">{b.label}</span>
            <kbd className={b.custom ? 'is-custom' : ''}>{b.keys}</kbd>
            {!b.fixed && (
              recording === b.id
                ? <button className="primary" autoFocus onKeyDown={(e) => record(b.id, e)} onBlur={() => setRecording('')}>Press a combo…</button>
                : <button onClick={() => setRecording(b.id)}>Change</button>
            )}
            {b.custom && <button className="linkish" onClick={() => setOverrides(keymap.setOverride(b.id, null))}>Reset</button>}
          </div>
        ))}
        <div className="shortcut-row">
          <span className="shortcut-label">Quick window, from any app</span>
          <kbd className={quickKey !== QUICK_DEFAULT ? 'is-custom' : ''}>{quickKey}</kbd>
          {hasShell() && (recording === 'quick'
            ? <button className="primary" autoFocus onKeyDown={recordQuick} onBlur={() => setRecording('')}>Press a combo…</button>
            : <button onClick={() => setRecording('quick')}>Change</button>)}
        </div>
        <div className="shortcut-row">
          <span className="shortcut-label">Ask about selected text, in any app</span>
          <kbd className={selectionKey !== SELECTION_DEFAULT ? 'is-custom' : ''}>{selectionKey}</kbd>
          {hasShell() && (recording === 'selection'
            ? <button className="primary" autoFocus onKeyDown={recordSelection} onBlur={() => setRecording('')}>Press a combo…</button>
            : <button onClick={() => setRecording('selection')}>Change</button>)}
        </div>
        {NAV_ITEMS.map((n) => (
          <div key={n.id} className="shortcut-row">
            <span className="shortcut-label">Go to {n.label}</span>
            <kbd>{n.keys}</kbd>
          </div>
        ))}
      </div>
      {clashes.length > 0 && (
        <div className="chip-note" role="alert">
          {clashes.map((c) => `${c.keys}: ${c.ids.join(' and ')}${c.reason ? ` (${c.reason})` : ''}`).join(' · ')}
        </div>
      )}
      <h3 className="local-heading">In the composer</h3>
      <div className="shortcut-table">
        {COMPOSER_KEYS.map(([keys, what]) => (
          <div key={keys} className="shortcut-row">
            <span className="shortcut-label">{what}</span>
            <kbd>{keys}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
