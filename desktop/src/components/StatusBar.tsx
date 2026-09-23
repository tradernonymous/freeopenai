// The status bar: what the app is pointed at, whether it answered, and which
// build this is -- the three questions the window title used to half-answer.
//
// It is deliberately the only place that shows the engine origin, so "which
// server am I talking to?" stops being a trip to Settings.
//
// NEURA-051 adds one more chip, and only when there is something to say: a
// model running on this machine reports what it is doing -- loaded, context,
// slots -- instead of letting "connected" stand in for all of it. The facts
// and the wording are local-status.js; what lives here is the schedule,
// because a timer belongs to the thing that can be unmounted.
//
// NEURA-076 puts the one update control here, beside the version it would
// change: it used to be reachable only from the command palette, so most
// people never found it. The check and the install are the hook's
// (useUpdateCheck) -- the same flow the banner uses -- and this only says
// where it has got to.
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { APP_VERSION } from '../version';
import { hasShell, localModelStatus } from '../bridge';
import type { CheckResult, InstallState } from '../useUpdateCheck';
import '../local-status.js';
import '../saved-models.js';

const localStatus: typeof import('../local-status.js') = (globalThis as any).FreeAI4ULocalStatus;
const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;

/** How long "Up to date" stays before the button offers a check again. */
const UP_TO_DATE_MS = 4000;

export interface StatusBarProps {
  engine: string;
  /** ConnectionOutcome kind, or '' while the first probe is in flight. */
  state: string;
  signedIn: boolean;
  /** The newer version on offer, when a check found one. */
  updateAvailable?: string;
  /** A manual check: ignores a dismissed version, because someone asked. */
  onCheckUpdates: () => Promise<CheckResult>;
  /** Why the last check could not answer. */
  checkError: string;
  /** Download, verify and run the installer (the banner's flow). */
  onInstallUpdate: () => void;
  installState: InstallState;
  installError: string;
  /** A portable copy's result: where the new exe was saved. */
  installNotice: string;
  onOpenPalette: () => void;
}

type CheckPhase = 'idle' | 'checking' | 'current' | 'failed';

interface UpdateButtonProps {
  available?: string;
  onCheckUpdates: () => Promise<CheckResult>;
  checkError: string;
  onInstallUpdate: () => void;
  installState: InstallState;
  installError: string;
  installNotice: string;
}

/**
 * One button whose label is the next useful step: check, wait, update, or say
 * why not. An install in progress outranks everything, then a found update,
 * then the result of the last manual check.
 */
function UpdateButton({ available, onCheckUpdates, checkError, onInstallUpdate, installState, installError, installNotice }: UpdateButtonProps) {
  const [phase, setPhase] = useState<CheckPhase>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const check = () => {
    if (timer.current) clearTimeout(timer.current);
    setPhase('checking');
    onCheckUpdates()
      .then((result) => {
        if (result === 'unknown') {
          setPhase('failed');
          return;
        }
        // An update found is shown by `available` from here on; "Up to date"
        // is the brief answer, then the button offers a check again.
        setPhase(result === 'current' ? 'current' : 'idle');
        if (result === 'current') timer.current = setTimeout(() => setPhase('idle'), UP_TO_DATE_MS);
      })
      .catch(() => setPhase('failed'));
  };

  if (installState === 'downloading' || installState === 'installing') {
    return (
      <span className="status-item status-warn" role="status">
        <Icon name="download" size={13} />
        {installState === 'downloading' ? 'Downloading…' : 'Installing…'}
      </span>
    );
  }
  if (installState === 'saved') {
    return (
      <span className="status-item status-ok" title={installNotice}>
        <Icon name="check" size={13} />
        New version saved
      </span>
    );
  }
  if (available) {
    const failed = installState === 'error';
    return (
      <button className="status-item status-button status-warn" type="button"
        title={failed ? `Update failed: ${installError}` : 'Download, verify and install this version'}
        onClick={() => onInstallUpdate()}>
        <Icon name="download" size={13} />
        {failed ? `Retry update to v${available}` : `Update to v${available}`}
      </button>
    );
  }
  if (phase === 'checking') {
    return (
      <span className="status-item status-muted" role="status">
        <Icon name="download" size={13} />
        Checking…
      </span>
    );
  }
  if (phase === 'current') {
    return (
      <span className="status-item status-ok" role="status">
        <Icon name="check" size={13} />
        Up to date
      </span>
    );
  }
  return (
    <button className={`status-item status-button${phase === 'failed' ? ' status-error' : ''}`} type="button"
      title={phase === 'failed' ? `Couldn't check: ${checkError || 'the release could not be reached'}` : 'Check for a newer build'}
      onClick={check}>
      <Icon name="download" size={13} />
      {phase === 'failed' ? "Couldn't check" : 'Check for updates'}
    </button>
  );
}

