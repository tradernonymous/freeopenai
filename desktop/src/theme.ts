// The theme, in one place.
//
// App.tsx used to have two effects: one wrote the theme out on every change,
// one read it back on mount. That is two owners of one value, and the first
// paint always used the default before the second effect corrected it. Here the
// theme is read once (so the first paint is already right) and written on
// change, and the storage key lives with the value it names.

export type Theme = 'light' | 'dark';

const THEME_KEY = 'freeai4u-theme';
const DEFAULT_THEME: Theme = 'dark';

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Paint the theme and remember it. Safe when storage is unavailable. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch { /* private mode: the theme still applies to this window */ }
}

export function toggleTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}
