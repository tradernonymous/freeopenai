import { useEffect, useRef, useState } from 'react';
import {
  hasShell,
  hfOAuthCancel,
  hfOAuthConfig,
  hfOAuthExchange,
  hfOAuthListen,
  hfOAuthRefresh,
  openUrl,
  type HfOAuthConfig,
} from '../bridge';
import { pushToast } from './Toasts';
import '../hf-auth.js';

const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;

// Hugging Face sign-in, one component wherever it is offered (Chat, Library,
// Settings -> Connectors).
//
// With an OAuth client id (compiled in from NEURAOS_HF_CLIENT_ID, or set in
// Settings -> Connectors) the primary button is one click: the shell listens
// on the registered loopback address, HF's authorize page opens in the
// browser, and the token comes back on its own (hf-auth.js beginOAuth,
// hf_oauth.rs). Without one -- or in a plain browser -- it is the access
// token flow: HF's token page opens with the Inference Providers permission
// ticked, you paste the token back, and it is checked against whoami before
// it is kept. Either way the token lives in Windows Credential Manager, never
// on the engine.

// An OAuth token runs out; the shell renews it. Set once, on first import.
if (hasShell()) hfAuth.configureRefresh(hfOAuthRefresh);

let buildConfig: Promise<HfOAuthConfig | null> | null = null;
function loadBuildConfig(): Promise<HfOAuthConfig | null> {
  if (!buildConfig) buildConfig = hfOAuthConfig();
  return buildConfig;
}

function openPage(url: string, onFail: () => void) {
  if (hasShell()) openUrl(url).catch(onFail);
  else window.open(url, '_blank', 'noopener');
}

interface Props {
  /** One line, for a banner. */
  compact?: boolean;
  /** Settings -> Connectors: also show the OAuth client ID field. */
  showClientId?: boolean;
  onSignedIn?: (user: any) => void;
}

