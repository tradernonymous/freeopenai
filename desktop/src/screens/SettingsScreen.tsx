import { useState, useEffect } from 'react';
import { api } from '../api';
import { APP_VERSION } from '../version';
import ConnectionCard from '../components/ConnectionCard';
import DiagnosticsCard from '../components/DiagnosticsCard';
import FileTree from '../components/FileTree';
import Terminal from '../components/Terminal';

// Settings: everything the engine can tell us about itself.
//
// The engine address and the sign-in form live in ConnectionCard, because the
// first-run connect screen needs exactly the same two things -- one owner, one
// set of outcomes, instead of a copy per screen.
interface Props {
  /** The address or the session changed: the shell has to re-probe. */
  onConnectionChanged?: () => void;
  /** What the shell last concluded about the engine, in the diagnostics report. */
  diagnosticsState?: string;
}

export default function SettingsScreen({ onConnectionChanged, diagnosticsState }: Props) {
  const [providers, setProviders] = useState<any[]>([]);
  const [limits, setLimits] = useState<any>(null);
  const [memory, setMemory] = useState<Array<any>>([]);
  const version = APP_VERSION;

  const load = () => {
    api.providers().then((rows: any) => setProviders(Array.isArray(rows) ? rows : [])).catch(() => setProviders([]));
    api.limits().then(setLimits).catch(() => setLimits(null));
    api.memory().then((m: any) => setMemory(Array.isArray(m) ? m : Array.isArray(m?.facts) ? m.facts : [])).catch(() => setMemory([]));
  };

  useEffect(() => { load(); }, []);

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
            <h2>Engine</h2>
            {/* A saved address is a setting; whether it answers is the card's
                business, and it says which of the two happened. The shell is
                told either way, so fixing a wrong address here moves the app
                off the connect surface instead of waiting for a restart. */}
            <ConnectionCard
              onServerChanged={() => { load(); onConnectionChanged?.(); }}
              onConnected={() => { load(); onConnectionChanged?.(); }}
            />
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

          {/* The engine's own shell, kept but demoted. It only works when the
              server sets WORKSPACE_RUN=1 and the account is signed in, which is
              why it is not a sidebar row any more: the local folder and the
              local terminal answer for the app's own machine. */}
          <section className="settings-section">
            <h2>Advanced</h2>
            <div className="settings-card">
              <details className="engine-shell">
                <summary>Engine shell (needs WORKSPACE_RUN=1 on the server)</summary>
                <p className="settings-hint">
                  Commands and files on the FreeAI4U server, in the engine's own workspace — not on
                  this machine. The <strong>Folder</strong> and <strong>Terminal</strong> panels in
                  the sidebar are the local ones.
                </p>
                <div className="engine-shell-body">
                  <FileTree />
                  <Terminal />
                </div>
              </details>
            </div>
          </section>

          <DiagnosticsCard state={diagnosticsState} />
        </main>
      </div>
    </div>
  );
}
