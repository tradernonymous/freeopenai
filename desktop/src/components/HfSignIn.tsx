import { useEffect, useState } from 'react';
import { hasShell, openUrl } from '../bridge';
import { pushToast } from './Toasts';
import '../hf-auth.js';

const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;

// Hugging Face sign-in, one component wherever it is offered (Chat, Library,
// Settings -> Connectors).
//
// It used to start an OAuth device-code flow against an OAuth app HF no
// longer knows (`invalid_client`), and the failure died in a CORS error, so
// the button looked like it did nothing. Now: the button opens HF's token page
// with the Inference Providers permission already ticked, you paste the token
// back, and it is checked against whoami before it is kept -- in Windows
// Credential Manager, never on the engine.

interface Props {
  /** One line, for a banner. */
  compact?: boolean;
  onSignedIn?: (user: any) => void;
}

export default function HfSignIn({ compact, onSignedIn }: Props) {
  const [signedIn, setSignedIn] = useState(() => hfAuth.signedIn());
  const [user, setUser] = useState<any>(() => hfAuth.cachedUser());
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onAuth = () => { setSignedIn(hfAuth.signedIn()); setUser(hfAuth.cachedUser()); };
    window.addEventListener(hfAuth.AUTH_CHANGED_EVENT, onAuth);
    return () => window.removeEventListener(hfAuth.AUTH_CHANGED_EVENT, onAuth);
  }, []);

  const openTokenPage = () => {
    setOpen(true);
    setError('');
    if (hasShell()) openUrl(hfAuth.TOKEN_PAGE).catch(() => setError('Could not open the browser; the address is below.'));
    else window.open(hfAuth.TOKEN_PAGE, '_blank', 'noopener');
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const who = await hfAuth.useToken(token);
      setToken('');
      setOpen(false);
      setUser(who);
      setSignedIn(true);
      pushToast('ok', `Signed in to Hugging Face as ${who?.name || 'you'}.`);
      onSignedIn?.(who);
    } catch (e) {
      setError(((e as Error).message || String(e)).split('\n')[0]);
    } finally {
      setBusy(false);
    }
  };

  if (signedIn) {
    return (
      <div className={`hf-signin is-in${compact ? ' compact' : ''}`}>
        <span>Hugging Face: <strong className="mono">{user?.name || 'signed in'}</strong></span>
        <button className="linkish" onClick={() => { hfAuth.signOut(); pushToast('info', 'Signed out of Hugging Face.'); }}>Sign out</button>
      </div>
    );
  }

  return (
    <div className={`hf-signin${compact ? ' compact' : ''}`}>
      {!open ? (
        <>
          {!compact && <span>Hugging Face needs a token. It stays on this PC, in Windows Credential Manager.</span>}
          <button className="primary" onClick={openTokenPage}>Sign in to Hugging Face</button>
        </>
      ) : (
        <form className="hf-token-form" onSubmit={(e) => { e.preventDefault(); if (token.trim() && !busy) submit(); }}>
          <span className="hf-steps">
            Hugging Face opened in your browser. Create the token (the permission <em>Make calls to Inference Providers</em> is
            already ticked), copy it, and paste it here.
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="hf_…"
            aria-label="Hugging Face access token"
            autoFocus
            spellCheck={false}
          />
          <button type="submit" className="primary" disabled={!token.trim() || busy}>{busy ? 'Checking…' : 'Use token'}</button>
          <button type="button" onClick={() => setOpen(false)}>Cancel</button>
          <span className="settings-hint mono hf-page">{hfAuth.TOKEN_PAGE.split('?')[0]}</span>
        </form>
      )}
      {error && <div className="chip-note" role="alert">{error}</div>}
    </div>
  );
}
