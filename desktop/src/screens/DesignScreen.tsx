import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api, streamChat } from '../api';
import { escapeHtml } from '../markdown';
import Icon from '../components/Icon';
import SelectPill from '../components/SelectPill';
import { pushToast } from '../components/Toasts';
import { isSavedProvider, streamSaved } from '../run-model';
import { hasShell, writeLocalFile } from '../bridge';
import { saveFile, base64ToBytes } from '../files/save';
import { NAVIGATE_EVENT } from '../Sidebar';
import { DESIGN_BRIEF_KEY } from './ChatScreen';
import { CODE_HANDOFF_KEY } from './CodeScreen';
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
import '../design/tweaks.js';
import '../design/stage.js';
import '../design/critique.js';
import '../design/social.js';
import '../design/exports.js';
import '../design/diagram-layout.js';
import '../design/components.js';
import '../design/mockups.js';
// zip.js first: office.js takes its zip writer from the global.
import '../files/zip.js';
import '../files/office.js';

const brand: typeof import('../design/brand.js') = (globalThis as any).FreeAI4UBrand;
const slop: typeof import('../design/slop.js') = (globalThis as any).FreeAI4USlop;
const systemsLib: typeof import('../design/systems.js') = (globalThis as any).FreeAI4UDesignSystems;
const promptLib: typeof import('../design/prompt.js') = (globalThis as any).FreeAI4UDesignPrompt;
const artifact: typeof import('../design/artifact.js') = (globalThis as any).FreeAI4UArtifact;
const versionsLib: typeof import('../design/versions.js') = (globalThis as any).FreeAI4UDesignVersions;
const tweaksLib: typeof import('../design/tweaks.js') = (globalThis as any).FreeAI4UTweaks;
const stageLib: typeof import('../design/stage.js') = (globalThis as any).FreeAI4UStage;
const critiqueLib: typeof import('../design/critique.js') = (globalThis as any).FreeAI4UCritique;
const social: typeof import('../design/social.js') = (globalThis as any).FreeAI4USocial;
const exportsLib: typeof import('../design/exports.js') = (globalThis as any).FreeAI4UDesignExports;
const diagramLib: typeof import('../design/diagram-layout.js') = (globalThis as any).FreeAI4UDiagramLayout;
const componentsLib: typeof import('../design/components.js') = (globalThis as any).FreeAI4UDesignComponents;
const mockups: typeof import('../design/mockups.js') = (globalThis as any).FreeAI4UMockups;
const zip: typeof import('../files/zip.js') = (globalThis as any).FreeZip;
const office: typeof import('../files/office.js') = (globalThis as any).FreeOffice;
const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;

type DesignSystem = import('../design/systems.js').DesignSystem;
type Variant = import('../design/systems.js').Variant;
type Question = import('../design/artifact.js').Question;
type Version = import('../design/versions.js').Version;
type TweakSchema = import('../design/tweaks.js').TweakSchema;
type Critique = import('../design/critique.js').Critique;
type SlopFinding = import('../design/slop.js').SlopFinding;

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
//
// Phase 9: the page's own Tweaks schema (tweaks.js, a versioned protocol),
// device frames and deck mode (stage.js), the extended gate plus an optional
// model critique (slop.js, critique.js), the diagram type (diagram-layout.js),
// picture/PPTX/ZIP exports and the handoff to Code (exports.js), and the
// social templates (social.js).

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
  findings: SlopFinding[];
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
type Tab = 'tweaks' | 'tokens' | 'components' | 'mockups' | 'comments' | 'checks' | 'history';

type Viewport = import('../design/stage.js').PresetId;
const VIEWPORTS = stageLib.PRESETS;

/** The diagram artifact type: the model sends a graph, the studio draws it. */
const DIAGRAM_TEMPLATE: Template = {
  id: 'diagram',
  label: 'Diagram',
  category: 'diagram',
  width: 1200,
  height: 800,
  unit: 'px',
  description: 'Nodes and edges, laid out left to right with rounded orthogonal connectors (at most 9 nodes). Imports Mermaid flowcharts.',
};

type ExportKind = 'png' | 'svg' | 'pptx' | 'zip' | 'react' | 'flutter' | 'swiftui';

// Mockup card sizes: the social templates' own platform formats (social.js).
const MOCK_FORMATS = [
  { value: 'square', label: 'Square', note: '1080x1080 — Instagram', width: 1080, height: 1080 },
  { value: 'portrait', label: 'Portrait', note: '1080x1350 — LinkedIn', width: 1080, height: 1350 },
  { value: 'wide', label: 'Wide', note: '1200x675 — X', width: 1200, height: 675 },
] as const;

