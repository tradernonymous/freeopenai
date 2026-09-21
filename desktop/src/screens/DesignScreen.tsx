import { useState, useEffect, useRef, useCallback } from 'react';
import { api, streamChat } from '../api';
import { escapeHtml } from '../markdown';
import Icon from '../components/Icon';
import SelectPill from '../components/SelectPill';
import { isSavedProvider, streamSaved } from '../run-model';
import '../saved-models.js';
// The design modules are UMD (shared with node:test): the import runs the
// factory, which hangs the API off globalThis in the browser.
import '../design/brand.js';
import '../design/slop.js';

const brand: typeof import('../design/brand.js') = (globalThis as any).FreeAI4UBrand;
const slop: typeof import('../design/slop.js') = (globalThis as any).FreeAI4USlop;
const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;

/** "My models" behind the same call shape streamChat has. */
const streamMine: typeof streamChat = (provider, body, onFrame, signal) =>
  streamSaved(provider, body.model, body.messages, onFrame, signal);
const mineRows = () => savedModels.providerRows().map((p) => ({ id: p.id, label: p.label }));

interface Template {
  id: string;
  label: string;
  category: string;
  width: number;
  height: number;
  unit: string;
  description: string;
}

interface Project {
  id: string;
  name: string;
  template: string;
  prompt?: string;
  canvas?: { html?: string };
  brand?: any;
  status: string;
  updatedAt: number;
}

interface Draft {
  html: string;
  findings: Array<{ id: string; label: string; why: string; fix: string }>;
  score: number;
}

const SYSTEM_PROMPT =
  'You are a systematic graphic designer. Reply with ONE complete, self-contained HTML document ' +
  '(inline <style>, no external assets, no frameworks, no lorem ipsum) implementing the request. ' +
  'Honor the DESIGN.md contract when given: use its semantic roles, font stack and dials, and keep ' +
  'text contrast at WCAG AA (4.5:1). Write real copy. No markdown fences in the reply.';

/** Pulls the first complete HTML document out of a model reply. */
function htmlFromReply(text: string): string | null {
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const doc = candidate.match(/<!DOCTYPE html[\s\S]*<\/html>/i) || candidate.match(/<html[\s\S]*<\/html>/i);
  if (doc) return doc[0];
  if (/<[a-z][\s\S]*>/i.test(candidate) && candidate.length > 120) return candidate;
  return null;
}

