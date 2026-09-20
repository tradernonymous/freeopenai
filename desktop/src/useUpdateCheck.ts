// The update check as a hook, so App.tsx composes it instead of implementing it.
//
// App.tsx used to hold the polling interval, the dismissed-version key, the
// "is it newer" decision and the installer derivation -- four policies from a
// different concern sitting in the shell. The pure rules stay in update.js
// (version comparison, payload reading, retry/backoff); this is only their
// React binding.
import { useCallback, useEffect, useState } from 'react';
import './update.js';
import { APP_VERSION } from './version';

const update: typeof import('./update.js') = (globalThis as any).FreeAI4UUpdate;

const DISMISSED_KEY = 'freeai4u.updateDismissed';
const POLL_MS = 1000 * 60 * 60;

export interface UpdateCheck {
  /** The newer release, or null when this build is current (or unknown). */
  info: import('./update.js').VersionPayload | null;
  /** The artifact an update would install, when there is one. */
  installer: import('./update.js').UpdateArtifact | null;
  /** Hide this version until a newer one is published. */
  dismiss: () => void;
  /** "12.4 MB" for an artifact size. */
  humanSize: (bytes: number) => string;
  /** Where a user goes to get it. */
  releaseUrl: string;
}

function dismissedVersion(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) || '';
  } catch {
    return '';
  }
}

function rememberDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch { /* best effort */ }
}

export function useUpdateCheck(): UpdateCheck {
  const [info, setInfo] = useState<import('./update.js').VersionPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const found = await update.fetchVersion({ fetchImpl: fetch });
      if (cancelled || !found || !update.isNewer(found.version, APP_VERSION)) return;
      if (dismissedVersion() === found.version) return;
      setInfo(found);
    };
    check();
    const interval = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const dismiss = useCallback(() => {
    setInfo((current) => {
      if (current) rememberDismissed(current.version);
      return null;
    });
  }, []);

  return {
    info,
    installer: update.installerFor(info),
    dismiss,
    humanSize: update.humanSize,
    releaseUrl: update.desktopUrl(),
  };
}