export default function HfSignIn({ compact, showClientId, onSignedIn }: Props) {
  const [signedIn, setSignedIn] = useState(() => hfAuth.signedIn());
  const [user, setUser] = useState<any>(() => hfAuth.cachedUser());
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [buildId, setBuildId] = useState<string | null>(null);
  // Bumped when the Settings override changes (it announces like a sign-in).
  const [, setRevision] = useState(0);
  const cancelled = useRef(false);

  useEffect(() => {
    let live = true;
    const onAuth = () => { setSignedIn(hfAuth.signedIn()); setUser(hfAuth.cachedUser()); setRevision((n) => n + 1); };
    window.addEventListener(hfAuth.AUTH_CHANGED_EVENT, onAuth);
    loadBuildConfig().then((config) => { if (live) setBuildId(config?.client_id ?? null); });
    return () => { live = false; window.removeEventListener(hfAuth.AUTH_CHANGED_EVENT, onAuth); };
  }, []);

  // One click needs the shell (the loopback listener) and a client id.
  const clientId = hasShell() ? hfAuth.resolveClientId(buildId) : null;

  const openTokenPage = () => {
    setOpen(true);
    setError('');
    if (hasShell()) openUrl(hfAuth.TOKEN_PAGE).catch(() => setError('Could not open the browser; the address is below.'));
    else window.open(hfAuth.TOKEN_PAGE, '_blank', 'noopener');
  };

  const openDocs = () => openPage(hfAuth.DOCS_URL, () => setError(`Could not open the browser. The steps are in docs/desktop.md: ${hfAuth.DOCS_URL}`));

  const signedInAs = (who: any) => {
    setUser(who);
    setSignedIn(true);
    pushToast('ok', `Signed in to Hugging Face as ${who?.name || 'you'}.`);
    onSignedIn?.(who);
  };

  const oneClick = async () => {
    if (!clientId || waiting) return;
    cancelled.current = false;
    setWaiting(true);
    setError('');
    try {
      const who = await hfAuth.beginOAuth({
        clientId,
        redirectUri: hfAuth.REDIRECT_URI,
        openUrl,
        listen: hfOAuthListen,
        exchange: hfOAuthExchange,
        cancel: hfOAuthCancel,
        timeoutSecs: hfAuth.DEFAULT_TIMEOUT_SECS,
      });
      signedInAs(who);
    } catch (e) {
      if (!cancelled.current) setError(((e as Error).message || String(e)).split('\n')[0]);
    } finally {
      setWaiting(false);
    }
  };

  const cancelOneClick = () => {
    cancelled.current = true;
    hfOAuthCancel().catch(() => {});
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const who = await hfAuth.useToken(token);
      setToken('');
      setOpen(false);
      signedInAs(who);
    } catch (e) {
      setError(((e as Error).message || String(e)).split('\n')[0]);
    } finally {
      setBusy(false);
    }
  };

  const field = showClientId && hasShell() ? <ClientIdField buildId={buildId} onDocs={openDocs} /> : null;

  if (signedIn) {
    return (
      <>
        <div className={`hf-signin is-in${compact ? ' compact' : ''}`}>
          <span>Hugging Face: <strong className="mono">{user?.name || 'signed in'}</strong></span>
          <button className="linkish" onClick={() => { hfAuth.signOut(); pushToast('info', 'Signed out of Hugging Face.'); }}>Sign out</button>
        </div>
        {field}
      </>
    );
  }

  let body;
  if (waiting) {
    body = (
      <>
        <span role="status"><span className="thread-spinner" aria-hidden="true" />Waiting for the browser… approve NeuraOS on Hugging Face, then come back here.</span>
        <button onClick={cancelOneClick}>Cancel</button>
      </>
    );
  } else if (!open) {
    body = clientId ? (
      <>
        {!compact && <span>Sign in once in your browser. The token stays on this PC, in Windows Credential Manager.</span>}
        <button className="primary" onClick={oneClick}>Sign in with Hugging Face</button>
        <button className="linkish" onClick={openTokenPage}>Use an access token instead</button>
      </>
    ) : (
      <>
        {!compact && <span>Hugging Face needs a token. It stays on this PC, in Windows Credential Manager.</span>}
        <button className="primary" onClick={openTokenPage}>Sign in to Hugging Face</button>
        {!compact && hasShell() && <button className="linkish" onClick={openDocs}>Set up one-click sign-in</button>}
      </>
    );
  } else {
    body = (
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
    );
  }

  return (
    <>
      <div className={`hf-signin${compact ? ' compact' : ''}`}>
        {body}
        {error && <div className="chip-note" role="alert">{error}</div>}
      </div>
      {field}
    </>
  );
}

// Settings -> Connectors: the OAuth client id, overriding the one compiled in.
function ClientIdField({ buildId, onDocs }: { buildId: string | null; onDocs: () => void }) {
  const [value, setValue] = useState(() => hfAuth.clientIdOverride() || '');
  const [note, setNote] = useState('');

  const save = () => {
    try {
      hfAuth.setClientIdOverride(value);
      const kept = value.trim();
      setNote(kept ? 'Saved. One-click sign-in uses this client ID.' : buildId ? 'Cleared: using the client ID this build came with.' : 'Cleared.');
    } catch (e) {
      setNote(((e as Error).message || String(e)).split('\n')[0]);
    }
  };

  return (
    <form className="hf-token-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <span className="hf-steps">
        OAuth client ID, for one-click sign-in. Register an app on Hugging Face with the redirect URI{' '}
        <span className="mono">{hfAuth.REDIRECT_URI}</span>.{buildId ? ' Leave empty to use the one built in.' : ''}{' '}
        <button type="button" className="linkish" onClick={onDocs}>How</button>
      </span>
      <input
        value={value}
        onChange={(e) => { setValue(e.target.value); setNote(''); }}
        placeholder={buildId || 'client ID from huggingface.co/settings/applications'}
        aria-label="Hugging Face OAuth client ID"
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit">Save</button>
      {note && <span className="settings-hint">{note}</span>}
    </form>
  );
}