export default function DesignScreen() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState('');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('a4-document');
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [working, setWorking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState('');
  const [brandUrl, setBrandUrl] = useState('');
  const [brandBusy, setBrandBusy] = useState(false);
  const [showDesignMd, setShowDesignMd] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const active = projects.find((p) => p.id === activeId) || null;

  const refresh = useCallback(async () => {
    try {
      const rows: any = await api.designProjects();
      setProjects(Array.isArray(rows) ? rows : []);
    } catch { setProjects([]); }
  }, []);

  useEffect(() => {
    api.designTemplates().then((t: any) => setTemplates(Array.isArray(t) ? t : [])).catch(() => setTemplates([]));
    refresh();
    api.providers().then((rows: any) => {
      const chat = (Array.isArray(rows) ? rows : []).filter((p: any) => p.kind !== 'image' && p.configured);
      setProviders([...mineRows(), ...chat.map((p: any) => ({ id: p.id, label: p.label }))]);
      if (chat.length) setProvider(chat[0].id);
      else if (mineRows().length) setProvider(mineRows()[0].id);
    }).catch(() => {
      // No engine is not no models: what runs on this PC is still offered.
      setProviders(mineRows());
      if (mineRows().length) setProvider(mineRows()[0].id);
    });
  }, [refresh]);

  useEffect(() => {
    if (!provider) { setModels([]); return; }
    if (isSavedProvider(provider)) {
      const ids = savedModels.modelsFor(provider).map((m) => m.id);
      setModels(ids);
      setModel((m) => (ids.includes(m) ? m : ids[0] || ''));
      return;
    }
    api.models(provider).then((rows: any) => {
      const ids = (Array.isArray(rows) ? rows : []).map((r: any) => String(r.id || r));
      setModels(ids);
      setModel((m) => (ids.includes(m) ? m : ids[0] || ''));
    }).catch(() => setModels([]));
  }, [provider]);

  const openProject = async (id: string) => {
    setActiveId(id);
    setDraft(null);
    setError('');
    try {
      const p: any = await api.designGetProject(id);
      setProjects((prev) => prev.map((x) => (x.id === id ? p : x)));
    } catch { /* the list entry still shows */ }
  };

  const createProject = async () => {
    if (!name.trim()) return;
    try {
      const p: any = await api.designCreateProject({ name: name.trim(), template: templateId });
      await refresh();
      setActiveId(p.id);
      setName('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveCanvas = async (html: string) => {
    if (!active) return;
    try {
      await api.designUpdateProject(active.id, { canvas: { html }, status: 'drafted' });
      setProjects((prev) => prev.map((x) => (x.id === active.id ? { ...x, canvas: { html }, status: 'drafted' } : x)));
    } catch (err) {
      setError('Saved locally, not on the server: ' + (err as Error).message);
    }
  };

  // ---- generation: the engine's chat route is the design engine ------------

  const generate = async () => {
    const text = prompt.trim();
    if (!text || !provider || !model || working) return;
    setWorking(true);
    setError('');
    setDraft(null);
    setStreamText('');

    const brandMd = active?.brand ? brand.designMd(active.brand, active.name) : '';
    const tpl = templates.find((t) => t.id === (active?.template || templateId));
    const ask = [
      text,
      tpl ? `Format: ${tpl.label} (${tpl.width}x${tpl.height}${tpl.unit}).` : '',
      brandMd ? `DESIGN.md contract:\n${brandMd}` : '',
    ].filter(Boolean).join('\n\n');

    // Record the hook on the project (status, prompt) -- best effort; the
    // artifact itself is produced by the chat route below.
    api.designGenerate({ projectId: active!.id, prompt: text, provider, model }).catch(() => {});

    const controller = new AbortController();
    abortRef.current = controller;
    let acc = '';
    try {
      await (isSavedProvider(provider) ? streamMine : streamChat)(provider, {
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: ask },
        ],
      }, (frame) => {
        if (frame.content) {
          acc += frame.content;
          setStreamText(acc.slice(-600));
        }
      }, controller.signal);
      const html = htmlFromReply(acc);
      if (!html) {
        setError('The model replied but no HTML document could be found in it. Try "reply with one complete HTML document".');
      } else {
        const verdict = slop.score(html);
        setDraft({ html, ...verdict });
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setWorking(false);
      setStreamText('');
      abortRef.current = null;
    }
  };

  const applyDraft = async () => {
    if (!draft || !active) return;
    await saveCanvas(draft.html);
    setDraft(null);
    setPrompt('');
  };

  // ---- brand: extract from a real page through the engine's SSRF-safe fetch

  const extractBrand = async () => {
    const url = brandUrl.trim();
    if (!url || !active || brandBusy) return;
    setBrandBusy(true);
    setError('');
    try {
      const page: any = await api.fetchUrl(url);
      const text = String(page?.text || page?.content || '');
      const palette = brand.paletteFromText(text, 8);
      if (!palette.length) {
        setError('No colors found on that page (it may render everything in images).');
        return;
      }
      const brandObj = {
        url,
        palette,
        roles: brand.semanticRoles(palette),
        fontStack: (text.match(/font-family:\s*([^;}]+)/i) || [])[1]?.trim() || '',
        source: 'extracted',
      };
      await api.designSaveBrand({ projectId: active.id, ...brandObj });
      setProjects((prev) => prev.map((x) => (x.id === active.id ? { ...x, brand: brandObj } : x)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBrandBusy(false);
    }
  };

  // ---- export ---------------------------------------------------------------

  const exportHtml = () => {
    const html = active?.canvas?.html;
    if (!html) return;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${active.name.replace(/[^\w-]+/g, '-')}.html`;
    a.click();
  };

  const exportPdf = () => {
    // The browser's print engine is the PDF pipeline: the sandboxed iframe
    // holds the artifact, print-to-PDF is deck- and page-aware from there.
    const frame = iframeRef.current;
    if (frame && active?.canvas?.html) {
      try { (frame as any).contentWindow.print(); } catch { /* sandbox blocks it; HTML export still works */ }
    }
  };

  const template = templates.find((t) => t.id === (active?.template || templateId));
  const roles = active?.brand?.roles || null;

  return (
    <div className="screen design">
      <header className="screen-header">
        <h1>Design</h1>
        <div className="header-actions">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project…" style={{ width: 160 }} />
          <SelectPill
            label="Template"
            title="Which template a new project starts from"
            value={templateId}
            options={templates.map((t: any) => ({
              value: t.id,
              label: t.label,
              note: `${t.width}×${t.height}${t.unit}`,
            }))}
            onPick={(id) => setTemplateId(id)}
          />
          <button onClick={createProject} disabled={!name.trim()}><Icon name="plus" size={14} /> New</button>
        </div>
      </header>

      <div className="design-layout">
        <aside className="design-sidebar">
          <div className="panel">
            <h3>Projects</h3>
            <div className="project-list">
              {projects.map((p) => (
                <button key={p.id} className={`project-item ${activeId === p.id ? 'active' : ''}`} onClick={() => openProject(p.id)}>
                  <div className="project-name">{p.name}</div>
                  <div className="project-date">{p.status} · {new Date(p.updatedAt).toLocaleDateString()}</div>
                </button>
              ))}
              {!projects.length && <div className="empty">Name a project above and create it.</div>}
            </div>
          </div>

          <div className="panel">
            <h3>Brand (DESIGN.md)</h3>
            {active ? (
              <>
                <input value={brandUrl} onChange={(e) => setBrandUrl(e.target.value)} placeholder="https://brand-site.com" style={{ width: '100%' }} />
                <button onClick={extractBrand} disabled={brandBusy || !brandUrl.trim()} style={{ marginTop: 6 }}>
                  {brandBusy ? 'Extracting…' : 'Extract from URL'}
                </button>
                {roles && (
                  <div className="brand-roles">
                    {(['paper', 'ink', 'accent', 'muted'] as const).map((role) => {
                      const report = brand.contrastReport(roles[role], roles.paper);
                      return (
                        <div key={role} className="brand-role">
                          <span className="swatch" style={{ background: roles[role] }} />
                          <span className="role-name">{role}</span>
                          <span className="role-hex">{roles[role]}</span>
                          <span className={`role-aa ${report.passAA ? 'ok' : 'bad'}`}>
                            {role === 'paper' ? 'bg' : `${report.ratio}:1`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {active.brand && (
                  <button className="linkish" onClick={() => setShowDesignMd((v) => !v)}>
                    {showDesignMd ? 'Hide' : 'Show'} DESIGN.md
                  </button>
                )}
                {showDesignMd && active.brand && (
                  <pre className="skill-content" style={{ maxHeight: 220 }}>{brand.designMd(active.brand, active.name)}</pre>
                )}
              </>
            ) : <div className="empty">Open a project first.</div>}
          </div>
        </aside>

        <main className="design-main">
          {active ? (
            <>
              <div className="design-toolbar">
                <SelectPill
                  label="Service"
                  title="Which service drafts the design"
                  value={provider}
                  options={providers.map((p: any) => ({ value: p.id, label: p.label }))}
                  onPick={(id) => setProvider(id)}
                />
                <SelectPill
                  label="Model"
                  title="Which model drafts the design"
                  value={model}
                  mono
                  filterable
                  options={models.map((m: string) => ({ value: m, label: m }))}
                  onPick={(m) => setModel(m)}
                />
                <span className="design-id">{template ? `${template.label} · ${template.width}×${template.height}${template.unit}` : ''}</span>
                <button onClick={exportHtml} disabled={!active.canvas?.html}>HTML</button>
                <button onClick={exportPdf} disabled={!active.canvas?.html}>PDF</button>
              </div>

              <div className="design-generate">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
                  placeholder={active.canvas?.html
                    ? 'Describe the change — the current canvas is the context…'
                    : 'Describe the artifact. The brand contract (if extracted) steers palette, type and density…'}
                  rows={2}
                />
                {working
                  ? <button className="stop-btn" onClick={() => abortRef.current?.abort()}>■ Stop</button>
                  : <button className="primary" onClick={generate} disabled={!prompt.trim() || !model}>Generate</button>}
              </div>

              {error && <div className="stream-error"><span>{error}</span></div>}

              {draft && (
                <div className="approval-card">
                  <div className="approval-title">
                    Draft ready — slop score {draft.score}/100
                    {draft.findings.length ? ` · ${draft.findings.length} finding(s)` : ' · clean'}
                  </div>
                  {draft.findings.slice(0, 4).map((f) => (
                    <div key={f.id} className="slop-finding">
                      <strong>{f.label}</strong> — {f.why} <em>Fix: {f.fix}</em>
                    </div>
                  ))}
                  <div className="approval-actions">
                    <button className="primary" onClick={applyDraft}>Apply to canvas</button>
                    <button className="danger" onClick={() => setDraft(null)}>Discard</button>
                  </div>
                </div>
              )}

              <div className="design-canvas">
                {active.canvas?.html ? (
                  <iframe
                    ref={iframeRef}
                    title="Design preview"
                    sandbox="allow-scripts"
                    className="design-frame"
                    srcDoc={active.canvas.html}
                  />
                ) : draft ? null : (
                  <div className="canvas-placeholder">
                    {working ? 'Designing…' : 'Nothing on the canvas yet — describe it above.'}
                  </div>
                )}
                {working && streamText && (
                  <pre className="design-stream">{escapeHtml(streamText.slice(-400))}</pre>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-icon"><Icon name="design" size={28} /></div>
              <h2>Systematic design, not slot machines</h2>
              <p>Create a project, extract its brand from a real URL, then generate — every draft is scored against the anti-slop rules before you apply it.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
