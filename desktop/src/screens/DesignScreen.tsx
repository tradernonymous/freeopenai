import { useState, useEffect } from 'react';
import { api } from '../api';

interface Template {
  id: string;
  name: string;
  category: string;
  preview?: string;
}

interface Project {
  id: string;
  name: string;
  updatedAt: number;
}

export default function DesignScreen() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    api.designTemplates().then((t: any) => setTemplates(Array.isArray(t) ? t : []));
    api.designProjects().then((p: any) => setProjects(Array.isArray(p) ? p : []));
  }, []);

  const createProject = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const p = await api.designCreateProject({ name: name.trim() });
      setProjects((prev) => [p, ...prev]);
      setSelected((p as any).id);
      setName('');
    } catch (e) {
      setLog((prev) => [...prev, `Error: ${(e as Error).message}`]);
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!selected) return;
    setBusy(true);
    setLog((prev) => [...prev, 'Generating…']);
    try {
      const r = await api.designGenerate({ projectId: selected, prompt: 'auto' });
      setLog((prev) => [...prev, `Generated ${(r as any).assets?.length || 0} assets`]);
    } catch (e) {
      setLog((prev) => [...prev, `Error: ${(e as Error).message}`]);
    } finally {
      setBusy(false);
    }
  };

  const export_ = async () => {
    if (!selected) return;
    try {
      const r = await api.designExport({ projectId: selected, format: 'png' });
      setLog((prev) => [...prev, `Exported: ${(r as any).url || 'ok'}`]);
    } catch (e) {
      setLog((prev) => [...prev, `Error: ${(e as Error).message}`]);
    }
  };

  return (
    <div className="screen design">
      <header className="screen-header">
        <h1>Design</h1>
        <div className="header-actions">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project…" />
          <button onClick={createProject} disabled={busy || !name.trim()}>
            {busy ? '…' : '+ New'}
          </button>
        </div>
      </header>

      <div className="design-layout">
        <aside className="design-sidebar">
          <div className="panel">
            <h3>Templates</h3>
            <div className="template-list">
              {templates.map((t) => (
                <button key={t.id} className={`template-item ${selected === t.id ? 'active' : ''}`} onClick={() => setSelected(t.id)}>
                  <div className="template-name">{t.name}</div>
                  <div className="template-cat">{t.category}</div>
                </button>
              ))}
              {templates.length === 0 && <div className="empty">No templates yet</div>}
            </div>
          </div>

          <div className="panel">
            <h3>Projects</h3>
            <div className="project-list">
              {projects.map((p) => (
                <button key={p.id} className={`project-item ${selected === p.id ? 'active' : ''}`} onClick={() => setSelected(p.id)}>
                  <div className="project-name">{p.name}</div>
                  <div className="project-date">{new Date(p.updatedAt).toLocaleString()}</div>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="design-main">
          {selected ? (
            <div className="design-editor">
              <div className="design-toolbar">
                <button onClick={generate} disabled={busy}>Generate</button>
                <button onClick={export_} disabled={busy}>Export PNG</button>
                <span className="design-id">Project: {selected}</span>
              </div>
              <div className="design-canvas">
                <div className="canvas-placeholder">Canvas preview — {templates.find((t) => t.id === selected)?.name || 'project'}</div>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">🎨</div>
              <h2>Select a template or project</h2>
              <p>Choose from the sidebar to start designing.</p>
            </div>
          )}
          {log.length > 0 && (
            <div className="design-log">
              {log.map((l, i) => (
                <div key={i} className="log-line">
                  {l}
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
