// The status bar: what the app is pointed at, whether it answered, and which
// build this is -- the three questions the window title used to half-answer.
//
// It is deliberately the only place that shows the engine origin, so "which
// server am I talking to?" stops being a trip to Settings.
import Icon from './Icon';
import { APP_VERSION } from '../version';

export interface StatusBarProps {
  engine: string;
  /** ConnectionOutcome kind, or '' while the first probe is in flight. */
  state: string;
  signedIn: boolean;
  updateAvailable?: string;
  onOpenPalette: () => void;
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

export default function StatusBar({ engine, state, signedIn, updateAvailable, onOpenPalette }: StatusBarProps) {
  const tone = TONE[state] || TONE.checking;
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
      {signedIn && (
        <span className="status-item">
          <Icon name="check" size={13} />
          signed in
        </span>
      )}
      {updateAvailable && (
        <span className="status-item status-warn">
          <Icon name="download" size={13} />
          v{updateAvailable} available
        </span>
      )}
      <span className="status-spacer" />
      <button className="status-item status-button" type="button" onClick={onOpenPalette}>
        <Icon name="search" size={13} />
        Commands
        <span className="palette-keys">Ctrl+K</span>
      </button>
      <span className="status-item status-muted">v{APP_VERSION}</span>
    </footer>
  );
}
