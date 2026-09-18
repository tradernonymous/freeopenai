import { useState, useEffect } from 'react';
import { api } from '../api';

interface BuildSession {
  id: string;
  status: string;
  steps: Array<{ status: string; title: string; detail?: string }>;
  createdAt: number;
}

export default function BuildScreen() {
  const [sessions, setSessions] = useState<BuildSession[]>([]);
  const [active, setActive] = useState<BuildSession | null>(null);
  const [prompt, setPrompt] = useState('');
  const [repo, setRepo] = useState('');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api.buildSessions().then((s: any) => setSessions(Array.isArray(s) ? s : []));
  }, []);

  const runBuild = async () => {
    if (!prompt.trim()) return;
    setRunning(true);
    try {
      const session = await api.buildRun({ prompt: prompt.trim(), repo: repo.trim() || undefined, mode: 'build' });
      setSessions((prev) => [session as BuildSession, ...prev]);
      setActive(session as BuildSession);
      setPrompt('');
    } catch (e) {
      console.error(e);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="screen build">
      <header className="screen-header">
        <h1>Build</h1>
      </header>
      <div className="build-layout">
        <aside className="build-sidebar">
          <div className="panel">
            <h3>New build</h3>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo (optional)" />
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what to build or change…" rows={4} />
            <button onClick={runBuild} disabled={running || !prompt.trim()} className="primary">
              {running ? 'Running…' : 'Start build'}
            </button>
          </div>
          <div className="panel">
            <h3>Sessions</h3>
            <div className="session-list">
              {sessions.map((s) => (
                <button key={s.id} className={`session-item ${active?.id === s.id ? 'active' : ''}`} onClick={() => setActive(s)}>
                  <div className="session-title">{s.id}</div>
                  <div className="session-status">{s.status}</div>
                  <div className="session-date">{new Date(s.createdAt).toLocaleString()}</div>
                </button>
              ))}
              {sessions.length === 0 && <div className="empty">No builds yet</div>}
            </div>
          </div>
        </aside>

        <main className="build-main">
          {active ? (
            <div className="build-detail">
              <div className="build-header">
                <div>
                  <div className="build-id">Session {active.id}</div>
                  <div className="build-status">{active.status}</div>
                </div>
              </div>
              <div className="build-steps">
                {active.steps?.map((step, i) => (
                  <div key={i} className={`step ${step.status}`}>
                    <div className="step-indicator" />
                    <div className="step-body">
                      <div className="step-title">{step.title}</div>
                      {step.detail && <div className="step-detail">{step.detail}</div>}
                    </div>
                  </div>
                ))}
                {(!active.steps || active.steps.length === 0) && <div className="empty">No steps yet.</div>}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">🛠</div>
              <h2>No build selected</h2>
              <p>Start a new build or pick one from the sidebar.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
