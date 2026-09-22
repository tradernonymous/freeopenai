import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api, streamChat } from '../api';
import { escapeHtml } from '../markdown';
import Icon from '../components/Icon';
import SelectPill from '../components/SelectPill';
import { pushToast } from '../components/Toasts';
import { isSavedProvider, streamSaved } from '../run-model';
import { hasShell, writeLocalFile } from '../bridge';
import { saveFile } from '../files/save';
import { NAVIGATE_EVENT } from '../Sidebar';
import { DESIGN_BRIEF_KEY } from './ChatScreen';
import '../saved-models.js';
// The design modules are UMD (shared with node:test): the import runs the
// factory, which hangs the API off globalThis in the browser. systems.js
// before prompt.js -- the prompt reads the systems global.
import '../design/brand.js';
import '../design/slop.js';
import '../design/systems.js';
import '../design/prompt.js';
import '../design/artifact.js';
import '../design/versions.js';
import '../files/zip.js';

const brand: typeof import('../design/brand.js') = (globalThis as any).FreeAI4UBrand;
const slop: typeof import('../design/slop.js') = (globalThis as any).FreeAI4USlop;
const systemsLib: typeof import('../design/systems.js') = (globalThis as any).FreeAI4UDesignSystems;
const promptLib: typeof import('../design/prompt.js') = (globalThis as any).FreeAI4UDesignPrompt;
const artifact: typeof import('../design/artifact.js') = (globalThis as any).FreeAI4UArtifact;
const versionsLib: typeof import('../design/versions.js') = (globalThis as any).FreeAI4UDesignVersions;
const zip: typeof import('../files/zip.js') = (globalThis as any).FreeZip;
const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;

type DesignSystem = import('../design/systems.js').DesignSystem;
type Variant = import('../design/systems.js').Variant;
type Question = import('../design/artifact.js').Question;
type Version = import('../design/versions.js').Version;

// The Design studio: three panes.
//
//   left   -- the brief as a thread, the model and the design system;
//   centre -- the canvas: a sandboxed iframe (allow-scripts, never
//             same-origin) in a device frame, with View / Comment / Edit;
//   right  -- Tweaks (the page's tokens as controls), Tokens (the system,
//             import, brand from a URL), Comments, Checks (the anti-slop
//             gate) and History (a version per AI turn and per edit).
//
// A generation is a DRAFT until "Apply to canvas": it is scored first, and its
// three directions (by the book, refined, novel) are token swaps done here, so
// a local model generates once and still offers a choice.

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
  assumptions: string[];
  variants: Variant[];
  brief: string;
}

interface Pin {
  id: string;
  nid: string;
  tag: string;
  text: string;
  outer: string;
  comment: string;
}

type Tool = 'view' | 'comment' | 'edit';
type Tab = 'tweaks' | 'tokens' | 'comments' | 'checks' | 'history';

const VIEWPORTS: Record<string, { label: string; width: number; height: number }> = {
  phone: { label: 'Phone', width: 390, height: 844 },
  tablet: { label: 'Tablet', width: 820, height: 1180 },
  desktop: { label: 'Desktop', width: 1440, height: 900 },
  deck: { label: 'Deck', width: 1920, height: 1080 },
};

const THREAD_PREFIX = 'freeai4u.design_thread.';

