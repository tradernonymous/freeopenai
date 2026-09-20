// The update check as a hook, so App.tsx composes it instead of implementing it.
//
// App.tsx used to hold the polling interval, the dismissed-version key, the
// "is it newer" decision and the installer derivation -- four policies from a
// different concern sitting in the shell. The pure rules stay in update.js
// (version comparison, payload reading, retry/backoff, the install plan); this
// is only their React binding.
//
// The fetch runs THROUGH THE SHELL when there is one. A webview is not allowed
// to read a release asset (no Access-Control-Allow-Origin on
// objects.githubusercontent.com), which is why the banner never appeared in the
// packaged app even though the release published correct metadata; Rust has no
// such limit, so the check works everywhere the app does.
import { useCallback, useEffect, useState } from 'react';
import './update.js';
import './net-policy.js';
import { APP_VERSION } from './version';
import { downloadVerified, hasShell, runInstaller, shellFetch } from './bridge';

const update: typeof import('./update.js') = (globalThis as any).FreeAI4UUpdate;
const netPolicy: typeof import('./net-policy.js') = (globalThis as any).FreeAI4UNetPolicy;

const DISMISSED_KEY = 'freeai4u.updateDismissed';
const POLL_MS = 1000 * 60 * 60;

/** Where an in-app update has got to. */
export type InstallState = 'idle' | 'downloading' | 'installing' | 'error';

export interface DownloadedBuild {
  name: string;
  bytes: number;
  /** False when the release published no digest to check against. */
  verified: boolean;
}

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
  installState: InstallState;
  installError: string;
  /** The bytes that were downloaded, before the installer took over. */
  downloaded: DownloadedBuild | null;
  /** Download, verify and run the installer (or open the release page). */
  install: () => void;
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
  const [installState, setInstallState] = useState<InstallState>('idle');
  const [installError, setInstallError] = useState('');
  const [downloaded, setDownloaded] = useState<DownloadedBuild | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const fetchImpl = hasShell() ? shellFetch : fetch;
      const found = await update.fetchVersion({ fetchImpl });
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

  const install = useCallback(() => {
    const plan = update.installPlan({ installer: update.installerFor(info) });
    if (!plan) return;
    // Without a shell there is nothing to install with; the release page is the
    // honest fallback rather than a button that does nothing.
    if (!hasShell()) {
      window.open(plan.url, '_blank', 'noreferrer');
      return;
    }
    const refusal = netPolicy.refusalReason(plan.url, []);
    if (refusal) {
      setInstallState('error');
      setInstallError(refusal);
      return;
    }
    setInstallState('downloading');
    setInstallError('');
    downloadVerified({ url: plan.url, name: plan.name, sha256: plan.sha256 })
      .then((result) => {
        setDownloaded({ name: result.name, bytes: result.bytes, verified: result.verified });
        setInstallState('installing');
        // The installer takes over and the app exits; nothing after this runs
        // in a real install.
        return runInstaller(result.path);
      })
      .catch((err: unknown) => {
        setInstallState('error');
        setInstallError(err instanceof Error ? err.message : String(err));
      });
  }, [info]);

  return {
    info,
    installer: update.installerFor(info),
    dismiss,
    humanSize: update.humanSize,
    releaseUrl: update.desktopUrl(),
    installState,
    installError,
    downloaded,
    install,
  };
}
