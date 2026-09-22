// The theme, in one place.
//
// App.tsx used to have two effects: one wrote the theme out on every change,
// one read it back on mount. That is two owners of one value, and the first
// paint always used the default before the second effect corrected it. Here the
// theme is read once (so the first paint is already right) and written on
// change, and the storage key lives with the value it names.

import { useEffect } from 'react';

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

// ---- appearance: the accent hue and the amount of motion -------------------
//
// Both are read and painted in main.tsx BEFORE React renders, so the first
// frame already has the person's colour and never animates when they asked it
// not to. index.css derives every accent token from --accent-h with a fixed
// lightness and chroma per theme, which is what keeps text on and around the
// accent at WCAG AA whatever hue is picked (test/desktop-look.test.js sweeps it).

export const ACCENT_HUE_KEY = 'freeai4u.accent_hue';
/** Today's green: #4ade80 / #166534 are both oklch hue ~151.7. */
export const DEFAULT_ACCENT_HUE = 152;
export const REDUCE_MOTION_KEY = 'freeai4u.reduce_motion';

function clampHue(value: number): number {
  const n = Math.round(value);
  return ((n % 361) + 361) % 361;
}

export function readAccentHue(): number {
  try {
    const raw = localStorage.getItem(ACCENT_HUE_KEY);
    if (raw == null || raw === '') return DEFAULT_ACCENT_HUE;
    const n = Number(raw);
    return Number.isFinite(n) ? clampHue(n) : DEFAULT_ACCENT_HUE;
  } catch {
    return DEFAULT_ACCENT_HUE;
  }
}

/** Paint the hue; `null` resets to the default and forgets the choice. */
export function applyAccentHue(hue: number | null): number {
  const value = hue == null ? DEFAULT_ACCENT_HUE : clampHue(hue);
  document.documentElement.style.setProperty('--accent-h', String(value));
  try {
    if (hue == null) localStorage.removeItem(ACCENT_HUE_KEY);
    else localStorage.setItem(ACCENT_HUE_KEY, String(value));
  } catch { /* the hue still applies to this window */ }
  return value;
}

export function systemPrefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/** The stored choice, or the system's when there is none. */
export function readReduceMotion(): boolean {
  try {
    const raw = localStorage.getItem(REDUCE_MOTION_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* fall through to the system */ }
  return systemPrefersReducedMotion();
}

function paintMotion(reduced: boolean): void {
  if (reduced) document.documentElement.setAttribute('data-motion', 'reduced');
  else document.documentElement.removeAttribute('data-motion');
}

/** Paint and remember; `null` forgets the choice and follows the system again. */
export function applyReduceMotion(reduced: boolean | null): boolean {
  const value = reduced == null ? systemPrefersReducedMotion() : reduced;
  paintMotion(value);
  try {
    if (reduced == null) localStorage.removeItem(REDUCE_MOTION_KEY);
    else localStorage.setItem(REDUCE_MOTION_KEY, reduced ? '1' : '0');
  } catch { /* this window still has it */ }
  return value;
}

/** Boot: theme, hue and motion painted before the first frame. Writes nothing. */
export function paintAppearance(): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', readTheme());
  root.style.setProperty('--accent-h', String(readAccentHue()));
  paintMotion(readReduceMotion());
}

function motionReduced(): boolean {
  return document.documentElement.getAttribute('data-motion') === 'reduced' || systemPrefersReducedMotion();
}

/**
 * A very small parallax: the ambient layer behind the glass follows the
 * pointer by at most 6px. One rAF per frame at most, and the variables are
 * only written when the rounded offset changes -- they sit on <html>, so a
 * write restyles the tree, and a write per pixel would be a waste on a weak
 * GPU. Off (and reset) whenever motion is reduced; re-checked on every move,
 * so the Settings toggle takes effect without a reload.
 */
export function useParallax(maxPx = 6): void {
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    let lastX = 0;
    let lastY = 0;
    let px = 0;
    let py = 0;
    const write = (x: number, y: number) => {
      if (x === lastX && y === lastY) return;
      lastX = x;
      lastY = y;
      root.style.setProperty('--parallax-x', `${x}px`);
      root.style.setProperty('--parallax-y', `${y}px`);
    };
    const flush = () => {
      frame = 0;
      if (motionReduced()) { write(0, 0); return; }
      const w = globalThis.innerWidth || 1;
      const h = globalThis.innerHeight || 1;
      // Opposite to the pointer, like a far layer, quantised to half pixels.
      const x = Math.round(((0.5 - px / w) * 2 * maxPx) * 2) / 2;
      const y = Math.round(((0.5 - py / h) * 2 * maxPx) * 2) / 2;
      write(x, y);
    };
    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      if (!frame) frame = globalThis.requestAnimationFrame(flush);
    };
    globalThis.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      globalThis.removeEventListener('pointermove', onMove);
      if (frame) globalThis.cancelAnimationFrame(frame);
      root.style.removeProperty('--parallax-x');
      root.style.removeProperty('--parallax-y');
    };
  }, [maxPx]);
}