function readThread(id: string): Array<{ who: 'you' | 'studio'; text: string }> {
  try {
    const rows = JSON.parse(localStorage.getItem(THREAD_PREFIX + id) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function slugOf(name: string): string {
  return (name || 'design').toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design';
}

/** Compare two data-nid paths as documents order them ("0.10" after "0.9"). */
function nidOrder(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export default function DesignScreen() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState('');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('landing-page');
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [imported, setImported] = useState<DesignSystem[]>(() => systemsLib.readStore());
  const [systemId, setSystemId] = useState('neutral-minimal');
  const [brief, setBrief] = useState('');
  const [thread, setThread] = useState<Array<{ who: 'you' | 'studio'; text: string }>>([]);
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pendingBrief, setPendingBrief] = useState('');
  const [working, setWorking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [variantId, setVariantId] = useState<Variant['id']>('book');
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState('');
  const [brandUrl, setBrandUrl] = useState('');
  const [brandBusy, setBrandBusy] = useState(false);
  const [viewport, setViewport] = useState<keyof typeof VIEWPORTS>('desktop');
  const [fit, setFit] = useState(true);
  const [tool, setTool] = useState<Tool>('view');
  const [tab, setTab] = useState<Tab>('tweaks');
  const [pins, setPins] = useState<Pin[]>([]);
  const [tweaks, setTweakValues] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<Version[]>([]);
  // What the iframe is showing. Set only when the page changes from OUTSIDE
  // (a draft, a restore, a variant): an edit made inside the frame must not
  // reload the frame under the person's cursor.
  const [frameDoc, setFrameDoc] = useState('');
  const [box, setBox] = useState({ w: 800, h: 600 });
  const abortRef = useRef<AbortController | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameLabel = useRef('Direct edit');
  const frameEdit = useRef('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = projects.find((p) => p.id === activeId) || null;
  const canvasHtml = active?.canvas?.html || '';
  const brandSystem = active?.brand ? systemsLib.fromBrand(active.brand, active.name) : null;
  const allSystems = [...(brandSystem ? [brandSystem] : []), ...systemsLib.PRESETS, ...imported];
  const system = allSystems.find((s) => s.id === systemId) || systemsLib.PRESETS[0];
  const template = templates.find((t) => t.id === (active?.template || templateId));
  const tier = promptLib.tierOf(provider);
  const variant = draft?.variants.find((v) => v.id === variantId) || null;
  const shownHtml = draft ? (variantId === 'book' || !variant ? draft.html : artifact.setTweaks(draft.html, variant.vars)) : canvasHtml;

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
    // A brief sent from Chat (/design, or "To Design" on a reply).
    try {
      const handed = sessionStorage.getItem(DESIGN_BRIEF_KEY);
      if (handed) { sessionStorage.removeItem(DESIGN_BRIEF_KEY); setBrief(handed); }
    } catch { /* nothing handed over */ }
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

  // The project's own thread and timeline, and its brand as the default system.
  useEffect(() => {
    if (!activeId) return;
    setThread(readThread(activeId));
    setVersions(versionsLib.list(activeId));
    setPins([]);
    setQuestions(null);
    setDraft(null);
  }, [activeId]);
  const hasBrand = !!active?.brand;
  useEffect(() => { if (hasBrand) setSystemId('brand'); }, [activeId, hasBrand]);

  // Whatever should be on the canvas, loaded into the frame with the host
  // script -- unless the change came FROM the frame (a direct edit or a
  // tweak), which the frame already shows.
  useEffect(() => {
    if (shownHtml && shownHtml === frameEdit.current) return;
    setFrameDoc(shownHtml ? artifact.inject(shownHtml) : '');
  }, [shownHtml]);

  // The frame's size follows the stage; "Fit" scales the device down into it.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const say = (who: 'you' | 'studio', text: string) => {
    setThread((prev) => {
      const next = [...prev, { who, text }].slice(-30);
      try { localStorage.setItem(THREAD_PREFIX + activeId, JSON.stringify(next)); } catch { /* the session keeps it */ }
      return next;
    });
  };

  const post = (message: Record<string, unknown>) => {
    try { iframeRef.current?.contentWindow?.postMessage(message, '*'); } catch { /* the frame is reloading */ }
  };

  const saveCanvas = async (html: string) => {
    if (!active) return;
    setProjects((prev) => prev.map((x) => (x.id === active.id ? { ...x, canvas: { html }, status: 'drafted' } : x)));
    try {
      await api.designUpdateProject(active.id, { canvas: { html }, status: 'drafted' });
    } catch (err) {
      setError('Kept here, not saved on the engine: ' + (err as Error).message);
    }
  };

  /** A new canvas from outside the frame: saved, versioned and reloaded. */
  const commit = (html: string, label: string) => {
    if (!active) return;
    const clean = artifact.strip(html);
    frameEdit.current = '';
    saveCanvas(clean);
    setVersions(versionsLib.push(active.id, { html: clean, label }));
  };

  // What the frame says. Only the frame this screen made is listened to.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const data = e.data || {};
      if (data.type === 'neura:ready') {
        post({ type: 'neura:mode', mode: draft ? 'view' : tool });
        post({ type: 'neura:pins', nids: pins.map((p) => p.nid) });
      } else if (data.type === 'neura:pick' && !draft) {
        const pin: Pin = { id: `p${Date.now().toString(36)}`, nid: String(data.nid || ''), tag: String(data.tag || ''), text: String(data.text || ''), outer: String(data.outer || ''), comment: '' };
        setPins((prev) => (prev.some((p) => p.nid === pin.nid) ? prev : [...prev, pin]));
        setTab('comments');
      } else if (data.type === 'neura:html' && !draft && active) {
        // An edit made in the frame: kept without reloading the frame, saved
        // and versioned once the edits pause.
        const clean = artifact.strip(String(data.html || ''));
        frameEdit.current = clean;
        setProjects((prev) => prev.map((x) => (x.id === active.id ? { ...x, canvas: { html: clean } } : x)));
        if (saveTimer.current) clearTimeout(saveTimer.current);
        const label = frameLabel.current;
        const projectId = active.id;
        saveTimer.current = setTimeout(() => {
          api.designUpdateProject(projectId, { canvas: { html: clean }, status: 'drafted' }).catch(() => {});
          setVersions(versionsLib.push(projectId, { html: clean, label }));
        }, 900);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  useEffect(() => {
    post({ type: 'neura:mode', mode: draft ? 'view' : tool });
    if (tool === 'edit') frameLabel.current = 'Direct edit';
  }, [tool, draft]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { post({ type: 'neura:pins', nids: pins.map((p) => p.nid) }); }, [pins]); // eslint-disable-line react-hooks/exhaustive-deps

  const openProject = async (id: string) => {
    setActiveId(id);
    setError('');
    setTweakValues({});
    frameEdit.current = '';
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

  // ---- generation: the engine's chat route (or a local model) is the designer

  const collect = async (messages: Array<{ role: string; content: string }>, controller: AbortController, onText?: (text: string) => void) => {
    let acc = '';
    await (isSavedProvider(provider) ? streamMine : streamChat)(provider, { model, messages }, (frame) => {
      if (frame.content) {
        acc += frame.content;
        onText?.(acc);
      }
    }, controller.signal);
    return acc;
  };

  const generate = async (withAnswers?: Array<{ label: string; answer: string }>) => {
    const text = (withAnswers ? pendingBrief : brief).trim();
    if (!text || !provider || !model || working || !active) return;
    setWorking(true);
    setError('');
    setDraft(null);
    setStreamText('');
    setQuestions(null);
    if (!withAnswers) say('you', text);
    const deck = /deck|slide|present/i.test(`${template?.id || ''} ${template?.category || ''}`) || viewport === 'deck';
    const messages = promptLib.buildMessages({
      brief: text,
      system,
      tier,
      format: template ? { label: template.label, width: template.width, height: template.height, unit: template.unit, deck } : { deck },
      html: canvasHtml ? artifact.strip(canvasHtml) : '',
      answers: withAnswers,
    });
    // Record the hook on the project (status, prompt) -- best effort; the
    // artifact itself is produced by the chat route below.
    api.designGenerate({ projectId: active.id, prompt: text, provider, model }).catch(() => {});
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const reply = await collect(messages, controller, (acc) => setStreamText(acc.slice(-600)));
      const found = artifact.extract(reply);
      if (!found.html && found.questions) {
        setQuestions(found.questions);
        setAnswers({});
        setPendingBrief(text);
        say('studio', `${found.questions.length} question${found.questions.length === 1 ? '' : 's'} before I start.`);
        return;
      }
      if (!found.html) {
        setError('The model replied, but there was no HTML page in it. Try again, or a larger model.');
        say('studio', 'No page came back.');
        return;
      }
      const verdict = slop.score(found.html);
      setDraft({ html: found.html, ...verdict, assumptions: found.assumptions, variants: systemsLib.variants(system.tokens), brief: text });
      setVariantId('book');
      setBrief('');
      say('studio', `Draft ready: anti-slop score ${verdict.score}/100${verdict.findings.length ? `, ${verdict.findings.length} finding(s)` : ''}. Three directions to pick from.`);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setWorking(false);
      setStreamText('');
      abortRef.current = null;
    }
  };

  const applyDraft = () => {
    if (!draft || !active) return;
    const html = variantId === 'book' || !variant ? draft.html : artifact.setTweaks(draft.html, variant.vars);
    commit(html, `AI: ${draft.brief.slice(0, 48)}${variantId === 'book' ? '' : ` (${variant?.label})`}`);
    setDraft(null);
    setTweakValues({});
  };

  // ---- comments: one element at a time, so a small model can do it ---------

  const applyComments = async () => {
    const todo = pins.filter((p) => p.comment.trim());
    if (!todo.length || working || !active) return;
    setWorking(true);
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    frameLabel.current = `Comments: ${todo.length}`;
    // Last in the document first: replacing a later element never renumbers
    // an earlier one.
    const ordered = todo.slice().sort((a, b) => nidOrder(b.nid, a.nid));
    let done = 0;
    try {
      for (const pin of ordered) {
        const reply = await collect(promptLib.commentMessages({ outer: pin.outer, comment: pin.comment, tokens: system.tokens, tier }), controller);
        const fragment = artifact.extractFragment(reply);
        if (!fragment) continue;
        post({ type: 'neura:replace', nid: pin.nid, html: fragment });
        done += 1;
      }
      setPins((prev) => prev.filter((p) => !todo.includes(p)));
      say('studio', `Applied ${done} of ${todo.length} comment(s).`);
      if (done < todo.length) pushToast('warn', `${todo.length - done} comment(s) came back without an element; they were left as they were.`);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setWorking(false);
      abortRef.current = null;
    }
  };

  // ---- tweaks: the page's own tokens as controls ------------------------------

  const vars = useMemo(() => artifact.cssVars(canvasHtml), [canvasHtml]);
  const setTweak = (varName: string, value: string) => {
    const next = { ...tweaks, [varName]: value };
    setTweakValues(next);
    frameLabel.current = 'Tweaks';
    post({ type: 'neura:set-tweaks', vars: next });
  };
  const resetTweaks = () => {
    setTweakValues({});
    commit(artifact.setTweaks(canvasHtml, {}), 'Tweaks reset');
  };

  // ---- brand: extract from a real page through the engine's SSRF-safe fetch --

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
        setError('No colours found on that page (it may draw everything in images).');
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
      setSystemId('brand');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBrandBusy(false);
    }
  };

  const importFile = (file: File) => {
    file.text().then((source) => {
      const sys = systemsLib.importSystem(source, file.name.replace(/\.(md|css|txt)$/i, ''));
      if (!sys) { pushToast('warn', `${file.name} has no --tokens in it.`); return; }
      setImported(systemsLib.saveImported(sys));
      setSystemId(sys.id);
      pushToast('ok', `${sys.name}: ${Object.keys(sys.tokens).length} tokens.`);
    }).catch(() => pushToast('error', 'That file could not be read.'));
  };

  // ---- exports: on the host, never from inside the sandbox --------------------

  const bytes = (text: string) => new TextEncoder().encode(text);
  const exportHtml = () => {
    if (!canvasHtml || !active) return;
    saveFile({ name: `${slugOf(active.name)}.html`, bytes: bytes(artifact.strip(canvasHtml)), mime: 'text/html' })
      .then((m) => pushToast('ok', m)).catch((e: unknown) => pushToast('error', String((e as Error).message || e)));
  };

  const exportPdf = () => {
    // The print engine is the PDF pipeline. The canvas frame stays strict; a
    // throwaway frame that may open the print dialog (allow-modals) prints a
    // copy and is removed.
    if (!canvasHtml) return;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-modals');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;';
    frame.srcdoc = `${artifact.strip(canvasHtml)}<script>setTimeout(function(){window.print();},400);</` + 'script>';
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 120000);
  };

  const handoff = async () => {
    if (!canvasHtml || !active) return;
    const slug = slugOf(active.name);
    const files: Array<[string, string]> = [
      ['index.html', artifact.strip(canvasHtml)],
      ['tokens.css', systemsLib.tokensCss(system)],
      ['DESIGN.md', systemsLib.designMd(system)],
      ['README.md', [
        `# ${active.name} — handoff`,
        '',
        '`index.html` is the approved design, self-contained. `tokens.css` and `DESIGN.md` are the system it was made with.',
        '',
        'To implement: keep the tokens as CSS custom properties (or map them to your theme), rebuild the page as components, and keep text contrast at WCAG AA.',
        '',
      ].join('\n')],
    ];
    const folder = (() => { try { return localStorage.getItem('freeai4u.localRoot') || ''; } catch { return ''; } })();
    try {
      if (hasShell() && folder) {
        for (const [file, text] of files) await writeLocalFile(folder, `design-handoff/${slug}/${file}`, text);
        pushToast('ok', `Handed off to design-handoff/${slug}/ in the open folder.`);
        window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { view: 'code' } }));
        return;
      }
      const archive = await zip.writeZip(files.map(([file, text]) => ({ name: `${slug}/${file}`, data: bytes(text) })));
      pushToast('ok', await saveFile({ name: `${slug}-handoff.zip`, bytes: archive, mime: 'application/zip' }));
    } catch (e) {
      pushToast('error', String((e as Error).message || e));
    }
  };

  // ---- layout ----------------------------------------------------------------

  const device = VIEWPORTS[viewport];
  const scale = fit ? Math.max(0.1, Math.min(1, (box.w - 32) / device.width, (box.h - 32) / device.height)) : 1;
  const checks = useMemo(() => (canvasHtml ? slop.score(canvasHtml) : null), [canvasHtml]);

  return (
    <div className="screen design studio">
      <aside className="studio-left">
        <div className="studio-block">
          <SelectPill
            label="Project"
            title="Which design project is open"
            value={activeId}
            options={projects.map((p) => ({ value: p.id, label: p.name, note: p.status }))}
            onPick={(id) => openProject(id)}
          />
          <div className="studio-new">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project…" aria-label="New project name" />
            <SelectPill
              label="Template"
              title="Which template a new project starts from"
              value={templateId}
              options={templates.map((t: any) => ({ value: t.id, label: t.label, note: `${t.width}×${t.height}${t.unit}` }))}
              onPick={(id) => setTemplateId(id)}
            />
            <button onClick={createProject} disabled={!name.trim()} aria-label="Create project"><Icon name="plus" size={14} /></button>
          </div>
        </div>
        <div className="studio-block studio-pickers">
          <SelectPill
            label="Service"
            title="Which service designs"
            value={provider}
            options={providers.map((p: any) => ({ value: p.id, label: p.label }))}
            onPick={(id) => setProvider(id)}
          />
          <SelectPill
            label="Model"
            title="Which model designs"
            value={model}
            mono
            filterable
            options={models.map((m: string) => ({ value: m, label: m }))}
            onPick={(m) => setModel(m)}
          />
          <SelectPill
            label="System"
            title="The design system every page is styled through"
            value={system.id}
            options={allSystems.map((s) => ({ value: s.id, label: s.name }))}
            onPick={(id) => setSystemId(id)}
          />
          <span className={`chip tier-${tier}`} title={tier === 'local' ? 'Local tier: one generation, directions as token swaps, assumptions instead of questions' : 'Cloud tier: may ask up to 5 questions first'}>
            {tier === 'local' ? 'local tier' : 'cloud tier'}
          </span>
        </div>

        <div className="studio-thread" aria-live="polite">
          {!active && <div className="empty">Create or open a project to start.</div>}
          {active && !thread.length && (
            <div className="empty">Describe what to design. The system above styles it; every draft is checked before it reaches the canvas.</div>
          )}
          {thread.map((row, i) => (
            <div key={i} className={`studio-turn is-${row.who}`}>{row.text}</div>
          ))}
          {working && streamText && <pre className="design-stream">{escapeHtml(streamText.slice(-400))}</pre>}
        </div>

        {questions ? (
          <form className="question-form" onSubmit={(e) => {
            e.preventDefault();
            generate(questions.map((q) => ({ label: q.label, answer: answers[q.id] || '(no preference)' })));
          }}>
            {questions.map((q) => (
              <div key={q.id} className="question">
                <span>{q.label}</span>
                {q.options.length ? (
                  <span className="question-options">
                    {q.options.map((opt) => (
                      <button type="button" key={opt} className={answers[q.id] === opt ? 'is-picked' : ''} onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}>{opt}</button>
                    ))}
                  </span>
                ) : (
                  <input aria-label={q.label} value={answers[q.id] || ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
                )}
              </div>
            ))}
            <div className="question-actions">
              <button type="button" onClick={() => setQuestions(null)}>Skip</button>
              <button type="submit" className="primary">Design it</button>
            </div>
          </form>
        ) : (
          <div className="studio-brief">
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
              placeholder={canvasHtml ? 'Describe the change — the canvas is the context' : 'Describe the page, deck or post to design'}
              rows={3}
              disabled={!active}
              aria-label="Design brief"
            />
            {working
              ? <button className="stop-btn" onClick={() => abortRef.current?.abort()}><Icon name="stop" size={12} /> Stop</button>
              : <button className="primary" onClick={() => generate()} disabled={!brief.trim() || !model || !active}>Generate</button>}
          </div>
        )}
        {error && <div className="stream-error"><span>{error}</span></div>}
      </aside>

      <main className="studio-centre">
        <div className="design-toolbar">
          <div className="seg" role="group" aria-label="Viewport">
            {Object.entries(VIEWPORTS).map(([id, v]) => (
              <button key={id} className={viewport === id ? 'active' : ''} onClick={() => setViewport(id as keyof typeof VIEWPORTS)}>{v.label}</button>
            ))}
          </div>
          <button className={fit ? 'active' : ''} onClick={() => setFit((f) => !f)} title="Fit the device to the stage, or show it at 100%">{fit ? `Fit ${Math.round(scale * 100)}%` : '100%'}</button>
          <div className="seg" role="group" aria-label="Canvas tool">
            {(['view', 'comment', 'edit'] as Tool[]).map((t) => (
              <button key={t} className={tool === t ? 'active' : ''} onClick={() => setTool(t)} disabled={!!draft || !canvasHtml}
                title={t === 'comment' ? 'Click an element to comment on it' : t === 'edit' ? 'Edit text directly on the canvas' : 'Look without changing'}>
                {t === 'view' ? 'View' : t === 'comment' ? 'Comment' : 'Edit'}
              </button>
            ))}
          </div>
          <span className="toolbar-spacer" />
          <button onClick={exportHtml} disabled={!canvasHtml}>HTML</button>
          <button onClick={exportPdf} disabled={!canvasHtml}>PDF</button>
          <button onClick={handoff} disabled={!canvasHtml} title="The page, tokens.css and DESIGN.md, into the open folder (or a ZIP)">Handoff to Code</button>
        </div>

        {draft && (
          <div className="approval-card draft-bar">
            <div className="approval-title">
              Draft — anti-slop score {draft.score}/100
              {draft.findings.length ? ` · ${draft.findings.length} finding(s)` : ' · clean'}
            </div>
            <div className="variant-row" role="radiogroup" aria-label="Direction">
              {draft.variants.map((v) => (
                <button key={v.id} role="radio" aria-checked={variantId === v.id} className={`variant-chip ${variantId === v.id ? 'active' : ''}`} onClick={() => setVariantId(v.id)} title={v.caption}>
                  <span className="variant-swatches">
                    {['--paper', '--ink', '--accent'].map((k) => <span key={k} className="swatch" style={{ background: v.vars[k] }} />)}
                  </span>
                  {v.label}
                </button>
              ))}
              <span className="variant-note">{variant?.caption}{variantId === 'book' ? ' Recommended: the system as chosen.' : ''}</span>
            </div>
            {draft.assumptions.length > 0 && (
              <div className="draft-assumptions">Assumed: {draft.assumptions.join(' · ')}</div>
            )}
            {draft.findings.slice(0, 3).map((f) => (
              <div key={f.id} className="slop-finding"><strong>{f.label}</strong> — {f.why} <em>Fix: {f.fix}</em></div>
            ))}
            <div className="approval-actions">
              <button className="primary" onClick={applyDraft}>Apply to canvas</button>
              <button onClick={() => setBrief(`More like the ${variant?.label || 'current'} direction: `)}>More like this</button>
              <button className="danger" onClick={() => setDraft(null)}>Discard</button>
            </div>
          </div>
        )}

        <div className="studio-stage" ref={stageRef}>
          {frameDoc ? (
            <div className={`device device-${viewport}`} style={{ width: device.width * scale, height: device.height * scale }}>
              <iframe
                ref={iframeRef}
                title="Design canvas"
                sandbox="allow-scripts"
                className={`design-frame tool-${draft ? 'view' : tool}`}
                srcDoc={frameDoc}
                style={{ width: device.width, height: device.height, transform: scale === 1 ? undefined : `scale(${scale})` }}
              />
            </div>
          ) : (
            <div className="canvas-placeholder">
              {working ? 'Designing…' : active ? 'Nothing on the canvas yet — describe it on the left.' : 'Open or create a project.'}
            </div>
          )}
        </div>
      </main>

      <aside className="studio-right">
        <div className="inspector-tabs" role="tablist" aria-label="Inspector">
          {(['tweaks', 'tokens', 'comments', 'checks', 'history'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'comments' && pins.length ? `Comments ${pins.length}` : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="inspector-body">
          {tab === 'tweaks' && (
            vars.length ? (
              <div className="tweaks">
                {vars.map((v) => {
                  const value = tweaks[v.name] ?? v.value;
                  const control = artifact.controlFor(v.name, value);
                  return (
                    <label key={v.name} className="tweak">
                      <span className="mono">{v.name}</span>
                      {control.kind === 'color' && <input type="color" value={value} onChange={(e) => setTweak(v.name, e.target.value)} />}
                      {control.kind === 'length' && (
                        <input type="range" min={control.min} max={control.max} step={control.step} value={parseFloat(value)}
                          onChange={(e) => setTweak(v.name, `${e.target.value}${control.unit}`)} />
                      )}
                      {control.kind === 'number' && (
                        <input type="range" min={control.min} max={control.max} step={control.step} value={parseFloat(value)} onChange={(e) => setTweak(v.name, e.target.value)} />
                      )}
                      {control.kind === 'text' && <input value={value} onChange={(e) => setTweak(v.name, e.target.value)} />}
                      <span className="tweak-value mono">{value}</span>
                    </label>
                  );
                })}
                <button onClick={resetTweaks} disabled={!Object.keys(tweaks).length && !/neura-tweaks/.test(canvasHtml)}>Reset tweaks</button>
              </div>
            ) : <div className="empty">{canvasHtml ? 'This page declares no :root tokens to tweak.' : 'Tweaks appear once there is a page.'}</div>
          )}

          {tab === 'tokens' && (
            <div className="tokens-tab">
              <p className="settings-hint">{system.notes}</p>
              <pre className="skill-content">{systemsLib.tokensCss(system)}</pre>
              <details>
                <summary>DESIGN.md</summary>
                <pre className="skill-content">{systemsLib.designMd(system)}</pre>
              </details>
              <label className="import-file">
                <span>Import DESIGN.md or tokens.css</span>
                <input type="file" accept=".md,.css,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
              </label>
              <h4>Brand from a URL</h4>
              <input value={brandUrl} onChange={(e) => setBrandUrl(e.target.value)} placeholder="https://brand-site.com" disabled={!active} aria-label="Brand page address" />
              <button onClick={extractBrand} disabled={brandBusy || !brandUrl.trim() || !active}>{brandBusy ? 'Extracting…' : 'Extract'}</button>
              {brandSystem && (
                <div className="brand-roles">
                  {(['--paper', '--ink', '--accent', '--muted'] as const).map((role) => {
                    const report = brand.contrastReport(brandSystem.tokens[role], brandSystem.tokens['--paper']);
                    return (
                      <div key={role} className="brand-role">
                        <span className="swatch" style={{ background: brandSystem.tokens[role] }} />
                        <span className="role-name">{role}</span>
                        <span className={`role-aa ${report.passAA ? 'ok' : 'bad'}`}>{role === '--paper' ? 'bg' : `${report.ratio}:1`}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'comments' && (
            <div className="comments-tab">
              {!pins.length && <div className="empty">Pick <strong>Comment</strong> on the toolbar, then click an element on the canvas.</div>}
              {pins.map((pin, i) => (
                <div key={pin.id} className="pin">
                  <div className="pin-head">
                    <span className="pin-no">{i + 1}</span>
                    <span className="mono">&lt;{pin.tag}&gt;</span>
                    <span className="pin-text">{pin.text.slice(0, 60)}</span>
                    <button className="linkish" onClick={() => setPins((prev) => prev.filter((p) => p.id !== pin.id))}>Remove</button>
                  </div>
                  <textarea rows={2} value={pin.comment} placeholder="What should change here?" aria-label={`Comment ${i + 1}`} onChange={(e) => {
                    const comment = e.target.value;
                    setPins((prev) => prev.map((p) => (p.id === pin.id ? { ...p, comment } : p)));
                  }} />
                </div>
              ))}
              {pins.length > 0 && (
                <button className="primary" onClick={applyComments} disabled={working || !pins.some((p) => p.comment.trim()) || !model}>
                  Apply comments
                </button>
              )}
              <p className="settings-hint">Each comment sends only its element to the model, so smaller local models can do it.</p>
            </div>
          )}

          {tab === 'checks' && (
            checks ? (
              <div className="checks-tab">
                <div className="checks-score">{checks.score}<span>/100</span></div>
                {!checks.findings.length && <div className="empty">Clean: nothing the anti-slop gate flags.</div>}
                {checks.findings.map((f) => (
                  <div key={f.id} className="slop-finding"><strong>{f.label}</strong> — {f.why} <em>Fix: {f.fix}</em></div>
                ))}
              </div>
            ) : <div className="empty">Checks run on the canvas once there is a page.</div>
          )}

          {tab === 'history' && (
            <div className="history-tab">
              {!versions.length && <div className="empty">Every AI turn and every edit is kept here, on this PC.</div>}
              {versions.map((v, i) => (
                <div key={v.id} className="version-row">
                  <div>
                    <div className="version-label">{v.label}</div>
                    <div className="version-time">{new Date(v.ts).toLocaleString()}</div>
                  </div>
                  {i === 0
                    ? <span className="chip">current</span>
                    : <button onClick={() => { commit(v.html, `Restored: ${v.label}`); setTweakValues({}); }}>Restore</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
