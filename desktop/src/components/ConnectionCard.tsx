import { useCallback, useEffect, useState } from 'react';
import { api, getServer, setServer, normalizeServer, DEFAULT_SERVER } from '../api';
import '../connection.js';

const connection: typeof import('../connection.js') = (globalThis as any).FreeAI4UConnection;

interface Props {
  /** The engine answered and, if it gates anything, we now hold a session. */
  onConnected?: () => void;
  /** The address was saved: whatever the shell caches about it is stale. */
  onServerChanged?: () => void;
}

// The engine address and the sign-in form, in one place. They were duplicated
// the moment a first-run surface needed them, and this is the only screen that
// can prove an address works: a save is not a connection, so every outcome is
// classified by connection.js and shown as what it actually was (unreachable,
// signed out, refused, not an engine) instead of a generic failure line.
export default function ConnectionCard({ onConnected, onServerChanged }: Props) {
  const [address, setAddress] = useState(getServer());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<any>(null);
  const [session, setSession] = useState<any>(null);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');

  const probe = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
    } catch (err) {
      setHealth(null);
      setMessage(connection.classify({ error: err as any, origin: getServer() }).message);
    }
    try {
      const s = await api.session();
      setSession(s && s.gate ? s : { gate: false });
    } catch {
      setSession(null);
    }
  }, []);

  useEffect(() => { probe(); }, [probe]);

  const testAndSave = async () => {
    const clean = normalizeServer(address);
    if (!clean) {
      setMessage('That address is not usable — use https://… (http://localhost is allowed).');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch(clean + '/api/health');
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setServer(clean);
        setAddress(clean);
        setMessage(`Connected to FreeAI4U ${data.version || ''} @ ${String(data.commit || '').slice(0, 7)}. Saved.`);
        onServerChanged?.();
        await probe();
      } else if (res.ok) {
        setMessage('That server answered, but it is not a FreeAI4U engine.');
      } else {
        setMessage(connection.classify({ status: res.status, origin: clean }).message);
      }
    } catch {
      setMessage(connection.classify({ origin: clean }).message);
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    setMessage('');
    try {
      await api.login(user, pass);
      setPass('');
      setMessage('Signed in.');
      await probe();
      onConnected?.();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  const signOut = async () => {
    try { await api.logout(); } catch { /* signing out twice is fine */ }
    setSession({ gate: false });
    setHealth(null);
    setMessage('Signed out.');
    onServerChanged?.();
    await probe();
  };

  const gate = !!(health && health.loginRequired) && !session?.user;

  return (
    <div className="settings-card connection-card">
      <div className="setting-row">
        <span className="setting-label">Engine</span>
        <span className="setting-value mono">{getServer()}</span>
      </div>
      <div className="setting-row">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={DEFAULT_SERVER}
          style={{ flex: 1 }}
          aria-label="Engine address"
        />
        <button className="primary" onClick={testAndSave} disabled={busy}>
          {busy ? 'Testing…' : 'Test + save'}
        </button>
        {address !== DEFAULT_SERVER && (
          <button onClick={() => setAddress(DEFAULT_SERVER)}>Default</button>
        )}
      </div>
      {health?.ok && (
        <div className="setting-row">
          <span className="setting-label">Status</span>
          <span className="setting-value ok">
            Healthy · v{health.version || '?'} · commit {String(health.commit || '').slice(0, 7)}
            {health.loginRequired ? ' · login required' : ' · open engine'}
          </span>
        </div>
      )}
      {gate && (
        <>
          <div className="setting-row">
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="username"
              style={{ flex: 1 }} aria-label="Username" />
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)}
              placeholder="password" style={{ flex: 1 }} aria-label="Password"
              onKeyDown={(e) => { if (e.key === 'Enter') signIn(); }} />
            <button className="primary" onClick={signIn} disabled={!user || !pass}>Sign in</button>
          </div>
          <p className="settings-hint">
            Only needed when the engine asks for a login (AUTH_USER_1 / AUTH_PASS_1).
            The session is kept in this window's profile.
          </p>
        </>
      )}
      {session?.user && (
        <div className="setting-row">
          <span className="setting-label">Signed in as</span>
          <span className="setting-value ok">{session.user}</span>
          <button onClick={signOut}>Sign out</button>
        </div>
      )}
      {message && <p className="settings-hint connection-message">{message}</p>}
      <p className="settings-hint">
        Chat, builds and images run on the engine. https only, except http://localhost for a
        self-hosted engine.
      </p>
    </div>
  );
}
