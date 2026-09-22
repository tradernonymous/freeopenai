import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { APP_VERSION } from '../version';
import ConnectionCard from '../components/ConnectionCard';
import DiagnosticsCard from '../components/DiagnosticsCard';
import LocalModelsCard from '../components/LocalModelsCard';
import DictationCard from '../components/DictationCard';
import ConnectorsCard from '../components/ConnectorsCard';
import ShortcutsCard from '../components/ShortcutsCard';
import AppearanceCard from '../components/AppearanceCard';
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

  // One searchable surface: the query hides every section that does not
  // mention it, and the rail lists what is left to jump to. It reads the
  // rendered text, so a card added later is searchable without registering.
  const [query, setQuery] = useState('');
  const [titles, setTitles] = useState<string[]>([]);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = mainRef.current;
    if (!root) return;
    const q = query.trim().toLowerCase();
    const found: string[] = [];
    root.querySelectorAll<HTMLElement>(':scope > .settings-section').forEach((section) => {
      const hit = !q || (section.textContent || '').toLowerCase().includes(q);
      section.hidden = !hit;
      const title = section.querySelector('h2')?.textContent || '';
      if (hit && title) found.push(title);
    });
    setTitles((prev) => (prev.join('|') === found.join('|') ? prev : found));
  }, [query, providers.length, memory.length]);
  const jump = (title: string) => {
    const heading = Array.from(mainRef.current?.querySelectorAll('h2') || []).find((h) => h.textContent === title);
    heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
          <input
            type="search"
            className="settings-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            autoFocus
          />
          {titles.map((title) => (
            <button key={title} className="settings-nav-btn" type="button" onClick={() => jump(title)}>{title}</button>
          ))}
          {!titles.length && <div className="settings-hint">Nothing matches “{query}”.</div>}
        </aside>
        <main className="settings-main" ref={mainRef}>
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
                      ? ((p.freeTier && (p.freeTier.text || p.freeTier.limitText)) || 'ready')
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
                  <span className="setting-label">How long a rate-limited model is retried</span>
                  <span className="setting-value">
                    {Math.round(limits.retries.budgetMs / 1000)}s in total, {limits.retries.maxAttempts} attempt
                    {limits.retries.maxAttempts === 1 ? '' : 's'}, {Math.round((limits.retries.baseDelayMs || 0) / 1000 * 10) / 10}s apart
                  </span>
                </div>
              )}
              {limits?.timeouts && (
                <div className="setting-row">
                  <span className="setting-label">Chat timeout</span>
                  <span className="setting-value">{Math.round(limits.timeouts.chat / 1000)}s</span>
                </div>
              )}
              <p className="settings-hint">
                A rate-limited service is retried only as long as the turn is worth waiting for; after that the engine hands
                the same question to the next model instead of leaving you with nothing. This is why a rate limit never ends a
                turn here, and it is a setting rather than a warning: nothing is wrong with your chat.
              </p>
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

          <ConnectorsCard />

          <section className="settings-section">
            <h2>Appearance</h2>
            <AppearanceCard />
          </section>

          <section className="settings-section">
            <h2>Shortcuts</h2>
            <ShortcutsCard />
          </section>

          <LocalModelsCard />

          <DictationCard />

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
