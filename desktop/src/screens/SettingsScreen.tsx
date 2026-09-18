import { useState, useEffect } from 'react';
import { api, getServer, setServer, normalizeServer, DEFAULT_SERVER } from '../api';

export default function SettingsScreen() {
  const [health, setHealth] = useState<any>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [limits, setLimits] = useState<any>(null);
  const [serverInput, setServerInput] = useState(getServer());
  const [test, setTest] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginMsg, setLoginMsg] = useState('');
  const [session, setSession] = useState<any>(null);
  const [memory, setMemory] = useState<Array<any>>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [version, setVersion] = useState('2.1.0');

  const load = () => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api.providers().then((rows: any) => setProviders(Array.isArray(rows) ? rows : [])).catch(() => setProviders([]));
    api.limits().then(setLimits).catch(() => setLimits(null));
    api.session().then((s: any) => setSession(s && s.gate ? s : { gate: false })).catch(() => setSession(null));
    api.memory().then((m: any) => setMemory(Array.isArray(m) ? m : Array.isArray(m?.facts) ? m.facts : [])).catch(() => setMemory([]));
  };

  useEffect(() => { load(); }, []);

  const testConnection = async () => {
    const ok = normalizeServer(serverInput);
    if (!ok) {
      setTest('That address is not usable — use https://… (http://localhost is allowed).');
      return;
    }
    setTesting(true);
    setTest('');
    try {
      const res = await fetch(ok + '/api/health');
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setServer(ok);
        setTest(`Connected: FreeAI4U ${data.version || ''} @ ${(data.commit || '').slice(0, 7)}. Saved.`);
        load();
      } else {
        setTest('That server answered but is not a FreeAI4U engine.');
      }
    } catch {
      setTest(`Could not reach ${ok}.`);
    } finally {
      setTesting(false);
    }
  };

  const doLogin = async () => {
    setLoginMsg('');
    try {
      await api.login(loginUser, loginPass);
      setLoginMsg('Signed in.');
      setLoginPass('');
      load();
    } catch (err) {
      setLoginMsg((err as Error).message);
    }
  };

  const doLogout = async () => {
    try { await api.logout(); } catch { /* signing out twice is fine */ }
    setSession({ gate: false });
    load();
  };

  const forget = async (id: string) => {
    try {
      await api.memoryForget(id);
      setMemory((prev) => prev.filter((f: any) => f.id !== id));
    } catch { /* the list refreshes on the next load */ }
  };

  return (
    <div className="screen settings">
      <header className="screen-header">
        <h1>Settings</h1>
        <div className="header-actions">
          <span className="limit-badge">v{version}</span>
        </div>
      </header>
      <div className="settings-layout">
        <aside className="settings-nav">
          <button className="settings-nav-btn active" type="button">Engine</button>
        </aside>
        <main className="settings-main">
          <section className="settings-section">
            <h2>Engine server</h2>
            <div className="settings-card">
              <div className="setting-row">
                <span className="setting-label">Server</span>
                <span className="setting-value mono">{getServer()}</span>
              </div>
              <div className="setting-row">
                <input value={serverInput} onChange={(e) => setServerInput(e.target.value)}
                  placeholder={DEFAULT_SERVER} style={{ flex: 1 }} />
                <button onClick={testConnection} disabled={testing}>
                  {testing ? 'Testing…' : 'Test + save'}
                </button>
                {serverInput !== DEFAULT_SERVER && (
                  <button onClick={() => { setServerInput(DEFAULT_SERVER); }}>Default</button>
                )}
              </div>
              {test && <p className="settings-hint">{test}</p>}
              {health?.ok && (
                <div className="setting-row">
                  <span className="setting-label">Status</span>
                  <span className="setting-value ok">
                    Healthy · v{health.version || '?'} · commit {String(health.commit || '').slice(0, 7)}
                  </span>
                </div>
              )}
              {health?.loginRequired != null && (
                <div className="setting-row">
                  <span className="setting-label">Login</span>
                  <span className="setting-value">{health.loginRequired ? 'required by this server' : 'open server'}</span>
                </div>
              )}
              <p className="settings-hint">
                The desktop is a front end: chat, builds and images run on the engine.
                https only, except http://localhost for a self-hosted engine.
              </p>
            </div>
          </section>

          <section className="settings-section">
            <h2>Sign-in</h2>
            <div className="settings-card">
              {session && session.gate ? (
                <>
                  <div className="setting-row">
                    <span className="setting-label">Signed in as</span>
                    <span className="setting-value">{session.user}</span>
                  </div>
                  <button onClick={doLogout}>Sign out</button>
                </>
              ) : (
                <>
                  <div className="setting-row">
                    <input value={loginUser} onChange={(e) => setLoginUser(e.target.value)} placeholder="username" style={{ flex: 1 }} />
                    <input type="password" value={loginPass} onChange={(e) => setLoginPass(e.target.value)}
                      placeholder="password" style={{ flex: 1 }} />
                    <button className="primary" onClick={doLogin} disabled={!loginUser || !loginPass}>Sign in</button>
                  </div>
                  {loginMsg && <p className="settings-hint">{loginMsg}</p>}
                  <p className="settings-hint">Only needed when the engine asks for a login (AUTH_USER_1 / AUTH_PASS_1).</p>
                </>
              )}
            </div>
          </section>

          <section className="settings-section">
            <h2>Providers</h2>
            <div className="settings-card">
              {providers.length === 0 && <div className="empty">No providers reported by the engine.</div>}
              {providers.map((p: any) => (
                <div key={p.id} className="provider-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span className="setting-label">
                    {p.configured ? '' : '○ '}{p.label || p.id}
                    {p.kind && p.kind !== 'chat' ? ` (${p.kind})` : ''}
                  </span>
                  <span className={`setting-value ${p.configured ? 'ok' : 'warn'}`}>
                    {p.configured
                      ? (p.freeTier && p.freeTier.limitText ? p.freeTier.limitText : 'ready')
                      : (p.note || 'no key set')}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h2>Limits the engine enforces</h2>
            <div className="settings-card">
              {limits?.retries && (
                <div className="setting-row">
                  <span className="setting-label">Rate-limit retry budget</span>
                  <span className="setting-value">{Math.round(limits.retries.budgetMs / 1000)}s across {limits.retries.maxAttempts} attempt(s)</span>
                </div>
              )}
              {limits?.timeouts && (
                <div className="setting-row">
                  <span className="setting-label">Chat timeout</span>
                  <span className="setting-value">{Math.round(limits.timeouts.chat / 1000)}s</span>
                </div>
              )}
              <p className="settings-hint">A rate-limited provider is waited on only as long as the turn is worth; then another provider takes it.</p>
            </div>
          </section>

          <section className="settings-section">
            <h2>Memory the model saved</h2>
            <div className="settings-card">
              {memory.length === 0 && <div className="empty">Nothing saved yet.</div>}
              {memory.map((f: any) => (
                <div key={f.id} className="provider-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span className="setting-label">{f.text || f.fact || f.name || f.id}</span>
                  <button onClick={() => forget(f.id)}>Forget</button>
                </div>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
