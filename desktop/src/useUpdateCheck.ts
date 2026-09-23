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
//
// NEURA-076: the artifact is chosen by how this copy was installed (the shell's
// install_kind), so an MSI install is upgraded by the .msi, an NSIS install by
// the setup exe, and a portable copy is never handed an installer to run.
import { useCallback, useEffect, useState } from 'react';
import './update.js';
import './net-policy.js';
import { APP_VERSION } from './version';
import { downloadVerified, hasShell, installKind, runInstaller, updateManifest } from './bridge';

const update: typeof import('./update.js') = (globalThis as any).FreeAI4UUpdate;
const netPolicy: typeof import('./net-policy.js') = (globalThis as any).FreeAI4UNetPolicy;

// Why the last check came back empty, for the status bar's "Couldn't check"
// tooltip. update.js resolves a failure to null on purpose (a missing banner is
// not an error), so the reason is recorded on the way through instead.
let lastCheckFailure = '';

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
    const reason = (e as Error).message || String(e);
    console.warn('update manifest refused:', reason);
    lastCheckFailure = reason;
    return new Response('', { status: 502 });
  }
}

/** Wrap a fetch so a failed answer leaves its reason in lastCheckFailure. */
function recording(base: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const res = await base(input, init);
      if (res.status === 404 || res.status === 403) {
        lastCheckFailure = `no release is published yet (HTTP ${res.status})`;
      } else if (!res.ok && !lastCheckFailure) {
        lastCheckFailure = `the release answered HTTP ${res.status}`;
      }
      return res;
    } catch (e) {
      lastCheckFailure = (e as Error).message || String(e);
      throw e;
    }
  }) as typeof fetch;
}

const DISMISSED_KEY = 'freeai4u.updateDismissed';
const POLL_MS = 1000 * 60 * 60;

/** Where an in-app update has got to. 'saved' is a portable copy's finish line. */
export type InstallState = 'idle' | 'downloading' | 'installing' | 'saved' | 'error';

export type CheckResult = 'update' | 'current' | 'unknown';

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
  /**
   * Check on demand. `manual` is a person asking (the status bar button, the
   * palette): the answer is shown even for a version they dismissed earlier.
   */
  checkNow: (manual?: boolean) => Promise<CheckResult>;
  /** Why the last check could not answer; empty after one that did. */
  checkError: string;
  installState: InstallState;
  installError: string;
  /** A portable copy's result: where the new exe was saved. */
  installNotice: string;
  /** The bytes that were downloaded, before the installer took over. */
  downloaded: DownloadedBuild | null;
  /** Download, verify and run the installer (or save the portable exe, or open the release page). */
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
  const [installNotice, setInstallNotice] = useState('');
  const [checkError, setCheckError] = useState('');
  const [downloaded, setDownloaded] = useState<DownloadedBuild | null>(null);
  // How this copy was installed, so the banner names the artifact that will
  // actually be used. Undefined until the shell answers.
  const [kind, setKind] = useState<import('./update.js').InstallKind | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void installKind().then((answer) => { if (live) setKind(answer); });
    return () => { live = false; };
  }, []);

  // The manual check is the same code path as the polled one, so the button
  // cannot behave differently from what runs on its own -- including the
  // retry/backoff. The one difference is the dismissed-version rule: the hourly
  // poll respects it, but a person who clicks "Check for updates" asked, and is
  // told.
  const checkNow = useCallback(async (manual = false): Promise<CheckResult> => {
    // In the app the manifest comes through the shell, which checks its
    // signature before anything here trusts the sha256 values inside it.
    const fetchImpl = hasShell() ? signedFetch : fetch;
    lastCheckFailure = '';
    const found = await update.fetchVersion({ fetchImpl: recording(fetchImpl) });
    if (!found) {
      setCheckError(lastCheckFailure || 'the release could not be reached');
      return 'unknown';
    }
    setCheckError('');
    if (!update.isNewer(found.version, APP_VERSION)) return 'current';
    if (!manual && dismissedVersion() === found.version) return 'current';
    setInfo(found);
    return 'update';
  }, []);

  useEffect(() => {
    void checkNow();
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
    void (async () => {
      // Asked again rather than read from state: the answer decides which
      // installer runs, and a click before the first answer must not guess.
      const kind = await installKind();
      const plan = update.installPlan({ installer: update.installerFor(info, kind) });
      if (!plan) {
        // A portable copy and a release with no portable build: the release
        // page is where the user picks a file, rather than an installer run here.
        if (info) window.open(update.desktopUrl(), '_blank', 'noreferrer');
        return;
      }
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
      setInstallNotice('');
      try {
        const result = await downloadVerified({ url: plan.url, name: plan.name, sha256: plan.sha256 });
        setDownloaded({ name: result.name, bytes: result.bytes, verified: result.verified });
        if (kind === 'portable') {
          // A portable exe is not an installer, and a running copy cannot
          // replace itself -- so the checked file is kept and the user is told
          // where it is, to swap in when they choose.
          setInstallState('saved');
          setInstallNotice(`This copy is portable: the new version was saved to ${result.path}`);
          return;
        }
        setInstallState('installing');
        // The installer takes over and the app exits; nothing after this runs
        // in a real install.
        await runInstaller(result.path);
      } catch (err: unknown) {
        setInstallState('error');
        setInstallError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [info]);

  return {
    info,
    installer: update.installerFor(info, kind),
    dismiss,
    humanSize: update.humanSize,
    releaseUrl: update.desktopUrl(),
    checkNow,
    checkError,
    installState,
    installError,
    installNotice,
    downloaded,
    install,
  };
}