// One mockup slide onto a canvas at full size (CSS may scale the element),
// through design/mockups.js plan+paint. Module scope on purpose: the preview
// effect and the exporters share it, and exports can never drift from what
// the tab shows.
function renderMock(canvas: HTMLCanvasElement, text: string, fmt: { width: number; height: number }) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const measureOne = (t: string, size: number, weight: string) => {
    ctx.font = `${weight} ${size}px sans-serif`;
    return ctx.measureText(t).width;
  };
  const p = mockups.plan({ text, width: fmt.width, height: fmt.height }, measureOne);
  canvas.width = p.width;
  canvas.height = p.height;
  mockups.paint(ctx, p);
}
const EXPORTS: Array<{ value: ExportKind; label: string; note: string }> = [
  { value: 'png', label: 'PNG', note: 'each artboard (a slide, or the page)' },
  { value: 'svg', label: 'SVG', note: 'each artboard, as foreignObject' },
  { value: 'pptx', label: 'PPTX', note: 'one slide per section.slide (text)' },
  { value: 'zip', label: 'Project ZIP', note: 'page, tokens, DESIGN.md, history' },
  { value: 'react', label: 'React component (.tsx + .css)', note: 'a deterministic JSX conversion, tokens.css beside it' },
  { value: 'flutter', label: 'Flutter widget (AI)', note: 'the current model translates the page; tokens become theme constants' },
  { value: 'swiftui', label: 'SwiftUI view (AI)', note: 'the current model translates the page; tokens become theme constants' },
];

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

