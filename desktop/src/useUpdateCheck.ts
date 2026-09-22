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
import { downloadVerified, hasShell, runInstaller, updateManifest } from './bridge';

const update: typeof import('./update.js') = (globalThis as any).FreeAI4UUpdate;
const netPolicy: typeof import('./net-policy.js') = (globalThis as any).FreeAI4UNetPolicy;

/**
 * fetch() for the manifest, answered by the shell's signature-checked read.
 * A refused signature is logged and reads as "no answer": update.js then
 * reports 'unknown', and nothing unverified is ever offered for install.
 */
async function signedFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const { body } = await updateManifest(url);
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.warn('update manifest refused:', (e as Error).message || e);
    return new Response('', { status: 502 });
  }
}

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
  /** Check on demand; the palette reports the answer instead of a silent poll. */
  checkNow: () => Promise<'update' | 'current' | 'unknown'>;
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

  // The manual check is the same code path as the polled one, so "check for
  // updates" in the command palette cannot behave differently from what runs on
  // its own -- including the retry/backoff and the dismissed-version rule.
  const checkNow = useCallback(async (): Promise<'update' | 'current' | 'unknown'> => {
    // In the app the manifest comes through the shell, which checks its
    // signature before anything here trusts the sha256 values inside it.
    const fetchImpl = hasShell() ? signedFetch : fetch;
    const found = await update.fetchVersion({ fetchImpl });
    if (!found) return 'unknown';
    if (!update.isNewer(found.version, APP_VERSION)) return 'current';
    if (dismissedVersion() === found.version) return 'current';
    setInfo(found);
    return 'update';
  }, []);

  useEffect(() => {
    checkNow();
    const interval = setInterval(() => { void checkNow(); }, POLL_MS);
    return () => clearInterval(interval);
  }, [checkNow]);

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
    checkNow,
    installState,
    installError,
    downloaded,
    install,
  };
}
