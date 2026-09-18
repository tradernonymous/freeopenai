import { useEffect } from 'react';

type ShortcutMap = Record<string, () => void>;

export function useKeyboardShortcuts(shortcuts: ShortcutMap) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const shortcut = shortcuts[key];
      if (shortcut) {
        e.preventDefault();
        shortcut();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [shortcuts]);
}
