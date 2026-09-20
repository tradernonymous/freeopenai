import ConnectionCard from '../components/ConnectionCard';
import { APP_VERSION } from '../version';
import '../onboarding.js';

const onboarding: typeof import('../onboarding.js') = (globalThis as any).FreeAI4UOnboarding;

interface Props {
  reason: import('../onboarding.js').ShellReason;
  /** Reachable and signed in: the app can let the user in. */
  onConnected: () => void;
  /** Take the address and sign-in form to the full Settings screen. */
  onOpenSettings: () => void;
}

// The way in.
//
// This replaces the lock that used to cover every screen when the engine asked
// for a login -- a lock over the one screen that could sign you in, which made
// a fresh install a dead end. It is not a modal or a wizard: it is the engine
// card, the cause in one sentence, and a way past it.
//
// The card owns every outcome's wording (connection.js), so this screen says
// what is being asked and nothing twice.
export default function ConnectScreen({ reason, onConnected, onOpenSettings }: Props) {
  return (
    <div className="connect-screen">
      <div className="connect-panel">
        <div className="connect-mark">◆</div>
        <h2>{onboarding.connectTitle(reason)}</h2>
        <p className="connect-advice">{onboarding.connectAdvice(reason)}</p>
        <ConnectionCard onConnected={onConnected} onServerChanged={onConnected} />
        <div className="connect-foot">
          <button className="link-btn" onClick={onOpenSettings} type="button">
            All settings
          </button>
          <span className="limit-badge">v{APP_VERSION}</span>
        </div>
      </div>
    </div>
  );
}