function hostOf(url: string): string {
  const match = String(url || '').match(/^[a-z]+:\/\/([^/?#]+)/i);
  return match ? match[1] : (url || 'no engine');
}

const TONE: Record<string, { className: string; label: string }> = {
  ok: { className: 'ok', label: 'connected' },
  'signed-out': { className: 'warn', label: 'sign-in required' },
  unreachable: { className: 'error', label: 'unreachable' },
  refused: { className: 'error', label: 'refused' },
  rejected: { className: 'error', label: 'bad address' },
  'engine-error': { className: 'warn', label: 'engine failing' },
  'no-reply': { className: 'error', label: 'no reply' },
  checking: { className: 'muted', label: 'checking…' },
};

/**
 * The local runtime worth asking about right now, or null.
 *
 * A model this app started wins: it is running because somebody in this window
 * pressed Start. Otherwise the only local runtime the app knows an address for
 * is Ollama, and only when the user actually keeps Ollama models -- a machine
 * with no local runtime gets no chip and does no polling at all.
 */
async function pickTarget(seenOllama: boolean) {
  const shell = await localModelStatus().catch(() => null);
  const started = localStatus.targetFromShell(shell);
  if (started) return started;
  const keepsOllamaModels = savedModels.list().some((entry) => entry.kind === 'ollama');
  if (!keepsOllamaModels) return null;
  // `seenOllama` is the quiet rule: an Ollama that has never answered is
  // somebody who is not running Ollama, not a fault worth a red chip.
  return localStatus.targetForOllama(savedModels.folders().ollama || savedModels.OLLAMA_BASE, seenOllama);
}

function useLocalChip(): import('../local-status.js').LocalChip {
  const [chip, setChip] = useState(() => localStatus.chip(null));
  // Outlives a render, so a runtime that answered once keeps the right to be
  // missed for the rest of the session.
  const seenOllama = useRef(false);

  useEffect(() => {
    // No shell means no local runtime to ask about (a browser preview).
    if (!hasShell()) return undefined;
    let live = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = localStatus.POLL_MS;

    const hidden = () => typeof document !== 'undefined' && document.hidden;

    const schedule = () => {
      if (!live || hidden()) return;
      timer = setTimeout(() => { void run(); }, delay);
    };

    const run = async () => {
      timer = undefined;
      // Hidden is stopped, not slowed: a window in the tray asks nothing.
      if (!live || hidden() || inFlight) return;
      inFlight = true;
      try {
        const target = await pickTarget(seenOllama.current);
        if (!live) return;
        if (!target) {
          setChip(localStatus.chip(null));
          delay = localStatus.POLL_MS;
          return;
        }
        const status = await localStatus.probe(target);
        if (!live) return;
        if (target.kind === 'ollama' && status.reachable) seenOllama.current = true;
        setChip(localStatus.chip(status));
        // Silence backs off instead of retrying at full speed forever.
        delay = localStatus.nextDelay(status, delay);
      } catch {
        // probe() does not throw, but the bridge call above can. Treat it as
        // silence and back off the same way.
        delay = Math.min(localStatus.MAX_POLL_MS, delay * 2);
      } finally {
        inFlight = false;
        schedule();
      }
    };

    const onVisibility = () => {
      if (hidden()) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        return;
      }
      // Back in view: look once straight away, because what is on screen is
      // otherwise as old as the window has been away.
      if (!timer && !inFlight) {
        delay = localStatus.POLL_MS;
        void run();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    void run();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return chip;
}

export default function StatusBar({
  engine, state, signedIn, updateAvailable, onCheckUpdates, checkError, onInstallUpdate,
  installState, installError, installNotice, onOpenPalette,
}: StatusBarProps) {
  const tone = TONE[state] || TONE.checking;
  const local = useLocalChip();
  return (
    <footer className="status-bar">
      <span className={`status-item status-${tone.className}`} title={engine}>
        <span className="status-dot" aria-hidden="true" />
        {tone.label}
      </span>
      <span className="status-item" title={engine}>
        <Icon name="shield" size={13} />
        {hostOf(engine)}
      </span>
      {local.show && (
        <span className={`status-item status-${local.tone}`} title={local.title}>
          <Icon name="activity" size={13} />
          {local.label}
        </span>
      )}
      {signedIn && (
        <span className="status-item">
          <Icon name="check" size={13} />
          signed in
        </span>
      )}
      <span className="status-spacer" />
      <button className="status-item status-button" type="button" onClick={onOpenPalette}>
        <Icon name="search" size={13} />
        Commands
        <span className="palette-keys">Ctrl+K</span>
      </button>
      {/* Always present, whichever installer this copy came from: the hook
          picks the matching artifact (install_kind), the button only asks. */}
      <UpdateButton
        available={updateAvailable}
        onCheckUpdates={onCheckUpdates}
        checkError={checkError}
        onInstallUpdate={onInstallUpdate}
        installState={installState}
        installError={installError}
        installNotice={installNotice}
      />
      <span className="status-item status-muted">v{APP_VERSION}</span>
    </footer>
  );
}
