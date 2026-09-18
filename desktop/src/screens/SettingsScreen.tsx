import { useState, useEffect } from 'react';
import { api } from '../api';

interface Plugin {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
  author?: string;
}

export default function SettingsScreen() {
  const [providers, setProviders] = useState<Record<string, any>>({});
  const [health, setHealth] = useState<any>(null);
  const [version, setVersion] = useState('2.0.0');
  const [plugins, setPlugins] = useState<Plugin[]>([]);

  useEffect(() => {
    api.health().then(setHealth);
    api.providers().then((p: any) => setProviders(p || {}));
    if ((window as any).__APP_VERSION__) setVersion((window as any).__APP_VERSION__);
    setPlugins([
      { id: 'dsh-better-sidebar', name: 'DSH Better Sidebar', description: 'VSCode-style right sidebar with explorer/editor/terminal/Git/browser.', installed: true, enabled: true, author: 'omdsh-dev' },
      { id: 'dsh-rewind', name: 'DSH Rewind', description: 'In-window conversation rollback without branching; lightweight workspace backup.', installed: true, enabled: true, author: 'SiriLee' },
      { id: 'dsh-market', name: 'DSH Market', description: 'Browse, search, and install community plugins from multiple sources.', installed: true, enabled: false, author: 'jing-hy' },
      { id: 'dsh-pet', name: 'DSH Pet', description: 'Desktop pet with preset animations and Codex resource pack import.', installed: false, enabled: false, author: 'PC2005-cloud' },
      { id: 'dsh-balance', name: 'DSH Balance', description: 'DeepSeek balance, cost estimation, and pricing alerts.', installed: false, enabled: false, author: 'deepseek-ai' },
    ]);
  }, []);

  const providerEntries = Object.entries(providers || {}).filter(([, v]: [string, any]) => !v.disabled);

  const togglePlugin = (id: string) => {
    setPlugins((prev) => prev.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)));
  };

  const installPlugin = (id: string) => {
    setPlugins((prev) => prev.map((p) => (p.id === id ? { ...p, installed: true, enabled: true } : p)));
  };

  return (
    <div className="screen settings">
      <header className="screen-header">
        <h1>Settings</h1>
      </header>
      <div className="settings-layout">
        <aside className="settings-nav">
          <nav>
            {['About', 'Connection', 'Providers', 'Plugins', 'Skills'].map((item) => (
              <button key={item} className="settings-nav-btn">
                {item}
              </button>
            ))}
          </nav>
        </aside>
        <main className="settings-main">
          <section className="settings-section">
            <h2>About</h2>
            <div className="settings-card">
              <div className="setting-row">
                <span className="setting-label">App</span>
                <span className="setting-value">FreeAI4U Desktop</span>
              </div>
              <div className="setting-row">
                <span className="setting-label">Version</span>
                <span className="setting-value">{version}</span>
              </div>
              <div className="setting-row">
                <span className="setting-label">Platform</span>
                <span className="setting-value">{navigator.platform}</span>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>Connection</h2>
            <div className="settings-card">
              <div className="setting-row">
                <span className="setting-label">Server</span>
                <span className="setting-value">Railway (remote)</span>
              </div>
              <div className="setting-row">
                <span className="setting-label">Status</span>
                <span className={`setting-value ${health?.ok ? 'ok' : 'warn'}`}>{health?.ok ? 'Healthy' : 'Unreachable'}</span>
              </div>
              {health?.uptimeSeconds != null && (
                <div className="setting-row">
                  <span className="setting-label">Uptime</span>
                  <span className="setting-value">{Math.floor(health.uptimeSeconds / 60)} min</span>
                </div>
              )}
              {health?.commit && (
                <div className="setting-row">
                  <span className="setting-label">Commit</span>
                  <span className="setting-value mono">{health.commit.slice(0, 8)}</span>
                </div>
              )}
            </div>
          </section>

          <section className="settings-section">
            <h2>Providers</h2>
            <div className="settings-card">
              {providerEntries.length === 0 && <div className="empty">No providers available.</div>}
              {providerEntries.map(([id, p]) => (
                <div key={id} className="setting-row provider-row">
                  <span className="setting-label">{id}</span>
                  <span className="setting-value">{p.models?.length || 0} models</span>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h2>Plugins</h2>
            <div className="plugin-grid">
              {plugins.map((p) => (
                <div key={p.id} className="plugin-card">
                  <div className="plugin-card-header">
                    <div className="plugin-name">{p.name}</div>
                    {p.installed ? (
                      <button onClick={() => togglePlugin(p.id)} disabled={!p.installed}>
                        {p.enabled ? 'Disable' : 'Enable'}
                      </button>
                    ) : (
                      <button onClick={() => installPlugin(p.id)} className="primary">
                        Install
                      </button>
                    )}
                  </div>
                  <div className="plugin-desc">{p.description}</div>
                  <div className="plugin-meta">
                    <span>{p.author}</span>
                    <span>{p.installed ? 'Installed' : 'Available'}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h2>Skills</h2>
            <div className="settings-card">
              <div className="setting-row">
                <span className="setting-label">Loaded</span>
                <span className="setting-value">Server-side</span>
              </div>
              <p className="settings-hint">Skills are loaded from the server. Manage them in the web app.</p>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