/** An SVG artboard drawn to a canvas: PNG bytes. The SVG holds no external refs, so the canvas stays clean. */
function svgToPng(svg: string, width: number, height: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('No 2D canvas here.')); return; }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('The artboard could not be encoded.')); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('The artboard could not be drawn as an image.'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/** Is a key press meant for a field rather than the deck? */
function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

/** The critique radar: five axes, the 5 and 10 rings, the score polygon. */
function CritiqueRadar({ scores }: { scores: Critique['scores'] }) {
  const r = critiqueLib.radar(scores, 220);
  return (
    <svg className="critique-radar" viewBox={`0 0 ${r.size} ${r.size}`} width={r.size} height={r.size} role="img"
      aria-label={r.axes.map((a) => `${a.label} ${a.value}`).join(', ')}>
      <polygon className="radar-ring" points={r.ring} />
      <polygon className="radar-ring" points={r.mid} />
      {r.axes.map((a) => <line key={a.id} className="radar-axis" x1={r.size / 2} y1={r.size / 2} x2={a.x} y2={a.y} />)}
      <polygon className="radar-score" points={r.polygon} />
      {r.axes.map((a) => (
        <text key={a.id} className="radar-label" x={a.lx} y={a.ly} textAnchor="middle" dominantBaseline="middle">{a.label} {a.value}</text>
      ))}
    </svg>
  );
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
  const [viewport, setViewport] = useState<Viewport>('desktop');
  // Deck mode: where the frame says it is ({index, count} from neura:deck).
  const [deck, setDeck] = useState({ index: 0, count: 0 });
  // The page's full size as the frame reports it (neura:size), for page exports.
  const [pageSize, setPageSize] = useState({ w: 0, h: 0 });
  // The page's own Tweaks schema (neura:tweaks-available) and its values.
  const [tweakSchema, setTweakSchema] = useState<TweakSchema | null>(null);
  const [schemaValues, setSchemaValues] = useState<Record<string, string>>({});
  const [critique, setCritique] = useState<Critique | null>(null);
  const [critiqueOn, setCritiqueOn] = useState(false);
  const [critiqueBusy, setCritiqueBusy] = useState(false);
  const [mermaidText, setMermaidText] = useState('');
  const [lastExport, setLastExport] = useState<ExportKind>('png');
  const [exporting, setExporting] = useState(false);
  // Mockups (NEURA-070, the viralai generator): the slide copy under edit,
  // which slide is showing, and the card format.
  const [mockSlides, setMockSlides] = useState<string[]>([]);
  const [mockIndex, setMockIndex] = useState(0);
  const [mockFormat, setMockFormat] = useState('square');
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
  const critiqueAbort = useRef<AbortController | null>(null);
  const mockCanvasRef = useRef<HTMLCanvasElement>(null);

  const active = projects.find((p) => p.id === activeId) || null;
  const canvasHtml = active?.canvas?.html || '';
  const brandSystem = active?.brand ? systemsLib.fromBrand(active.brand, active.name) : null;
  const allSystems = [...(brandSystem ? [brandSystem] : []), ...systemsLib.PRESETS, ...imported];
  const system = allSystems.find((s) => s.id === systemId) || systemsLib.PRESETS[0];
  // The engine's templates, the social ones (social.js) and the diagram type.
  const allTemplates: Template[] = useMemo(() => [...social.merge(templates), DIAGRAM_TEMPLATE], [templates]);
  const template = allTemplates.find((t) => t.id === (active?.template || templateId));
  const socialTpl = template ? social.byId(template.id) : null;
  const isDiagram = template?.id === DIAGRAM_TEMPLATE.id;
  const isDeckTemplate = !!socialTpl?.deck || /deck|slide|present/i.test(`${template?.id || ''} ${template?.category || ''}`);
  // Deck mode's stage: a carousel's own size, else 1920x1080.
  const stageFormat = socialTpl ? { width: socialTpl.width, height: socialTpl.height, unit: 'px' } : null;
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

  // The critique runs by itself only for a cloud provider (critique.js).
  useEffect(() => {
    setCritiqueOn(critiqueLib.defaultOn(promptLib.tierOf(provider), isSavedProvider(provider)));
  }, [provider]);

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
    setCritique(null);
  }, [activeId]);
  const hasBrand = !!active?.brand;
  useEffect(() => { if (hasBrand) setSystemId('brand'); }, [activeId, hasBrand]);
  // A deck or carousel project opens in deck mode.
  useEffect(() => { if (activeId && isDeckTemplate) setViewport('deck'); }, [activeId, isDeckTemplate]);

  // Whatever should be on the canvas, loaded into the frame with the host
  // script -- unless the change came FROM the frame (a direct edit or a
  // tweak), which the frame already shows. A reload re-announces the schema
  // and the deck, so both start over.
  useEffect(() => {
    if (shownHtml && shownHtml === frameEdit.current) return;
    setFrameDoc(shownHtml ? artifact.inject(shownHtml) : '');
    setTweakSchema(null);
    setDeck({ index: 0, count: 0 });
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
      } else if (data.type === 'neura:tweaks-available') {
        // Versioned: a schema from another protocol version is not guessed at.
        if (data.version !== tweaksLib.VERSION) { setTweakSchema(null); return; }
        const schema = tweaksLib.validateSchema(data.schema);
        setTweakSchema(schema);
        setSchemaValues(tweaksLib.initialValues(schema, draft ? draft.html : canvasHtml));
      } else if (data.type === 'neura:deck') {
        const count = Math.max(0, Math.min(500, Math.floor(Number(data.count) || 0)));
        setDeck({ index: stageLib.clampSlide(Number(data.index) || 0, count, 0), count });
      } else if (data.type === 'neura:size') {
        setPageSize({ w: Math.max(0, Math.min(8000, Number(data.w) || 0)), h: Math.max(0, Math.min(20000, Number(data.h) || 0)) });
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
    setCritique(null);
    const deck = isDeckTemplate || viewport === 'deck';
    const stage = stageLib.deckSize(stageFormat);
    const messages = isDiagram
      ? promptLib.diagramMessages({ brief: text, graph: diagramLib.graphFromHtml(canvasHtml) })
      : promptLib.buildMessages({
        brief: text,
        system,
        tier,
        // A deck is designed at its stage size, whatever the template says.
        format: deck
          ? { label: template?.label || 'Deck', width: stage.width, height: stage.height, unit: 'px', deck }
          : template ? { label: template.label, width: template.width, height: template.height, unit: template.unit } : null,
        html: canvasHtml ? artifact.strip(canvasHtml) : '',
        answers: withAnswers,
        platform: socialTpl ? socialTpl.prompt : '',
      });
    // Record the hook on the project (status, prompt) -- best effort; the
    // artifact itself is produced by the chat route below.
    api.designGenerate({ projectId: active.id, prompt: text, provider, model }).catch(() => {});
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const reply = await collect(messages, controller, (acc) => setStreamText(acc.slice(-600)));
      if (isDiagram) {
        const graph = diagramLib.extractGraph(reply);
        if (!graph || !graph.nodes.length) {
          setError('The model replied, but there was no diagram JSON in it. Try again, or paste a Mermaid flowchart below.');
          say('studio', 'No diagram came back.');
          return;
        }
        showDiagram(graph, text);
        return;
      }
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
      // The gate has spoken first; the critique is the second opinion.
      if (critiqueOn) runCritique(found.html, verdict.findings);
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

  // ---- diagrams: a graph in, a deterministic drawing out ----------------------

  /** A graph drawn as a page and offered as a draft, like any generation. */
  const showDiagram = (graph: import('../design/diagram-layout.js').Graph, label: string) => {
    if (!active) return;
    const html = diagramLib.toPage(graph, { title: active.name, tokens: system.tokens });
    const verdict = slop.score(html);
    setDraft({ html, ...verdict, assumptions: graph.message ? [graph.message] : [], variants: systemsLib.variants(system.tokens), brief: label });
    setVariantId('book');
    setBrief('');
    if (graph.trimmed) pushToast('warn', graph.message);
    say('studio', `Diagram drawn: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s).${graph.trimmed ? ' ' + graph.message : ''}`);
  };

  const importMermaid = () => {
    const graph = diagramLib.normalize(diagramLib.parseMermaid(mermaidText));
    if (!graph.nodes.length) { pushToast('warn', 'No flowchart nodes found (try "A[Start] --> B[Next]").'); return; }
    showDiagram(graph, 'Imported Mermaid');
    setMermaidText('');
  };

  // ---- critique: the optional second opinion, after the gate -----------------

  const runCritique = async (html: string, findings: SlopFinding[]) => {
    if (!html || !provider || !model || critiqueBusy) return;
    critiqueAbort.current?.abort();
    const controller = new AbortController();
    critiqueAbort.current = controller;
    setCritiqueBusy(true);
    try {
      const reply = await collect(critiqueLib.messages({ html: artifact.strip(html), tier, findings }), controller);
      const parsed = critiqueLib.parse(reply);
      if (!parsed) { pushToast('warn', 'The critique came back without scores; try again or a larger model.'); return; }
      setCritique(parsed);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') pushToast('error', `Critique failed: ${(err as Error).message}`);
    } finally {
      setCritiqueBusy(false);
      if (critiqueAbort.current === controller) critiqueAbort.current = null;
    }
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

  // The page's own controls (tweaks.js): each value sanitised against its
  // control, posted as a versioned neura:set-tweaks; the frame writes it into
  // the page's marker block and sends the page back, which saves a version.
  const setSchemaTweak = (varName: string, value: string) => {
    if (!tweakSchema || draft) return;
    const next = { ...schemaValues, [varName]: value };
    setSchemaValues(next);
    frameLabel.current = 'Tweaks';
    post(tweaksLib.message(tweakSchema, next));
  };
  const resetSchemaTweaks = () => {
    if (!tweakSchema || draft) return;
    const defaults = tweaksLib.initialValues(tweakSchema, '');
    setSchemaValues(defaults);
    frameLabel.current = 'Tweaks reset';
    post(tweaksLib.message(tweakSchema, defaults));
  };

  // ---- deck mode ----------------------------------------------------------------

  const goSlide = (delta: number) => {
    if (!deck.count) return;
    post({ type: 'neura:deck-go', index: stageLib.clampSlide(deck.index, deck.count, delta) });
  };
  // Arrow keys page the deck while the studio (not the frame, not a field) has focus.
  useEffect(() => {
    if (viewport !== 'deck' || !deck.count) return;
    const onKey = (e: KeyboardEvent) => {
      if (typingIn(e.target)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goSlide(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goSlide(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
    // The print engine is the PDF pipeline. Why a copy and not the canvas:
    // the canvas frame has an opaque origin (sandboxed, never same-origin), so the
    // host cannot call its contentWindow.print(), and letting the frame print
    // itself would need allow-modals on the frame that runs model HTML
    // interactively. Instead a throwaway frame -- still without same-origin,
    // allowed only to open the print dialog -- prints a copy of the page (its
    // @media print block makes a deck one slide per page) and is removed.
    if (!canvasHtml) return;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-modals');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;';
    frame.srcdoc = `${artifact.strip(canvasHtml)}<script>setTimeout(function(){window.print();},400);</` + 'script>';
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 120000);
  };

  /** Every artboard as SVG: each slide at the stage size, or the page at its full height. */
  const artboardSvgs = () => {
    const html = artifact.strip(canvasHtml);
    // DOMParser builds an inert document: nothing in it runs.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script').forEach((s) => s.remove());
    const css = exportsLib.cssOf(html);
    const pageWidth = viewport === 'deck' ? VIEWPORTS.desktop.width : device.width;
    const boards = exportsLib.artboards(html, stageLib.deckSize(stageFormat), {
      width: pageWidth,
      height: Math.min(16000, pageSize.h && viewport !== 'deck' ? pageSize.h : device.height),
    });
    const slides = Array.from(doc.querySelectorAll('section.slide'));
    const serializer = new XMLSerializer();
    return boards.map((b) => {
      const xhtml = b.index >= 0 && slides[b.index]
        ? serializer.serializeToString(slides[b.index])
        : Array.from(doc.body.childNodes).map((n) => serializer.serializeToString(n)).join('');
      return { ...b, svg: exportsLib.artboardSvg({ css, xhtml, width: b.width, height: b.height }) };
    });
  };

  /** A palette component into the canvas: its CSS once, its markup before </main>, as a new version. */
  const mockFmt = MOCK_FORMATS.find((f) => f.value === mockFormat) || MOCK_FORMATS[0];

  // The preview is the full-size render scaled by CSS, so the exported PNG is
  // exactly what is on screen.
  useEffect(() => {
    if (tab !== 'mockups') return;
    const canvas = mockCanvasRef.current;
    if (canvas) renderMock(canvas, mockSlides[mockIndex] ?? '', mockFmt);
  }, [tab, mockSlides, mockIndex, mockFmt]);

  // Generate: each canvas slide's own copy becomes a mockup slide (the
  // raster side of the studio never rewrites the page).
  const mockFromCanvas = () => {
    if (!canvasHtml) return;
    const texts = exportsLib.slideTexts(artifact.strip(canvasHtml))
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, mockups.LIMITS.slides);
    if (!texts.length) { pushToast('warn', 'No slide copy on the canvas to mock up.'); return; }
    setMockSlides(texts);
    setMockIndex(0);
  };

  const addMockSlide = () => {
    setMockSlides((prev) => (prev.length >= mockups.LIMITS.slides ? prev : [...prev, '']));
    setMockIndex(Math.min(mockSlides.length, mockups.LIMITS.slides - 1));
  };

  const removeMockSlide = () => {
    setMockSlides((prev) => prev.filter((_s, i) => i !== mockIndex));
    setMockIndex((i) => Math.max(0, i - 1));
  };

  const goMockSlide = (delta: number) => {
    setMockIndex((i) => stageLib.clampSlide(i, mockSlides.length, delta));
  };

  // A scratch canvas through the same plan+paint as the preview.
  const mockPngBytes = (text: string): Uint8Array | null => {
    const canvas = document.createElement('canvas');
    renderMock(canvas, text, mockFmt);
    const url = canvas.toDataURL('image/png');
    return base64ToBytes(url.slice(url.indexOf(',') + 1));
  };

  const exportMockPng = async () => {
    if (!mockSlides.length || exporting) return;
    setExporting(true);
    try {
      const data = mockPngBytes(mockSlides[mockIndex] ?? '');
      if (!data) return;
      const slug = active ? slugOf(active.name) : 'mockups';
      pushToast('ok', await saveFile({
        name: `${slug}-mockup-${String(mockIndex + 1).padStart(2, '0')}.png`,
        bytes: data,
        mime: 'image/png',
      }));
    } catch (e) {
      pushToast('error', String((e as Error).message || e));
    } finally {
      setExporting(false);
    }
  };

  const exportMockZip = async () => {
    if (!mockSlides.length || exporting) return;
    setExporting(true);
    try {
      const files: Array<{ name: string; data: Uint8Array }> = [];
      for (let i = 0; i < mockSlides.length; i += 1) {
        const data = mockPngBytes(mockSlides[i]);
        if (data) files.push({ name: `mockup-${String(i + 1).padStart(2, '0')}.png`, data });
      }
      const archive = await zip.writeZip(files);
      const slug = active ? slugOf(active.name) : 'mockups';
      pushToast('ok', await saveFile({ name: `${slug}-mockups.zip`, bytes: archive, mime: 'application/zip' }));
    } catch (e) {
      pushToast('error', String((e as Error).message || e));
    } finally {
      setExporting(false);
    }
  };

  const insertComponent = (id: string) => {
    if (!canvasHtml || !active || draft) return;
    const part = componentsLib.get(id);
    if (!part) return;
    // An in-frame edit waiting to be saved would otherwise land after this and undo it.
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    commit(componentsLib.insertInto(artifact.strip(canvasHtml), id), `Component: ${part.label}`);
    pushToast('ok', `${part.label} added to the page.`);
  };

  const exportAs = async (kind: ExportKind) => {
    if (!canvasHtml || !active || exporting) return;
    setLastExport(kind);
    setExporting(true);
    const slug = slugOf(active.name);
    try {
      if (kind === 'png' || kind === 'svg') {
        const boards = artboardSvgs();
        const files = [];
        for (const b of boards) {
          files.push({ name: `${b.name}.${kind}`, data: kind === 'svg' ? bytes(b.svg) : await svgToPng(b.svg, b.width, b.height) });
        }
        if (files.length === 1) {
          pushToast('ok', await saveFile({ name: `${slug}-${files[0].name}`, bytes: files[0].data, mime: kind === 'svg' ? 'image/svg+xml' : 'image/png' }));
        } else {
          const archive = await zip.writeZip(files.map((f) => ({ name: `${slug}/${f.name}`, data: f.data })));
          pushToast('ok', await saveFile({ name: `${slug}-${kind}.zip`, bytes: archive, mime: 'application/zip' }));
        }
      } else if (kind === 'pptx') {
        // Text and pictures: each slide's data: images are placed where the
        // slide puts them (remote images are skipped -- nothing is fetched).
        const deck = exportsLib.pptxDeck(artifact.strip(canvasHtml), { stage: stageLib.deckSize(stageFormat) });
        if (!deck.slides.length) { pushToast('warn', 'PPTX needs a deck: slides as <section class="slide">.'); return; }
        const deckBytes = await office.writePptx(active.name, deck.slides, { size: deck.size });
        pushToast('ok', await saveFile({ name: `${slug}.pptx`, bytes: deckBytes, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
      } else if (kind === 'react') {
        // Deterministic: the component, its stylesheet and tokens.css, zipped together.
        const out = exportsLib.toReact(artifact.strip(canvasHtml), active.name);
        const archive = await zip.writeZip(out.files.map(([file, text]) => ({ name: `${out.name}/${file}`, data: bytes(text) })));
        pushToast('ok', await saveFile({ name: `${slug}-react.zip`, bytes: archive, mime: 'application/zip' }));
      } else if (kind === 'flutter' || kind === 'swiftui') {
        // No honest string mapping exists, so the current model translates.
        if (!provider || !model) { pushToast('warn', 'Pick a model on the left first: it writes the translation.'); return; }
        const job = (kind === 'flutter' ? exportsLib.toFlutter : exportsLib.toSwiftUI)(artifact.strip(canvasHtml), active.name);
        pushToast('info', `Asking ${model} for the ${kind === 'flutter' ? 'Flutter widget' : 'SwiftUI view'}…`);
        const reply = await collect(job.messages, new AbortController());
        const code = exportsLib.codeFromReply(reply, job.language);
        if (!code.trim()) { pushToast('warn', 'The model replied with no code. Try again, or a larger model.'); return; }
        pushToast('ok', await saveFile({ name: job.fileName, bytes: bytes(code), mime: 'text/plain' }));
      } else {
        const files = exportsLib.projectFiles({
          name: active.name,
          html: artifact.strip(canvasHtml),
          designMd: systemsLib.designMd(system),
          fallbackTokens: systemsLib.tokensCss(system),
          template: active.template,
          systemName: system.name,
          versions: versions.map((v) => ({ label: v.label, html: v.html, ts: v.ts })),
        });
        const archive = await zip.writeZip(files.map(([file, text]) => ({ name: file, data: bytes(text) })));
        pushToast('ok', await saveFile({ name: `${slug}-project.zip`, bytes: archive, mime: 'application/zip' }));
      }
    } catch (e) {
      pushToast('error', String((e as Error).message || e));
    } finally {
      setExporting(false);
    }
  };

  const handoff = async () => {
    if (!canvasHtml || !active) return;
    const slug = slugOf(active.name);
    // tokens.css is what the PAGE declares (tweaks included); the chosen
    // system's tokens are the fallback for a page that declares none.
    const files = exportsLib.handoffFiles({
      name: active.name,
      html: artifact.strip(canvasHtml),
      designMd: systemsLib.designMd(system),
      fallbackTokens: systemsLib.tokensCss(system),
    });
    const folder = (() => { try { return localStorage.getItem('freeai4u.localRoot') || ''; } catch { return ''; } })();
    try {
      if (hasShell() && folder) {
        const dir = `design-handoff/${slug}`;
        for (const [file, text] of files) await writeLocalFile(folder, `${dir}/${file}`, text);
        pushToast('ok', `Handed off to ${dir}/ in the open folder.`);
        // The Code screen picks the request up on mount (as Design does Chat's brief).
        try { sessionStorage.setItem(CODE_HANDOFF_KEY, exportsLib.handoffBrief({ name: active.name, dir })); } catch { /* the files are there anyway */ }
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

  const device = stageLib.device(viewport, stageFormat);
  // Deck mode always fits (letterboxed); the other presets fit on request.
  const scale = fit || viewport === 'deck' ? stageLib.fitScale(box, device) : 1;
  const chrome = device.frame === 'browser' ? stageLib.CHROME_HEIGHT : 0;
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
              options={allTemplates.map((t) => ({ value: t.id, label: t.label, note: `${t.width}×${t.height}${t.unit}` }))}
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
        {isDiagram && active && (
          <details className="mermaid-import">
            <summary>Import a Mermaid flowchart</summary>
            <textarea value={mermaidText} onChange={(e) => setMermaidText(e.target.value)} rows={5} spellCheck={false}
              placeholder={'flowchart LR\n  A[Request] -->|HTTPS| B(API)\n  B -- reads --> C[(Database)]'} aria-label="Mermaid flowchart" />
            <button onClick={importMermaid} disabled={!mermaidText.trim() || working}>Draw it</button>
          </details>
        )}
        {error && <div className="stream-error"><span>{error}</span></div>}
      </aside>

      <main className="studio-centre">
        <div className="design-toolbar">
          <div className="seg" role="group" aria-label="Viewport">
            {(Object.keys(VIEWPORTS) as Viewport[]).map((id) => (
              <button key={id} className={viewport === id ? 'active' : ''} onClick={() => setViewport(id)}
                title={id === 'deck' ? `Deck mode: a ${stageLib.deckSize(stageFormat).width}×${stageLib.deckSize(stageFormat).height} stage, one slide at a time` : `${VIEWPORTS[id].width}×${VIEWPORTS[id].height}${id === 'browser' ? ' in a browser frame' : ''}`}>
                {VIEWPORTS[id].label}
              </button>
            ))}
          </div>
          <button className={fit || viewport === 'deck' ? 'active' : ''} onClick={() => setFit((f) => !f)} disabled={viewport === 'deck'} title="Fit the device to the stage, or show it at 100%">{fit || viewport === 'deck' ? `Fit ${Math.round(scale * 100)}%` : '100%'}</button>
          <div className="seg" role="group" aria-label="Canvas tool">
            {(['view', 'comment', 'edit'] as Tool[]).map((t) => (
              <button key={t} className={tool === t ? 'active' : ''} onClick={() => setTool(t)} disabled={!!draft || !canvasHtml}
                title={t === 'comment' ? 'Click an element to comment on it' : t === 'edit' ? 'Edit text directly on the canvas' : 'Look without changing'}>
                {t === 'view' ? 'View' : t === 'comment' ? 'Comment' : 'Edit'}
              </button>
            ))}
          </div>
          <span className="toolbar-spacer" />
          <button onClick={exportHtml} disabled={!canvasHtml} title="The page as one self-contained HTML file">HTML</button>
          <button onClick={exportPdf} disabled={!canvasHtml} title="Print the page (a deck prints one slide per page)">PDF</button>
          <SelectPill
            label="Export"
            title="Export pictures, slides or the whole project"
            value={lastExport}
            disabled={!canvasHtml || exporting}
            options={EXPORTS.map((x) => ({ value: x.value, label: x.label, note: x.note }))}
            onPick={(k) => exportAs(k as ExportKind)}
          />
          <button onClick={handoff} disabled={!canvasHtml} title="The page, tokens.css, DESIGN.md and an implementation README, into the open folder and on to Code (or a ZIP)">Handoff to Code</button>
        </div>

        {draft && (
          <div className="approval-card draft-bar">
            <div className="approval-title">
              Draft — anti-slop score {draft.score}/100
              {draft.findings.length ? ` · ${draft.findings.length} finding(s)` : ' · clean'}
              {critiqueBusy && ' · critiquing…'}
              {critique && !critiqueBusy && ` · critique ${critique.average}/10`}
            </div>
            {/* The deterministic gate first, before any choice is offered. */}
            {draft.findings.slice(0, 3).map((f) => (
              <div key={f.id} className="slop-finding"><strong>{f.label}</strong>{f.detail ? ` (${f.detail})` : ''} — {f.why} <em>Fix: {f.fix}</em></div>
            ))}
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
            <div className="approval-actions">
              <button className="primary" onClick={applyDraft}>Apply to canvas</button>
              <button onClick={() => setBrief(`More like the ${variant?.label || 'current'} direction: `)}>More like this</button>
              <button className="danger" onClick={() => setDraft(null)}>Discard</button>
            </div>
          </div>
        )}

        <div className={`studio-stage ${viewport === 'deck' ? 'is-deck' : ''}`} ref={stageRef}>
          {frameDoc ? (
            <div className={`device device-${viewport} frame-${device.frame}`} style={{ width: device.width * scale, height: device.outerHeight * scale }}>
              <div className="device-inner" style={{ width: device.width, height: device.outerHeight, transform: scale === 1 ? undefined : `scale(${scale})` }}>
                {chrome > 0 && (
                  <div className="browser-chrome" style={{ height: chrome }} aria-hidden="true">
                    <span className="browser-dots"><i /><i /><i /></span>
                    <span className="browser-address">{slugOf(active?.name || 'design')}.local</span>
                  </div>
                )}
                <iframe
                  ref={iframeRef}
                  title="Design canvas"
                  sandbox="allow-scripts"
                  className={`design-frame tool-${draft ? 'view' : tool}`}
                  srcDoc={frameDoc}
                  style={{ width: device.width, height: device.height, top: chrome }}
                />
              </div>
            </div>
          ) : (
            <div className="canvas-placeholder">
              {working ? 'Designing…' : active ? 'Nothing on the canvas yet — describe it on the left.' : 'Open or create a project.'}
            </div>
          )}
        </div>
        {viewport === 'deck' && frameDoc && (
          <div className="deck-nav" role="group" aria-label="Slides">
            <button onClick={() => goSlide(-1)} disabled={!deck.count || deck.index === 0} aria-label="Previous slide"><Icon name="chevron-right" size={14} className="flip-x" /></button>
            <span className="deck-counter mono" aria-live="polite">{deck.count ? stageLib.counter(deck.index, deck.count) : 'No <section class="slide"> on this page'}</span>
            <button onClick={() => goSlide(1)} disabled={!deck.count || deck.index >= deck.count - 1} aria-label="Next slide"><Icon name="chevron-right" size={14} /></button>
          </div>
        )}
      </main>

      <aside className="studio-right">
        <div className="inspector-tabs" role="tablist" aria-label="Inspector">
          {(['tweaks', 'tokens', 'components', 'mockups', 'comments', 'checks', 'history'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'comments' && pins.length ? `Comments ${pins.length}` : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="inspector-body">
          {tab === 'tweaks' && tweakSchema && (
            <div className="tweaks page-tweaks">
              <h4>This page's controls</h4>
              {draft && <p className="settings-hint">Apply or discard the draft to use them.</p>}
              {tweakSchema.controls.map((c) => {
                const value = schemaValues[c.var] ?? String(c.default);
                return (
                  <div key={c.var} className="tweak">
                    <span>{c.label} <span className="mono tweak-var">{c.var}</span></span>
                    {c.type === 'color' && (
                      <input type="color" value={value} disabled={!!draft} aria-label={c.label} onChange={(e) => setSchemaTweak(c.var, e.target.value)} />
                    )}
                    {c.type === 'slider' && (
                      <input type="range" min={c.min} max={c.max} step={c.step} value={parseFloat(value)} disabled={!!draft} aria-label={c.label}
                        onChange={(e) => setSchemaTweak(c.var, `${e.target.value}${c.unit || ''}`)} />
                    )}
                    {c.type === 'toggle' && (
                      <button role="switch" aria-checked={value === c.on} aria-label={c.label} disabled={!!draft} className={`tweak-toggle ${value === c.on ? 'on' : ''}`}
                        onClick={() => setSchemaTweak(c.var, value === c.on ? String(c.off) : String(c.on))}>
                        {value === c.on ? 'On' : 'Off'}
                      </button>
                    )}
                    {c.type === 'select' && (
                      <span className="question-options" role="radiogroup" aria-label={c.label}>
                        {(c.options || []).map((o) => (
                          <button key={o.value} role="radio" aria-checked={value === o.value} disabled={!!draft} className={value === o.value ? 'is-picked' : ''}
                            onClick={() => setSchemaTweak(c.var, o.value)}>{o.label}</button>
                        ))}
                      </span>
                    )}
                    {c.type !== 'select' && c.type !== 'toggle' && <span className="tweak-value mono">{value}</span>}
                  </div>
                );
              })}
              <button onClick={resetSchemaTweaks} disabled={!!draft}>Back to the page's defaults</button>
              <p className="settings-hint">Saved in the page itself, so every version and export keeps them.</p>
            </div>
          )}
          {tab === 'tweaks' && (
            vars.length ? (
              <div className="tweaks">
                {tweakSchema && <h4>Page tokens</h4>}
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

          {tab === 'mockups' && (
            <div className="mockups-tab">
              <p className="settings-hint">
                Carousel mockups from the viralai generator: a deterministic slide card (accent bar,
                measured wrap, one accent per slide) rendered at full size and exported as PNG.
                Edit the copy and it re-renders.
              </p>
              {!mockSlides.length ? (
                <div className="empty">Generate from the canvas deck, or add a slide and type its copy.</div>
              ) : (
                <>
                  <div className="mockup-actions">
                    <button onClick={() => goMockSlide(-1)} disabled={mockIndex === 0} aria-label="Previous mockup slide"><Icon name="chevron-right" size={14} className="flip-x" /></button>
                    <span className="deck-counter mono" aria-live="polite">{stageLib.counter(mockIndex, mockSlides.length)}</span>
                    <button onClick={() => goMockSlide(1)} disabled={mockIndex >= mockSlides.length - 1} aria-label="Next mockup slide"><Icon name="chevron-right" size={14} /></button>
                    <button className="linkish" onClick={removeMockSlide}>Remove</button>
                  </div>
                  <textarea
                    rows={4}
                    value={mockSlides[mockIndex] ?? ''}
                    placeholder="What this slide says"
                    aria-label={`Mockup slide ${mockIndex + 1} copy`}
                    onChange={(e) => setMockSlides((prev) => prev.map((s, i) => (i === mockIndex ? e.target.value : s)))}
                  />
                </>
              )}
              <div className="mockup-actions">
                <button onClick={mockFromCanvas} disabled={!canvasHtml} title="Take each slide's copy from the canvas deck">Generate from canvas</button>
                <button onClick={addMockSlide} disabled={mockSlides.length >= mockups.LIMITS.slides}>Add slide</button>
              </div>
              <SelectPill
                label="Card"
                title="Mockup card size — the platform formats from the social templates"
                value={mockFormat}
                options={MOCK_FORMATS.map(({ value, label, note }) => ({ value, label, note }))}
                onPick={(v) => setMockFormat(v)}
              />
              <canvas ref={mockCanvasRef} className="mockup-preview" aria-label="Mockup preview" />
              <div className="mockup-actions">
                <button className="primary" onClick={exportMockPng} disabled={!mockSlides.length || exporting}>Export PNG</button>
                <button onClick={exportMockZip} disabled={!mockSlides.length || exporting}>Export all (ZIP)</button>
              </div>
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
                {/* The deterministic gate: free, instant, the same every time -- always first. */}
                <div className="checks-score">{checks.score}<span>/100</span></div>
                {!checks.findings.length && <div className="empty">Clean: nothing the anti-slop gate flags.</div>}
                {checks.findings.map((f) => (
                  <div key={f.id} className="slop-finding"><strong>{f.label}</strong>{f.detail ? ` (${f.detail})` : ''} — {f.why} <em>Fix: {f.fix}</em></div>
                ))}
                <div className="critique">
                  <h4>Critique</h4>
                  <label className="critique-auto" title="Off by default for models on this PC: a critique is a second model call">
                    <input type="checkbox" checked={critiqueOn} onChange={(e) => setCritiqueOn(e.target.checked)} />
                    <span>After every draft</span>
                  </label>
                  <button onClick={() => runCritique(draft ? draft.html : canvasHtml, draft ? draft.findings : checks.findings)} disabled={critiqueBusy || !model || working}>
                    {critiqueBusy ? 'Critiquing…' : 'Critique'}
                  </button>
                  {critiqueBusy && <button className="linkish" onClick={() => critiqueAbort.current?.abort()}>Stop</button>}
                  {critique && (
                    <div className="critique-result">
                      <CritiqueRadar scores={critique.scores} />
                      <div className="critique-average">{critique.average}<span>/10 average, from {model}</span></div>
                      {([['Keep', critique.keep], ['Fix', critique.fix], ['Quick wins', critique.quickWins]] as Array<[string, string[]]>).map(([title, items]) => (
                        items.length ? (
                          <div key={title} className="critique-list">
                            <strong>{title}</strong>
                            <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
                          </div>
                        ) : null
                      ))}
                    </div>
                  )}
                  {!critique && !critiqueBusy && <p className="settings-hint">A model's view of hierarchy, typography, colour, spacing and originality, scored 1–10. The checks above come first and cost nothing.</p>}
                </div>
              </div>
            ) : <div className="empty">Checks run on the canvas once there is a page.</div>
          )}

          {tab === 'components' && (
            <div className="components-tab">
              <p className="settings-hint">
                Built from the page's own tokens (var(--accent), var(--space)…), so they follow the system and Tweaks.
                Click one to add it at the end of the page, as a new version.
              </p>
              {!canvasHtml && <div className="empty">Components can be added once there is a page.</div>}
              <div className="component-palette">
                {componentsLib.COMPONENTS.map((c) => (
                  <button key={c.id} className="component-tile" onClick={() => insertComponent(c.id)}
                    disabled={!canvasHtml || !!draft} title={draft ? 'Apply or discard the draft first' : `Add ${c.label.toLowerCase()} to the page`}>
                    <span className="component-name">{c.label}</span>
                    <span className="component-note">{c.note}</span>
                  </button>
                ))}
              </div>
            </div>
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
