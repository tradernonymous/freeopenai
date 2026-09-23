import { useState, useRef, useEffect, useCallback, lazy, Suspense, type ComponentType } from 'react';
import { api, imageUrlFrom, streamChat, streamLocalChat, type StreamFrame } from '../api';
import { byokStream, hasShell, listLocalDir, localModelStatus, mcpStdioList, notifyUser, openUrl, readLocalFile } from '../bridge';
import { renderMarkdown } from '../markdown';
import { renderMermaid } from '../diagram';
import { localSetup, startRecording, transcribeAuto, type Recording } from '../dictate';
import { captureScreen, imageFileToDataUrl, imagesIn, withImages, MAX_IMAGES } from '../attach-image';
import Icon from '../components/Icon';
import ModelPicker from '../components/ModelPicker';
import Composer from '../components/Composer';
import { NAVIGATE_EVENT } from '../Sidebar';
// UMD modules: loaded for their side effect, read off globalThis.
import RadialMenu, { type RadialItem } from '../components/RadialMenu';
import { pushToast } from '../components/Toasts';
import ToolCards from '../components/ToolCards';
// Eager on purpose: Settings (ConnectorsCard) imports it too, so a lazy import
// here would not move it out of the first bundle.
import HfSignIn from '../components/HfSignIn';
import { modelTargets } from '../stream-any';
import { GITHUB_CHANGED_EVENT } from '../components/ConnectorsCard';
import { runTurn, type ToolEvent, type TurnOptions } from '../agent-turn';
import { executeTool, startStdio, stdioId } from '../tool-run';
import '../tools.js';
import '../approval.js';
import '../composer.js';
import '../agents.js';
import '../recipes.js';
import { isSavedProvider, streamSaved } from '../run-model';
import '../saved-models.js';
import '../byok.js';
import '../chats.js';
import '../failure.js';
import '../fallback.js';
import '../local-models.js';
import '../hf-auth.js';
import '../hf-inference.js';
import '../threads.js';
import '../research.js';
import '../images.js';
import '../puter.js';
import '../image-run.js';
// The shell's command bridge, for this PC's image server (sd_find, sd_cancel).
import { call } from '../bridge';
import { saveFile } from '../files/save';

const chats: typeof import('../chats.js') = (globalThis as any).FreeAI4UChats;
// /image, /edit, /redo: the Images screen's rules (images.js) and its runner
// (image-run.js) -- the same calls, so a picture drawn here is the one the
// Images screen would have drawn.
const imagesLib: typeof import('../images.js') = (globalThis as any).FreeAI4UImages;
const puter: typeof import('../puter.js') = (globalThis as any).FreeAI4UPuter;
const imageRun: typeof import('../image-run.js') = (globalThis as any).FreeAI4UImageRun;
type ImagePlan = import('../image-run.js').ImagePlan;
type PictureTarget = import('../composer.js').PictureTarget;
// Who pays is said once per service per run of the app, before its first
// picture -- not on every picture, which would be noise nobody reads.
const costSaid = new Set<string>();
// /research: the pure parts (plan, sources, citations, graph, export).
const research: typeof import('../research.js') = (globalThis as any).FreeAI4UResearch;
type ResearchSource = import('../research.js').ResearchSource;
type ResearchGraph = import('../research.js').ResearchGraph;
// The graph layout is only needed once someone asks for a graph, so it loads then.
let diagramLoad: Promise<typeof import('../design/diagram-layout.js')> | null = null;
const loadDiagram = () => {
  if (!diagramLoad) diagramLoad = import('../design/diagram-layout.js').then(() => (globalThis as any).FreeAI4UDiagramLayout);
  return diagramLoad;
};
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const failure: typeof import('../failure.js') = (globalThis as any).FreeAI4UFailure;
const fallback: typeof import('../fallback.js') = (globalThis as any).FreeAI4UFallback;
const localModels: typeof import('../local-models.js') = (globalThis as any).FreeAI4ULocalModels;
const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;
const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;
// NEURA-054: the endpoints the user brought a key for. This screen only ever
// holds their base URL and model id -- the key is in the OS credential store
// and is read by the shell, so nothing below ever has one to pass on.
const byok: typeof import('../byok.js') = (globalThis as any).FreeAI4UByok;
const toolsLib: typeof import('../tools.js') = (globalThis as any).FreeAI4UTools;
const approval: typeof import('../approval.js') = (globalThis as any).FreeAI4UApproval;
const grammar: typeof import('../composer.js') = (globalThis as any).FreeAI4UComposer;
// ---- lazy parts (NEURA-035: a smaller first bundle, same behaviour) ----
//
// The attachment readers (zip, then office and pdf, which read FreeZip as they
// load) are fetched the first time a document is attached. `office` and `pdf`
// keep their shape: a call before the load waits for it; afterwards (e.g.
// office.sheetToText after extractXlsxSheets) it is the module's own function.
let fileReadersLoad: Promise<unknown> | null = null;
const loadFileReaders = () => {
  if (!fileReadersLoad) {
    fileReadersLoad = import('../files/zip.js')
      .then(() => Promise.all([import('../files/office.js'), import('../files/pdf.js')]))
      .catch((e) => { fileReadersLoad = null; throw e; });
  }
  return fileReadersLoad;
};
function lazyUmd<T extends object>(global: string): T {
  return new Proxy({} as T, {
    get: (_target, key) => {
      const loaded = (globalThis as any)[global];
      if (loaded) return loaded[key];
      return async (...args: unknown[]) => {
        await loadFileReaders();
        return (globalThis as any)[global][key](...args);
      };
    },
  });
}
const office = lazyUmd<typeof import('../files/office.js')>('FreeOffice');
const pdf = lazyUmd<typeof import('../files/pdf.js')>('FreePdf');

// Parts not needed for the first paint: their own chunks, fetched right after
// it. Both drawers render nothing while closed, so they look exactly as
// before once their chunk is in (a few ms after the first paint).
function afterPaint<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  const Lazy = lazy(load) as unknown as ComponentType<P>;
  return function AfterPaint(props: P) {
    return <Suspense fallback={null}><Lazy {...props} /></Suspense>;
  };
}
const RunSettings = afterPaint(() => import('../components/RunSettings'));
const CompareDrawer = afterPaint(() => import('../components/CompareDrawer'));

const threads: typeof import('../threads.js') = (globalThis as any).FreeAI4UThreads;
const agentsLib: typeof import('../agents.js') = (globalThis as any).FreeAI4UAgents;
const recipesLib: typeof import('../recipes.js') = (globalThis as any).FreeAI4URecipes;

type Agent = import('../agents.js').Agent;
type Recipe = import('../recipes.js').Recipe;
type McpServer = import('../tools.js').McpServer;
type ModeId = import('../composer.js').ModeId;
type SlashCommand = import('../composer.js').SlashCommand;
type MentionSource = import('../composer.js').MentionSource;

/** The folder open in the app (App.tsx keeps it here), for the local tools. */
function openFolder(): string {
  try { return localStorage.getItem('freeai4u.localRoot') || ''; } catch { return ''; }
}
const hfInference: typeof import('../hf-inference.js') = (globalThis as any).FreeAI4UHfInference;

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  /** The provider the turn was asked of, and the words for it. */
  provider?: string;
  providerLabel?: string;
  ts?: number;
  error?: boolean;
  /** Why it failed, classified: what was asked, the provider's words, advice. */
  failure?: import('../failure.js').Attribution;
  /** What the model did during this reply: tool calls, their state, their results. */
  tools?: ToolEvent[];
  /** Shown in the thread, never sent: /help, and `!` command output (which
   *  rides the next message instead, so turns keep alternating). */
  note?: boolean;
  shell?: string;
  /** Pictures sent with a user turn, as data URLs (vision models only). */
  images?: string[];
  /** The agent (or recipe) that wrote this reply, for its label. */
  agent?: string;
  /** /research: the numbered sources this reply cites as [n]. */
  sources?: ResearchSource[];
  /** /research: what was asked and when, what the citation check found, and the graph once drawn. */
  research?: { question: string; date: number; noSources?: boolean; uncited?: number; graph?: ResearchGraph };
  /** /image or /edit: what was asked of which service, so /redo can ask again. */
  picture?: PictureRun;
}

/**
 * A drawn reply's recipe. The source of an edit is a pointer into the thread
 * ([message, picture]) rather than a second copy of its bytes: a copy here
 * would dodge the picture-trimming saveSessions does for browser storage and
 * could push a whole chat over the quota.
 */
export interface PictureRun {
  kind: 'generate' | 'edit';
  prompt: string;
  choice: string;
  model: string;
  size: string;
  who?: string;
  sourceAt?: [number, number];
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Msg[];
  provider: string;
  model: string;
  mode: 'chat' | 'plan' | 'build';
  /** /reasoning: sent as reasoning_effort to providers that take it. */
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  draft: string;
  updatedAt: number;
}

// The chat store lives in ../chats.js -- key, cap, validation, merge, export.
// This screen reads and writes it and owns nothing about it, so the History
// panel and the Library see exactly the same history this screen does.
const MAX_SESSIONS = chats.MAX_SESSIONS;

function loadSessions(): ChatSession[] {
  return chats.readStore() as ChatSession[];
}

// A write that hits the browser's storage quota drops the oldest chats to
// fit (src/chats.js). That is a loss the user should hear about once, not a
// history that quietly shrinks.
let warnedQuota = false;
// Pictures are data URLs, hundreds of KB each: in localStorage the saved copy
// keeps them only on a chat's last few messages, or four screenshots would
// evict whole chats. The shell's SQLite store (chats.persistent()) has no such
// quota, so there every picture is kept.
const KEEP_IMAGES_LAST = 6;
function saveSessions(sessions: ChatSession[]) {
  const slim = chats.persistent() ? sessions : sessions.map((s) => (s.messages.some((m) => m.images) ? {
    ...s,
    messages: s.messages.map((m, i) => (m.images && i < s.messages.length - KEEP_IMAGES_LAST ? { ...m, images: undefined } : m)),
  } : s));
  const report = chats.writeStoreReport(null, slim);
  // The thread sidebar redraws from the store; tell it the store moved.
  window.dispatchEvent(new Event(threads.CHANGED_EVENT));
  if (report.quota && !warnedQuota) {
    warnedQuota = true;
    pushToast('warn', report.ok
      ? `Storage is full: ${report.dropped} oldest chat(s) were dropped. Export your chats to keep them.`
      : 'Storage is full and this chat could not be saved. Export your chats, then delete some.');
  }
}

export function newSession(provider = '', model = ''): ChatSession {
  return {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title: 'New chat',
    messages: [],
    provider,
    model,
    mode: 'chat',
    draft: '',
    updatedAt: Date.now(),
  };
}

/** Chat listens for this event so History can open a session from anywhere. */
export const OPEN_CHAT_EVENT = 'freeai4u:open-chat';
// The command palette's "New chat" arrives the same way History's "open a
// session" does -- as an event -- so the shell never has to know how a chat is
// created.
export const NEW_CHAT_EVENT = 'freeai4u:new-chat';
/** Ctrl+M: open the model chip. */
export const MODEL_PICK_EVENT = 'freeai4u:pick-model';
/** Ctrl+T: open or fold every tool card. */
export const TOOL_CARDS_EVENT = 'freeai4u:tool-cards';
/** A brief for the Design studio, handed over through sessionStorage. */
export const DESIGN_BRIEF_KEY = 'freeai4u.designBrief';
/** A slash command for Chat to run once it is on screen (Agents / Recipes "Run in chat"). */
export const PENDING_COMMAND_KEY = 'freeai4u.pendingCommand';
export const RUN_COMMAND_EVENT = 'freeai4u:run-command';

/** The turns a model is shown: notes are for the person, shell output rides along. */
export function turnsFor(messages: Msg[]): Array<{ role: string; content: any }> {
  const out: Array<{ role: string; content: any }> = [];
  let pending = '';
  for (const m of messages) {
    if (m.note) {
      if (m.shell) pending += `${m.shell}\n\n`;
      continue;
    }
    if (m.role === 'user' && pending) {
      out.push({ role: 'user', content: withImages(`Command output from the open folder:\n${pending}---\n${m.content}`, m.images) });
      pending = '';
    } else {
      // A model's shown reasoning is not part of what it said.
      out.push({ role: m.role, content: m.role === 'assistant' ? String(m.content || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim() : withImages(m.content, m.images) });
    }
  }
  return out;
}

const HELP = [
  '**The composer**',
  '',
  '- **Tab / Shift+Tab** — Chat → Plan → Build. **!** at the start runs a command in the open folder. Backspace at the start or **Esc** leaves a mode.',
  '- **/** — commands: ' + grammar.SLASH.map((c) => '`/' + c.id + '`').join(' '),
  '- **@** — switch model, attach a file from the open folder, point at an MCP server.',
  '- **Up** in an empty box brings back the last message. **Ctrl+N** new chat, **Ctrl+M** model, **Ctrl+T** tool cards, **Ctrl+K** everything else.',
  '- Workflow: `/interview` → `/plan` → `/implement` → `/review` — each reply offers the next step.',
  '- Pictures: `/image` draws with the Images service, model and shape; `/edit` changes the picture attached here or the latest one; `/redo` asks again with a new seed. **@picture** attaches the latest picture. Hover a picture to edit it, open it in Images, or save it.',
].join('\n');

interface ProviderRow {
  id: string;
  label: string;
  configured: boolean;
  kind?: string;
  freeTier?: any;
  /** Only on the local row: where llama.cpp is listening, and on what. */
  baseUrl?: string;
  model?: string;
  local?: boolean;
  /** The --api-key the shell started llama-server with. */
  apiKey?: string;
}

export default function ChatScreen() {
  // Parsed once. The active id is taken from the list this component already
  // loaded; the old code read and parsed localStorage a second time here.
  const [sessions, setSessions] = useState<ChatSession[]>(() => chats.readStore() as ChatSession[]);
  const [activeId, setActiveId] = useState<string>(() => sessions[0]?.id ?? '');
  const [providerRows, setProviderRows] = useState<ProviderRow[]>([]);
  // The model running on this machine, when there is one. It is a provider row
  // like any other, so the picker needed no new concept -- but it is served by
  // llama.cpp here, not by the engine, and the turn goes straight to it.
  const [localRow, setLocalRow] = useState<ProviderRow | null>(null);
  const [models, setModels] = useState<Array<{ id: string; free?: string }>>([]);
  // The picker's list: the engine's providers plus a local model if one is up.
  const [hfToken, setHfToken] = useState<string | null>(() => hfAuth.accessToken()?.access_token || null);
  // The token lives in the OS credential store under the shell and is read
  // asynchronously at boot (hf-auth.js hydrate); this hears it arrive.
  useEffect(() => {
    const onAuth = () => setHfToken(hfAuth.accessToken()?.access_token || null);
    window.addEventListener(hfAuth.AUTH_CHANGED_EVENT, onAuth);
    return () => window.removeEventListener(hfAuth.AUTH_CHANGED_EVENT, onAuth);
  }, []);
  // "My models": Ollama Local and Unsloth Local, holding what was added in
  // Settings -> Local models. They lead the list: they are the person's own.
  const [savedRows, setSavedRows] = useState<ProviderRow[]>(() => savedModels.providerRows());
  const [savedTick, setSavedTick] = useState(0);
  useEffect(() => {
    const onSaved = () => { setSavedRows(savedModels.providerRows()); setSavedTick((n) => n + 1); };
    window.addEventListener(savedModels.CHANGED_EVENT, onSaved);
    return () => window.removeEventListener(savedModels.CHANGED_EVENT, onSaved);
  }, []);
  const [runOpen, setRunOpen] = useState(false);
  // Shell and Design are where ONE message goes, not what the chat is: they
  // live here, not on the session, and fall back to its mode after a send.
  const [transient, setTransient] = useState<'shell' | 'design' | null>(null);
  // The workflow step just taken (/interview, /plan, ...), so the reply can
  // offer the next one.
  const [flow, setFlow] = useState<string | null>(null);
  const [cardsOpen, setCardsOpen] = useState<boolean | undefined>(undefined);
  const [skillRows, setSkillRows] = useState<SlashCommand[]>([]);
  const [folderFiles, setFolderFiles] = useState<string[]>([]);
  const [compare, setCompare] = useState<{ open: boolean; prompt: string }>({ open: false, prompt: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api.skills()
      .then((rows: any) => setSkillRows((Array.isArray(rows) ? rows : []).slice(0, 40).map((row: any) => grammar.skillRow(row))))
      .catch(() => setSkillRows([]));
    const onCards = () => setCardsOpen((open) => !open);
    const onPick = () => (document.querySelector('.composer .model-pill') as HTMLButtonElement | null)?.click();
    window.addEventListener(TOOL_CARDS_EVENT, onCards);
    window.addEventListener(MODEL_PICK_EVENT, onPick);
    return () => {
      window.removeEventListener(TOOL_CARDS_EVENT, onCards);
      window.removeEventListener(MODEL_PICK_EVENT, onPick);
    };
  }, []);
  // Tools: on unless switched off in Settings -> Connectors; GitHub's are
  // offered only while an account is connected.
  const [toolsOn, setToolsOn] = useState(() => toolsLib.enabled());
  const [githubConnected, setGithubConnected] = useState(false);
  useEffect(() => {
    const onTools = () => setToolsOn(toolsLib.enabled());
    const readGithub = () => {
      api.raw('/api/github/status')
        .then((data: any) => setGithubConnected(Array.isArray(data?.accounts) && data.accounts.length > 0))
        .catch(() => setGithubConnected(false));
    };
    readGithub();
    window.addEventListener(toolsLib.CHANGED_EVENT, onTools);
    window.addEventListener(GITHUB_CHANGED_EVENT, readGithub);
    return () => {
      window.removeEventListener(toolsLib.CHANGED_EVENT, onTools);
      window.removeEventListener(GITHUB_CHANGED_EVENT, readGithub);
    };
  }, []);
  // An Allow / Deny card is a promise the turn is waiting on.
  const approvals = useRef<Record<string, (allow: boolean) => void>>({});
  const decide = (id: string, allow: boolean, always: boolean) => {
    const resolve = approvals.current[id];
    if (!resolve) return;
    delete approvals.current[id];
    if (allow && always) {
      const event = active?.messages[active.messages.length - 1]?.tools?.find((t) => t.id === id);
      if (event) toolsLib.setAlways(event.name);
    }
    resolve(allow);
  };
  const hfRow = hfInference.providerRow(hfToken);
  const choices = [
    ...savedRows,
    ...(localRow && !providerRows.some((p) => p.id === 'local') ? [localRow] : []),
    ...(hfRow && !providerRows.some((p) => p.id === 'hf') ? [hfRow] : []),
    ...providerRows,
  ];
  const [sending, setSending] = useState(false);
  // The sidebar's spinner follows the chat that STARTED the reply, even if the
  // person switches to another chat while it streams.
  const busyChat = useRef<string | null>(null);
  const [attached, setAttached] = useState<string>('');
  const [images, setImages] = useState<string[]>([]);
  // The picture a picture's Edit button pointed at, for the /edit that follows.
  const [pinnedPicture, setPinnedPicture] = useState<{ url: string; index: number; slot: number } | null>(null);
  // Which picture's actions are showing (message:picture), by hover or focus.
  const [pictureHover, setPictureHover] = useState('');
  const [dictation, setDictation] = useState<'idle' | 'recording' | 'working'>('idle');
  const recording = useRef<Recording | null>(null);
  // Right-click on a reply opens the actions for what is under the pointer.
  const [radial, setRadial] = useState<{ x: number; y: number; items: RadialItem[] } | null>(null);
  // A switch the app may take on its own (the local model, when a remote one
  // rate-limits). It rides a ref because the next render is the one that has
  // the failed turn written; the decision is made in the catch, taken after.
  const autoFallback = useRef<import('../fallback.js').FallbackAttempt | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stickToBottom = useRef(true);

  const active = sessions.find((s) => s.id === activeId) || sessions[0] || null;

  // A session id can outlive its session (pruned on save, or displaced by an
  // import), which left the screen on a fallback chat while activeId pointed at
  // a ghost -- so History or "open chat" could resurrect an empty screen. Keep
  // the id and the list in agreement.
  useEffect(() => {
    if (!sessions.length) return;
    if (!sessions.some((s) => s.id === activeId)) setActiveId(sessions[0].id);
  }, [sessions, activeId]);

  // An import rewritten localStorage: reload what is on screen.
  useEffect(() => {
    const onChanged = () => setSessions(chats.readStore() as ChatSession[]);
    window.addEventListener(chats.CHATS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(chats.CHATS_CHANGED_EVENT, onChanged);
  }, []);

  const persist = useCallback((next: ChatSession[]) => {
    setSessions(next);
    saveSessions(next);
  }, []);

  const patchSession = useCallback((id: string, patch: Partial<ChatSession>) => {
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s));
      saveSessions(next);
      return next;
    });
  }, []);

  // ---- load engine catalogue ------------------------------------------------
  useEffect(() => {
    api.providers()
      .then((rows: any) => {
        const chat = (Array.isArray(rows) ? rows : []).filter((p: any) => p.kind !== 'image' && p.configured);
        setProviderRows(chat);
        setSessions((prev) => {
          // A saved chat pointing at a provider that is gone falls back to the
          // first one -- and the fallback is written back, so a restart does
          // not bring the dead provider id along.
          const ids = new Set(chat.map((p: any) => p.id));
          const next = prev.map((s) => (!s.provider || !ids.has(s.provider) ? { ...s, provider: chat[0]?.id || '' } : s));
          saveSessions(next);
          return next;
        });
      })
      .catch(() => setProviderRows([]));
  }, []);

  // A local model comes and goes while the app is open, so the row is polled
  // rather than read once. It is one localhost call; when nothing is running
  // the shell answers immediately without touching a socket.
  useEffect(() => {
    if (!hasShell()) return;
    const read = () => {
      localModelStatus()
        .then((status) => setLocalRow((current) => {
          const row = localModels.providerRow(status);
          // The label carries the model name, so a change of model is a change
          // of row -- and a session sitting on the old one has to move.
          if (current && !row) return null;
          return row as ProviderRow | null;
        }))
        .catch(() => setLocalRow(null));
    };
    read();
    const timer = setInterval(read, 15000);
    return () => clearInterval(timer);
  }, []);

  // models follow the provider
  useEffect(() => {
    if (!active?.provider) {
      setModels([]);
      return;
    }
    // One of "my models": the list is what was added, nothing to ask anybody.
    if (isSavedProvider(active.provider)) {
      const mine = savedModels.modelsFor(active.provider);
      setModels(mine);
      setSessions((prev) => {
        const next = prev.map((s) =>
          s.id === active.id && !mine.some((m) => m.id === s.model) ? { ...s, model: mine[0]?.id || '' } : s);
        saveSessions(next);
        return next;
      });
      return;
    }
    // The user's own endpoints: the list is what they added, and asking the
    // engine for the models of a provider it has never heard of would only
    // empty the picker.
    if (active.provider === byok.PROVIDER_ID) {
      const own = byok.modelsFor(active.provider);
      setModels(own);
      setSessions((prev) => {
        const next = prev.map((s) =>
          s.id === active.id && !own.some((m) => m.id === s.model) ? { ...s, model: own[0]?.id || '' } : s);
        saveSessions(next);
        return next;
      });
      return;
    }
    // HF: the curated list at once, then what the router serves right now.
    if (active.provider === 'hf') {
      setModels(hfInference.models(hfToken));
      let stale = false;
      hfInference.fetchModels(hfToken).then((live) => { if (!stale && live.length) setModels(live); });
      return () => { stale = true; };
    }
    // A local server serves exactly the model it was started with, so its list
    // is that one model -- asked of the shell, not of the engine.
    if (active.provider === 'local') {
      const repo = localRow?.model || '';
      setModels(repo ? [{ id: repo, free: 'local · no limits, no network' }] : []);
      setSessions((prev) => {
        const next = prev.map((s) => (s.id === active.id && !repo ? { ...s, model: '' } : s));
        saveSessions(next);
        return next;
      });
      return;
    }
    let gone = false;
    api.models(active.provider)
      .then((rows: any) => {
        if (gone) return;
        const list = (Array.isArray(rows) ? rows : [])
          .map((r: any) => ({ id: String(r.id || r), free: r && r.freeTier ? r.freeTier.limitText || '' : '' }));
        setModels(list);
        setSessions((prev) => {
          const next = prev.map((s) =>
            s.id === active.id && !list.some((m) => m.id === s.model) ? { ...s, model: list[0]?.id || '' } : s);
          saveSessions(next);
          return next;
        });
      })
      .catch(() => { if (!gone) setModels([]); });
    return () => { gone = true; };
  }, [active?.provider, active?.id, savedTick]);

  // open a session from History
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent).detail;
      if (typeof id === 'string' && id) setActiveId(id);
    };
    window.addEventListener(OPEN_CHAT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, onOpen);
  }, []);

  const startNewRef = useRef<() => void>(() => {});

  const scrollToBottom = useCallback((smooth = true) => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => {
    if (stickToBottom.current) scrollToBottom(false);
  }, [active?.messages.length, active?.id, scrollToBottom]);

  // Files/Design hand staged text here through sessionStorage + this event;
  // it rides the next send as a fenced quote the model can read.
  useEffect(() => {
    const onAttach = () => {
      try {
        const pending = sessionStorage.getItem('freeai4u.pendingAttachment');
        if (!pending) return;
        sessionStorage.removeItem('freeai4u.pendingAttachment');
        setAttached(pending);
      } catch { /* private mode: the chip just won't appear */ }
    };
    window.addEventListener('freeai4u-attach', onAttach);
    onAttach();
    return () => window.removeEventListener('freeai4u-attach', onAttach);
  }, []);

  const startNew = () => {
    const s = newSession(providerRows[0]?.id || '', '');
    persist([s, ...sessions].slice(0, MAX_SESSIONS));
    setActiveId(s.id);
    inputRef.current?.focus();
  };

  // The listener is registered once, so it reads the current startNew through a
  // ref rather than re-subscribing on every render.
  startNewRef.current = startNew;
  useEffect(() => {
    const onNew = () => startNewRef.current();
    window.addEventListener(NEW_CHAT_EVENT, onNew);
    return () => window.removeEventListener(NEW_CHAT_EVENT, onNew);
  }, []);

  // One request to a provider, in the shape runTurn calls again after every
  // round of tool results. Chat, agents and recipes all stream through it,
  // with this chat's /reasoning setting.
  const streamer = (provider: string, model: string): TurnOptions['stream'] => (messages, offered, onFrame, signal) => {
    if (provider === 'hf') {
      return hfInference.streamChat(model, messages, onFrame, signal, hfToken || undefined, offered);
    }
    if (isSavedProvider(provider)) {
      return streamSaved(provider, model, messages, onFrame, signal, (stage) => { if (stage) pushToast('info', stage); }, offered, active.reasoning);
    }
    // The user's own endpoint. The session remembers the model id only, so the
    // entry is looked up per turn; when it has been deleted the lookup is null
    // and byok.streamChat refuses in words, rather than this falling through to
    // an engine that would answer with a model nobody asked for. `byokStream`
    // carries the secret's NAME, never a key. `offered` rides as `tools`, the
    // same OpenAI shape the other branches send.
    if (provider === byok.PROVIDER_ID) {
      return byok.streamChat(byok.findByModel(provider, model), messages, onFrame, signal, { byokStream }, offered);
    }
    const effort = active.reasoning && active.reasoning !== 'off' ? { reasoning_effort: active.reasoning } : {};
    if (provider === 'local') {
      return streamLocalChat(localRow?.baseUrl || '', model, messages, onFrame, signal, localRow?.apiKey || undefined, { ...(offered ? { tools: offered } : {}), ...effort });
    }
    return streamChat(provider, { model, messages, ...(offered ? { tools: offered } : {}), ...effort } as any, onFrame, signal);
  };

  // A tool card on the last reply of chat `sid`: added, or updated in place.
  const upsertToolIn = (sid: string) => (event: ToolEvent) => {
    setSessions((prev) => prev.map((s) => {
      if (s.id !== sid) return s;
      const msgs = s.messages.slice();
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') return s;
      const list = (last.tools || []).slice();
      const at = list.findIndex((t) => t.id === event.id);
      // Stamped here, for the elapsed timer on the card.
      const was = at >= 0 ? list[at] : null;
      const stamped: ToolEvent = {
        ...event,
        startedAt: was?.startedAt || Date.now(),
        endedAt: event.status === 'running' || event.status === 'asking' ? undefined : (was?.endedAt || Date.now()),
      };
      if (at >= 0) list[at] = stamped; else list.push(stamped);
      msgs[msgs.length - 1] = { ...last, tools: list };
      return { ...s, messages: msgs, updatedAt: Date.now() };
    }));
    if (stickToBottom.current) scrollToBottom(false);
  };

  // Stopping the turn is a Deny for whatever was waiting.
  const askApproval = (signal: AbortSignal) => (event: ToolEvent) => new Promise<boolean>((resolve) => {
    approvals.current[event.id] = resolve;
    notifyUser('NeuraOS needs your OK', event.summary || event.name);
    signal.addEventListener('abort', () => { delete approvals.current[event.id]; resolve(false); }, { once: true });
  });

  // ---- agents (roadmap 6.7) ---------------------------------------------------
  //
  // A sub-turn is the same runTurn with the agent's system prompt, ONLY its
  // tools, and its model (or this chat's). Its tool cards land on the reply
  // being written, labelled with the agent, and ask exactly as chat's do.

  /** spawn_agent, described with the agents this spawner may start; [] when there are none. */
  const spawnDefFor = (spawner: Agent | null): import('../tools.js').ToolDef[] => {
    const all = agentsLib.list();
    const ids = agentsLib.spawnTargets(spawner, all);
    const targets = all.filter((a) => ids.includes(a.id));
    if (!targets.length) return [];
    return [{ ...toolsLib.SPAWN_AGENT, function: { ...toolsLib.SPAWN_AGENT.function, description: agentsLib.spawnDescription(targets) } }];
  };

  interface AgentRun { sid: string; signal: AbortSignal; history: Msg[]; depth: number; onText?: (piece: string) => void }

  const runAgent = async (agent: Agent, task: string, run: AgentRun): Promise<{ text: string; ok: boolean }> => {
    const target = agent.model || { provider: active.provider, model: active.model };
    const root = openFolder();
    const canSpawn = run.depth < agentsLib.MAX_DEPTH;
    const offered = toolsOn ? agentsLib.pickTools(agent, toolsLib.catalogue({ github: githubConnected, localRoot: root, shell: hasShell() })) : [];
    if (toolsOn && canSpawn && agent.spawnableAgents?.length) offered.push(...spawnDefFor(agent));
    // Tool-call ids repeat across providers; the prefix keeps each card its own.
    const prefix = `${agent.id}-${Math.random().toString(36).slice(2, 6)}:`;
    const upsert = upsertToolIn(run.sid);
    const ask = askApproval(run.signal);
    // 'last_message' is the final round's words: text before a tool call is
    // the agent thinking aloud, not its answer.
    let last = '';
    await runTurn({
      messages: agentsLib.messagesFor(agent, task, agent.includeMessageHistory ? turnsFor(run.history) : []),
      tools: offered,
      stream: streamer(target.provider, target.model),
      execute: (call, args) => executeTool(call, args, {
        localRoot: root,
        spawnAgent: canSpawn ? (a) => spawnFrom(agent, a, { ...run, depth: run.depth + 1, onText: undefined }) : undefined,
      }),
      approve: (event) => ask({ ...event, id: prefix + event.id }),
      onText: (piece) => { last += piece; run.onText?.(piece); },
      onTool: (event) => { last = ''; upsert({ ...event, id: prefix + event.id, summary: `${agent.name}: ${event.summary}` }); },
      onNote: (note) => pushToast('info', `${agent.name}: ${note}`),
      signal: run.signal,
    });
    return agentsLib.formatResult(agent, last);
  };

  /** What spawn_agent does: check the agent may be started here, run it, hand its answer back. */
  const spawnFrom = async (spawner: Agent | null, args: Record<string, any>, run: AgentRun): Promise<string> => {
    const all = agentsLib.list();
    const id = String(args.agent || '').trim().toLowerCase();
    const allowed = agentsLib.spawnTargets(spawner, all);
    const agent = all.find((a) => a.id === id);
    if (!agent || !allowed.includes(id)) return `Error: "${id}" is not an agent that may be spawned here. Available: ${allowed.join(', ') || 'none'}.`;
    try {
      return (await runAgent(agent, String(args.task || ''), run)).text;
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      return `Error: ${agent.name} failed: ${((err as Error).message || String(err)).split('\n')[0]}`;
    }
  };

  /** /agent and /recipe: the request and the agent's answer, as two turns of this chat. */
  const runAgentInChat = async (agent: Agent, task: string, shown: string) => {
    if (!active || sending) return;
    const sid = active.id;
    const history = active.messages;
    const target = agent.model || { provider: active.provider, model: active.model };
    const label = choices.find((c) => c.id === target.provider)?.label || target.provider;
    patchSession(sid, {
      messages: [
        ...history,
        { role: 'user', content: shown, ts: Date.now() },
        { role: 'assistant', content: '', agent: agent.name, model: target.model, provider: target.provider, providerLabel: label, ts: Date.now() },
      ],
      draft: '',
      title: history.length === 0 ? threads.autoTitle(shown) : active.title,
    });
    setSending(true);
    stickToBottom.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const patchLast = (patch: (last: Msg) => Partial<Msg>) => setSessions((prev) => prev.map((s) => {
      if (s.id !== sid) return s;
      const msgs = s.messages.slice();
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') msgs[msgs.length - 1] = { ...last, ...patch(last) };
      return { ...s, messages: msgs, updatedAt: Date.now() };
    }));
    try {
      const result = await runAgent(agent, task, {
        sid, signal: controller.signal, history, depth: 1,
        onText: (piece) => { patchLast((last) => ({ content: last.content + piece })); if (stickToBottom.current) scrollToBottom(false); },
      });
      patchLast(() => ({ content: result.text }));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const told = failure.attribute({ provider: target.provider, providerLabel: label, model: target.model, message: (err as Error).message });
        patchLast(() => ({ error: true, failure: told }));
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      setTimeout(() => setSessions((prev) => { saveSessions(prev); return prev; }), 0);
    }
  };

  // ---- recipes (roadmap 6.8) ----------------------------------------------------
  //
  // The first time a recipe would use an MCP server, the person says yes in an
  // in-app dialog -- a local server is a program started on this PC -- and the
  // answer is kept per recipe and server (recipes.js).
  const [consent, setConsent] = useState<{ recipe: Recipe; servers: McpServer[]; resolve: (ok: boolean) => void } | null>(null);

  const runRecipeInChat = async (recipe: Recipe, values: Record<string, string>) => {
    const filled = recipesLib.fillTemplate(recipe.prompt, recipe.params, values);
    if (filled.missing.length) {
      pushToast('warn', `${recipe.name} needs ${filled.missing.join(', ')}: /recipe ${recipe.id} ${filled.missing[0]}=…`);
      return;
    }
    const servers = toolsLib.mcpServers();
    const find = (name: string) => servers.find((s) => toolsLib.slug(s.name) === toolsLib.slug(name));
    const absent = recipe.extensions.filter((name) => !find(name));
    if (absent.length) {
      pushToast('warn', `${recipe.name} needs the MCP server${absent.length > 1 ? 's' : ''} ${absent.join(', ')}. Add ${absent.length > 1 ? 'them' : 'it'} in Settings → Connectors.`);
      return;
    }
    const pending = recipesLib.needsConsent(recipe);
    if (pending.length) {
      const ok = await new Promise<boolean>((resolve) => setConsent({ recipe, servers: pending.map((n) => find(n)!), resolve }));
      setConsent(null);
      if (!ok) { pushToast('info', `${recipe.name} was not run.`); return; }
      recipesLib.grantConsent(recipe.id, pending);
    }
    // Local servers it needs that are not running yet are started now, so
    // their tools are known before the turn is offered them.
    if (hasShell()) {
      const up = await mcpStdioList().catch(() => [] as string[]);
      for (const name of recipe.extensions) {
        const server = find(name);
        if (!server || !toolsLib.isStdio(server) || up.includes(stdioId(server))) continue;
        try {
          await startStdio(server);
        } catch (e) {
          pushToast('error', `${server.name} did not start: ${toolsLib.splitStderr((e as Error).message || String(e)).message.split('\n')[0]}`);
          return;
        }
      }
    }
    await runAgentInChat(recipesLib.asAgent(recipe), filled.text, filled.text);
  };

  // ---- research (/research) ---------------------------------------------------
  //
  // Plan -> search -> read -> write, through the SAME web_search / web_fetch
  // tools the model can call (executeTool; both are read-only, so neither is
  // in tools.ASKS and neither asks). The thread gets the question, a progress
  // note that is never sent, and the reply with its numbered sources on it.
  // No search (no provider, offline, an older engine): the model answers
  // alone, labelled as having no sources -- never with invented citations.

  /** One model call on this chat's streamer, collected; `onText` sees it as it streams. */
  const askModel = async (provider: string, model: string, messages: Array<{ role: string; content: string }>, signal?: AbortSignal, onText?: (piece: string) => void) => {
    let out = '';
    await streamer(provider, model)(messages, undefined, (frame) => {
      if (!frame.content) return;
      out += frame.content;
      onText?.(frame.content);
    }, signal);
    return out;
  };

  const patchMsgAt = (sid: string, index: number, patch: (m: Msg) => Partial<Msg>) => setSessions((prev) => prev.map((s) => {
    if (s.id !== sid || !s.messages[index]) return s;
    const msgs = s.messages.slice();
    msgs[index] = { ...msgs[index], ...patch(msgs[index]) };
    return { ...s, messages: msgs, updatedAt: Date.now() };
  }));

  const runResearch = async (question: string, base?: Msg[]) => {
    if (!active || sending) return;
    if (!question) {
      addNote('**Research** — `/research <question>`: plans searches, reads the top pages, and answers with numbered citations. Under the reply: a knowledge graph, and Markdown or PDF export.');
      return;
    }
    if (!active.model) { pushToast('warn', 'Pick a model first (Ctrl+M).'); return; }
    const sid = active.id;
    const { provider, model } = active;
    const label = choices.find((c) => c.id === provider)?.label || provider;
    const date = Date.now();
    const history = base || active.messages;
    const noteAt = history.length + 1;
    const replyAt = history.length + 2;
    patchSession(sid, {
      messages: [
        ...history,
        { role: 'user', content: question, ts: date },
        { role: 'assistant', content: research.progressText('plan'), note: true, model: 'NeuraOS', ts: date },
        { role: 'assistant', content: '', model, provider, providerLabel: label, ts: date, sources: [], research: { question, date } },
      ],
      draft: '',
      title: history.length === 0 ? threads.autoTitle(question) : active.title,
    });
    setSending(true);
    stickToBottom.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;
    const aborted = (err: unknown) => (err as Error)?.name === 'AbortError' || signal.aborted;
    const note = (content: string) => patchMsgAt(sid, noteAt, () => ({ content }));
    const upsert = upsertToolIn(sid);
    // A search card is the same card a model's own web_search makes.
    const runTool = async (id: string, name: 'web_search' | 'web_fetch', args: Record<string, string>) => {
      const event: ToolEvent = { id, name, args, summary: toolsLib.summarise(name, args), asks: '', status: 'running' };
      upsert(event);
      try {
        const out = await executeTool({ id, name, arguments: JSON.stringify(args) }, args, { localRoot: '' });
        const failed = /^\s*Error:/.test(out);
        upsert({ ...event, status: failed ? 'error' : 'done', result: toolsLib.clip(out) });
        return { out: failed ? '' : out, error: failed ? out.replace(/^\s*Error:\s*/, '') : '' };
      } catch (err) {
        if (aborted(err)) throw err;
        const message = ((err as Error).message || String(err)).split('\n')[0];
        upsert({ ...event, status: 'error', result: `Error: ${message}` });
        return { out: '', error: message };
      }
    };
    try {
      // 1. Plan. A model that cannot plan still gets the question searched as asked.
      let queries: string[];
      try {
        queries = research.parseQueries(await askModel(provider, model, research.planMessages(question, date), signal), question);
      } catch (err) {
        if (aborted(err)) throw err;
        queries = [question];
      }
      // 2. Search, all queries at once; sources deduped by URL and numbered.
      note(research.progressText('search', { queries: queries.length }));
      const found = await Promise.all(queries.map(async (query, k) => {
        const got = await runTool(`research-search-${k}`, 'web_search', { query });
        return { rows: research.parseSearchResults(got.out).slice(0, research.RESULTS_PER_QUERY), error: got.error };
      }));
      let sources: ResearchSource[] = [];
      found.forEach((f, k) => { sources = research.addSources(sources, f.rows, k); });
      let turns;
      if (sources.length) {
        // 3. Read the top pages, capped per page and in total.
        const pages = research.pickPages(sources);
        note(research.progressText('read', { queries: queries.length, sources: sources.length, pages: pages.length }));
        patchMsgAt(sid, replyAt, () => ({ sources }));
        const texts: Record<number, string> = {};
        await Promise.all(pages.map(async (src) => {
          const got = await runTool(`research-read-${src.n}`, 'web_fetch', { url: src.url });
          const page = research.clipPage(got.out);
          if (page) texts[src.n] = page;
        }));
        note(research.progressText('write', { queries: queries.length, sources: sources.length, pages: pages.length }));
        turns = research.synthesisMessages(question, sources, texts, date);
      } else {
        // NEURA-041: search is unavailable or found nothing -- say so, and answer without sources.
        const why = found.map((f) => f.error).find(Boolean) || 'no results for any query';
        note(`**Research** · Web search is unavailable (${why.slice(0, 160)}). This answer is from the model alone, with no sources.`);
        pushToast('warn', 'Web search is unavailable — answering from the model alone, without sources.');
        patchMsgAt(sid, replyAt, (m) => ({ research: { ...m.research!, noSources: true } }));
        turns = research.noSourcesMessages(question, date);
      }
      // 4. Write, streamed into the reply.
      const answer = await askModel(provider, model, turns, signal, (piece) => {
        patchMsgAt(sid, replyAt, (m) => ({ content: m.content + piece }));
        if (stickToBottom.current) scrollToBottom(false);
      });
      // Citations to sources that do not exist are removed; uncited paragraphs are counted.
      const check = research.checkCitations(answer, sources.length);
      patchMsgAt(sid, replyAt, (m) => ({ content: check.text, research: { ...m.research!, uncited: sources.length ? check.uncited.length : 0 } }));
      if (sources.length) {
        const pagesRead = research.pickPages(sources).length;
        note(`${research.progressText('done', { queries: queries.length, sources: sources.length, pages: pagesRead })}${check.unknown.length ? ` · removed citations to missing sources ${check.unknown.map((n) => `[${n}]`).join(' ')}` : ''}`);
      }
    } catch (err) {
      if (aborted(err)) {
        note('**Research** · Stopped.');
      } else {
        const told = failure.attribute({ provider, providerLabel: label, model, message: (err as Error).message });
        patchMsgAt(sid, replyAt, () => ({ error: true, failure: told }));
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      setTimeout(() => setSessions((prev) => { saveSessions(prev); return prev; }), 0);
    }
  };

  /** A failed research reply runs again from its question, not as a plain chat turn. */
  const rerunResearch = (index: number) => {
    const msg = active?.messages[index];
    if (!active || !msg?.research) return;
    let u = index - 1;
    while (u >= 0 && active.messages[u].role !== 'user') u -= 1;
    runResearch(msg.research.question, active.messages.slice(0, Math.max(0, u)));
  };

  const [graphBusy, setGraphBusy] = useState<number | null>(null);
  // Only the graph's JSON is kept on the message; the SVG is drawn from it on
  // screen, so a chat file brought in from elsewhere cannot carry markup.
  const [diagramLib, setDiagramLib] = useState<typeof import('../design/diagram-layout.js') | null>(null);
  const needsDiagram = !!active?.messages.some((m) => m.research?.graph);
  useEffect(() => {
    if (needsDiagram && !diagramLib) loadDiagram().then((lib) => setDiagramLib(lib), () => {});
  }, [needsDiagram, diagramLib]);
  const graphSvg = (graph: ResearchGraph, title: string, onScreen: boolean, lib = diagramLib) => {
    if (!lib) return '';
    try {
      const clean = lib.normalize(graph);
      if (!clean.nodes.length) return '';
      // On screen the app's own tokens, so it follows the theme; on paper the defaults.
      return lib.toSvg(clean, onScreen
        ? { title, paper: 'var(--bg-2)', ink: 'var(--text-1)', muted: 'var(--text-3)', line: 'var(--border)', accent: 'var(--accent)' }
        : { title });
    } catch {
      return '';
    }
  };
  const knowledgeGraph = async (index: number) => {
    const msg = active?.messages[index];
    if (!active || !msg?.research || graphBusy !== null) return;
    const sid = active.id;
    setGraphBusy(index);
    try {
      const reply = await askModel(msg.provider || active.provider, msg.model || active.model, research.graphMessages(msg.research.question, msg.content));
      const graph = research.parseGraph(reply);
      if (!graph.nodes.length) { pushToast('warn', graph.message); return; }
      if (graph.message) pushToast('info', graph.message);
      setDiagramLib(await loadDiagram());
      setSessions((prev) => {
        const next = prev.map((s) => {
          if (s.id !== sid || !s.messages[index]?.research) return s;
          const msgs = s.messages.slice();
          msgs[index] = { ...msgs[index], research: { ...msgs[index].research!, graph } };
          return { ...s, messages: msgs, updatedAt: Date.now() };
        });
        saveSessions(next);
        return next;
      });
    } catch (err) {
      pushToast('error', `Knowledge graph: ${((err as Error).message || String(err)).split('\n')[0]}`);
    } finally {
      setGraphBusy(null);
    }
  };

  const researchSlug = (msg: Msg) => (msg.research?.question || 'research').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'research';

  const exportResearchMarkdown = (msg: Msg) => {
    if (!msg.research) return;
    const md = research.exportMarkdown({ question: msg.research.question, answer: msg.content, sources: msg.sources || [], date: msg.research.date, model: msg.model });
    saveFile({ name: `${researchSlug(msg)}.md`, bytes: new TextEncoder().encode(md), mime: 'text/markdown' })
      .then((said) => pushToast('ok', said || 'Saved.'))
      .catch((e: unknown) => pushToast('error', ((e as Error).message || String(e)).split('\n')[0]));
  };

  // PDF: there is no PDF writer in the app (files/pdf.js only reads), so the
  // WebView2 print engine is the PDF pipeline, as in Design: a clean page is
  // printed from a throwaway frame (no same-origin, allowed only to open the
  // print dialog) and "Microsoft Print to PDF" / "Save as PDF" writes the file.
  const exportResearchPdf = async (msg: Msg) => {
    if (!msg.research) return;
    const sources = msg.sources || [];
    const bodyHtml = research.superscriptCitations(renderMarkdown(research.linkCitations(msg.content, sources)));
    let paperGraph = '';
    if (msg.research.graph) {
      try { paperGraph = graphSvg(msg.research.graph, 'Knowledge graph', false, await loadDiagram()); } catch { paperGraph = ''; }
    }
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-modals');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;';
    frame.srcdoc = research.printHtml({ question: msg.research.question, bodyHtml, sources, date: msg.research.date, model: msg.model, graphSvg: paperGraph, autoPrint: true });
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 120000);
    pushToast('info', 'In the print dialog, choose “Microsoft Print to PDF” (or Save as PDF).');
  };

  // ---- pictures (/image, /edit, /redo) ----------------------------------------
  //
  // The request is built by the same pure functions the Images screen uses
  // (image-run.drawPlan, images.editRequest) from the choice that screen keeps,
  // and carried out by the same runner (image-run.runImage). Building it sends
  // nothing: a refusal becomes a note and the thread gets no turn. A picture
  // leaves this machine only when the person has run the command.
  //
  // The reply is an ordinary message with the picture in `images`, so it is
  // saved with the chat like any attachment -- including the trimming
  // saveSessions applies in browser storage.

  /** The services Images offers, read fresh: the engine's report plus this PC. */
  const imageRows = async () => {
    const facts = hasShell() ? await call<any>('sd_find').catch(() => null) : null;
    const report = await api.imageProviders().catch(() => null);
    return imagesLib.withLocal(imagesLib.providerChoices(report || {}), facts);
  };

  /** A note from the app that is not a turn; the draft is left for the person to fix. */
  const pictureNote = (content: string) => {
    if (!active) return;
    patchSession(active.id, { messages: [...active.messages, { role: 'assistant', content, note: true, model: 'NeuraOS', ts: Date.now() }] });
  };

  /** Where a picture already sits in the thread, so an edit can point at it instead of copying it. */
  const pictureAt = (messages: Msg[], url: string): [number, number] | undefined => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const j = (messages[i].images || []).lastIndexOf(url);
      if (j >= 0) return [i, j];
    }
    return undefined;
  };

  /**
   * Draw or change a picture in the thread. `typed` is what the person ran (it
   * becomes their turn); `again` is the recipe of a reply being redone.
   */
  const runPicture = async (kind: 'generate' | 'edit', words: string, typed: string, target?: PictureTarget | null, again?: PictureRun) => {
    if (!active || sending) return;
    const sid = active.id;
    const history = active.messages;
    const kept = imageRun.readChoice();
    const rows = await imageRows();
    const choice = imagesLib.chosen(again ? again.choice : kept.choiceId, rows);
    const size = again?.size
      || (imagesLib.SIZE_PRESETS.some((p) => p.id === kept.size) ? kept.size : imagesLib.SIZE_PRESETS[0].id);
    const model = again ? again.model : imageRun.modelFor(choice, kind, kept);
    const sourceUrl = target?.url || '';

    let plan: ImagePlan;
    if (kind === 'edit') {
      // The shape of the source, so a change on this PC keeps it. A picture
      // this window cannot open is left to editRequest to refuse in words.
      const dims = sourceUrl ? await imageRun.measurePicture(sourceUrl).catch(() => null) : null;
      plan = imagesLib.editRequest(choice, {
        prompt: words,
        source: sourceUrl,
        size,
        model,
        sourceWidth: dims?.width,
        sourceHeight: dims?.height,
      });
    } else {
      plan = imageRun.drawPlan(choice, { prompt: words, size, model });
    }
    if (again) plan = imageRun.withSeed(plan);
    if (!plan.route || !choice) {
      pictureNote(`**Nothing was sent.** ${plan.error || 'No image service is available.'}`);
      return;
    }

    // The person's turn. A picture attached to it rides on it, unless it is
    // one already in the thread (@picture), which is pointed at, not copied.
    const ts = Date.now();
    const own = target?.from === 'attached' ? images : [];
    const fresh = own.filter((url) => !pictureAt(history, url));
    const cost = imageRun.costNote(choice);
    const sayCost = !!cost && !costSaid.has(choice.id);
    if (sayCost) costSaid.add(choice.id);
    const lead: Msg[] = sayCost ? [{ role: 'assistant', content: cost, note: true, model: 'NeuraOS', ts }] : [];
    const userMsg: Msg = { role: 'user', content: typed, ...(fresh.length ? { images: fresh } : {}), ts };
    const userAt = history.length + lead.length;
    const replyAt = userAt + 1;
    let sourceAt: [number, number] | undefined;
    if (kind === 'edit') {
      sourceAt = pictureAt(history, sourceUrl);
      if (!sourceAt && fresh.includes(sourceUrl)) sourceAt = [userAt, fresh.indexOf(sourceUrl)];
    }
    const recipe: PictureRun = {
      kind,
      prompt: plan.body.prompt,
      choice: choice.id,
      model: plan.model,
      size,
      ...(sourceAt ? { sourceAt } : {}),
    };
    const reply: Msg = {
      role: 'assistant',
      content: kind === 'edit' ? `${grammar.targetLabel(target || null)}…` : 'Drawing…',
      providerLabel: choice.label,
      model: plan.model || choice.model || choice.label,
      ts,
      picture: recipe,
    };
    patchSession(sid, {
      messages: [...history, ...lead, userMsg, reply],
      draft: '',
      title: history.length === 0 ? threads.autoTitle(words) : active.title,
    });
    if (own.length) setImages([]);
    setPinnedPicture(null);
    setSending(true);
    stickToBottom.current = true;

    // Stop cancels a job on this PC (sd_cancel). A request already with a
    // service or Puter cannot be taken back; its picture still lands.
    const controller = new AbortController();
    abortRef.current = controller;
    let jobId = '';
    controller.signal.addEventListener('abort', () => {
      if (jobId) call('sd_cancel', { id: jobId }).catch(() => undefined);
    });
    const settle = (patch: Partial<Msg>) => setSessions((prev) => {
      const next = prev.map((s) => {
        if (s.id !== sid || !s.messages[replyAt]) return s;
        const msgs = s.messages.slice();
        msgs[replyAt] = { ...msgs[replyAt], ...patch };
        return { ...s, messages: msgs, updatedAt: Date.now() };
      });
      saveSessions(next);
      return next;
    });
    try {
      const done = await imageRun.runImage(kind, choice, plan, {
        api,
        imageUrlFrom,
        puter,
        call,
        stopped: () => controller.signal.aborted,
        onJob: (job) => {
          if (job?.id) jobId = job.id;
          if (job) patchMsgAt(sid, replyAt, () => ({ content: `${job.label}…` }));
        },
      });
      if (!done) {
        settle({ content: 'Stopped. No picture was made.', picture: undefined });
        return;
      }
      const said = kind === 'edit' ? `Changed the picture: ${recipe.prompt}` : `Drew: ${recipe.prompt}`;
      settle({
        content: done.notes.length ? `${said}

_${done.notes.join(' · ')}_` : said,
        images: [done.url],
        model: done.who || reply.model,
        providerLabel: undefined,
        picture: { ...recipe, who: done.who },
      });
    } catch (err) {
      const told = imageRun.failureView(kind, plan.route, choice, err);
      settle({
        content: '',
        error: true,
        failure: {
          kind: 'image',
          label: 'Failed',
          asked: `${choice.label}${plan.model ? ` · ${plan.model}` : ''}`,
          summary: told.summary,
          upstream: told.upstream,
          advice: told.walk ? `${told.walk} ${told.advice}` : told.advice,
          retryable: true,
        },
      });
    } finally {
      setSending(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  /** /redo, or a failed picture's Try again: the same recipe, a new seed. */
  const redoPicture = (recipe?: PictureRun) => {
    if (!active) return;
    const last = recipe ? { picture: recipe } : grammar.lastPictureRun(active.messages);
    if (!last) {
      pictureNote('Nothing to redo yet. Draw a picture with `/image`, or change one with `/edit`, first.');
      return;
    }
    const run = last.picture as PictureRun;
    if (run.kind === 'generate') { runPicture('generate', run.prompt, '/redo', null, run); return; }
    const [at, slot] = run.sourceAt || [-1, -1];
    const url = active.messages[at]?.images?.[slot] || '';
    if (!url) {
      // Browser storage keeps pictures only on a chat's last few messages; the
      // source may have been one of the ones it let go.
      pictureNote('The picture that edit started from is no longer in this chat, so it cannot be changed again. Attach it and run `/edit`.');
      return;
    }
    runPicture('edit', run.prompt, '/redo', { url, from: 'picked', index: at, slot }, run);
  };

  /** What /edit will change right now, for the chip above the composer and the run. */
  const editTarget = () => (active
    ? grammar.pictureTarget({ attached: images, pinned: pinnedPicture, messages: active.messages })
    : null);

  /** Hover action: Open in Images, with this picture as the source of a change. */
  const openInImages = (url: string) => {
    imageRun.handOff(url, (event) => {
      window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { view: 'images' } }));
      window.dispatchEvent(new Event(event));
    });
  };

  /** Hover action: Edit -- the composer gets `/edit ` and this picture is the target. */
  const editPicture = (url: string, index: number, slot: number) => {
    if (!active) return;
    setPinnedPicture({ url, index, slot });
    patchSession(active.id, { draft: '/edit ' });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const send = async () => {
    if (!active || sending) return;
    const text = (active.draft || '').trim();
    if (!text) return;
    if (transient === 'shell') {
      await runShell(text);
      return;
    }
    if (transient === 'design') {
      sendToDesign(text);
      patchSession(active.id, { draft: '' });
      setTransient(null);
      return;
    }
    // The send button, not only Enter, runs a picture command: typed out in
    // full, `/image a cat` is a command whichever way it is sent.
    const pictureCommand = grammar.parseSlash(text);
    if (pictureCommand && ['image', 'edit', 'redo'].includes(pictureCommand.command.id)) {
      onCommand(pictureCommand.command, pictureCommand.arg);
      return;
    }
    if (active.mode === 'build') {
      await startBuild(text);
      return;
    }
    const userMsg: Msg = {
      role: 'user',
      content: attached ? `${text}\n\n--- attached ---\n${attached}` : text,
      ...(images.length ? { images } : {}),
      ts: Date.now(),
    };
    if (attached) setAttached('');
    if (images.length) setImages([]);
    // The turn records the provider AND the model it was asked of, so the label
    // above a failure names what was asked -- never whichever provider happened
    // to answer the error, which is what made an error look unrelated to the
    // model on screen.
    const asked = {
      provider: active.provider,
      providerLabel: providerRows.find((p) => p.id === active.provider)?.label || active.provider,
      model: active.model,
    };
    const assistantMsg: Msg = { role: 'assistant', content: '', ...asked, ts: Date.now() };
    const history = [...active.messages, userMsg];
    patchSession(active.id, {
      messages: [...history, assistantMsg],
      draft: '',
      title: active.messages.length === 0 ? threads.autoTitle(text) : active.title,
    });
    setSending(true);
    stickToBottom.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    const sid = active.id;
    const startedAt = Date.now();
    const append = (piece: string) => {
      setSessions((prev) => {
        const next = prev.map((s) => {
          if (s.id !== sid) return s;
          const msgs = s.messages.slice();
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant') msgs[msgs.length - 1] = { ...last, content: last.content + piece };
          return { ...s, messages: msgs, updatedAt: Date.now() };
        });
        return next;
      });
      if (stickToBottom.current) scrollToBottom(false);
    };

    try {
      const turns = turnsFor(history);
      if (active.mode === 'plan') {
        turns.unshift({
          role: 'system',
          content: 'Plan mode: reply with a short numbered plan (files, steps, risks) and change nothing. Read-only tools are available for looking around.',
        });
      }
      // One request, to whichever provider the session is on. The turn calls
      // it again after every round of tool results.
      const streamOnce = streamer(active.provider, active.model);
      const upsertTool = upsertToolIn(sid);
      const root = openFolder();
      await runTurn({
        messages: turns,
        tools: toolsOn
          // The composer's Search / Code / MCP chips decide which groups are
          // on offer this turn. Filtering here rather than in the composer is
          // the point: a chip that only remembered itself would be a claim the
          // turn never honoured.
          ? approval.offered(
            toolsLib.catalogue({ github: githubConnected, localRoot: root, shell: hasShell() }),
            approval.readGroups(),
          )
            // Plan changes nothing, so it is offered nothing that could.
            .filter((t) => active.mode !== 'plan' || (!toolsLib.ASKS[t.function.name] && !t.function.name.startsWith('mcp__')))
            // Delegation too: a sub-agent can have tools that change things.
            .concat(active.mode !== 'plan' ? spawnDefFor(null) : [])
          : [],
        stream: streamOnce,
        execute: (call, args) => executeTool(call, args, {
          localRoot: root,
          spawnAgent: (a) => spawnFrom(null, a, { sid, signal: controller.signal, history, depth: 1 }),
        }),
        approve: askApproval(controller.signal),
        onText: append,
        onTool: upsertTool,
        onNote: (note) => pushToast('info', note),
        signal: controller.signal,
      });
      // persist the finished transcript
      setSessions((prev) => { saveSessions(prev); return prev; });
      // A reply that took a while, finished while the window was elsewhere.
      if (Date.now() - startedAt > 15000) notifyUser('Reply ready', `${asked.model || 'The model'} answered: ${text.slice(0, 80)}`);
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      const told = failure.attribute({ ...asked, message: aborted ? '' : (err as Error).message });
      setSessions((prev) => prev.map((s) => {
        if (s.id !== sid) return s;
        const msgs = s.messages.slice();
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') {
          msgs[msgs.length - 1] = aborted
            ? { ...last, error: false }
            : { ...last, error: true, failure: told };
          // A stopped turn with nothing in it is not a turn.
          if (aborted && !last.content) msgs.pop();
        }
        return { ...s, messages: msgs, updatedAt: Date.now() };
      }));
      // One place, not two: the failure card in this turn is the whole report.
      // The bottom bar that repeated it in shorthand is gone.
      //
      // The one switch the app may take without asking: a rate-limited remote
      // turn answered by the local model. It is the same request to a private
      // server, so there is nothing to consent to -- and it is the difference
      // between a wall and a reply. Every other switch stays a button.
      if (!aborted) {
        const switchPlan = fallback.plan({
          failure: told,
          provider: asked.provider,
          model: asked.model,
          next: failure.nextModel(asked.model, models),
          local: localRow ? { baseUrl: localRow.baseUrl, model: localRow.model, ready: true } : null,
        });
        if (switchPlan.automatic && switchPlan.attempts.length) {
          autoFallback.current = switchPlan.attempts[0];
          if (switchPlan.note) pushToast('info', switchPlan.note);
        }
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      // one authoritative save with the final state
      setTimeout(() => setSessions((prev) => { saveSessions(prev); return prev; }), 0);
      inputRef.current?.focus();
      // Taken after the failed turn is on screen, and with the transcript it
      // was built from: `active` here is the render that started this send, so
      // it cannot be the source of the next attempt's messages.
      const switchTo = autoFallback.current;
      autoFallback.current = null;
      if (switchTo) {
        const turns = [...history];
        setTimeout(() => { retry(switchTo.model, switchTo.provider, turns); }, 0);
      }
    }
  };

  const stop = () => abortRef.current?.abort();

  // `modelOverride` is how "try another model" works without waiting for a
  // render: the failed turn is re-sent to the next model in the same list the
  // picker shows, and the session follows it. `providerOverride` is the same
  // move across providers -- it is what lets a rate-limited turn be answered by
  // the local server instead.
  const retry = async (modelOverride?: string, providerOverride?: string, messagesOverride?: Msg[]) => {
    if (!active) return;
    // The click path must not race an in-flight turn; the automatic path is
    // started by that turn ending and passes its own transcript in.
    if (!messagesOverride && sending) return;
    const model = modelOverride || active.model;
    const provider = providerOverride || active.provider;
    if (providerOverride && modelOverride && (model !== active.model || provider !== active.provider)) {
      patchSession(active.id, { model, provider });
    } else if (modelOverride && modelOverride !== active.model) {
      patchSession(active.id, { model });
    }
    const msgs = (messagesOverride || active.messages).slice();
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
    const lastUser = msgs[msgs.length - 1];
    if (!lastUser || lastUser.role !== 'user') return;
    patchSession(active.id, { messages: msgs });
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const sid = active.id;
    const asked = {
      provider,
      providerLabel: providerRows.find((p) => p.id === provider)?.label || provider,
      model,
    };
    setSessions((prev) => prev.map((s) => (s.id === sid
      ? { ...s, messages: [...msgs, { role: 'assistant', content: '', ...asked, ts: Date.now() }], updatedAt: Date.now() }
      : s)));
    const append = (piece: string) => {
      setSessions((prev) => prev.map((s) => {
        if (s.id !== sid) return s;
        const m = s.messages.slice();
        const last = m[m.length - 1];
        if (last && last.role === 'assistant') m[m.length - 1] = { ...last, content: last.content + piece };
        return { ...s, messages: m, updatedAt: Date.now() };
      }));
      if (stickToBottom.current) scrollToBottom(false);
    };
    try {
      const turns = turnsFor(msgs);
      if (provider === 'hf') {
        await hfInference.streamChat(model, turns, (frame) => {
          if (frame.content) append(frame.content);
        }, controller.signal, hfToken || undefined);
      } else if (isSavedProvider(provider)) {
        await streamSaved(provider, model, turns, (frame) => {
          if (frame.content) append(frame.content);
        }, controller.signal, (stage) => { if (stage) pushToast('info', stage); });
      } else if (provider === byok.PROVIDER_ID) {
        await byok.streamChat(byok.findByModel(provider, model), turns, (frame) => {
          if (frame.content) append(frame.content);
        }, controller.signal, { byokStream });
      } else if (provider === 'local') {
        await streamLocalChat(localRow?.baseUrl || '', model, turns, (frame) => {
          if (frame.content) append(frame.content);
        }, controller.signal, localRow?.apiKey || undefined);
      } else {
        await streamChat(active.provider, { model, messages: turns }, (frame) => {
          if (frame.content) append(frame.content);
        }, controller.signal);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const told = failure.attribute({ ...asked, message: (err as Error).message });
      setSessions((prev) => prev.map((s) => {
        if (s.id !== sid) return s;
        const list = s.messages.slice();
        const last = list[list.length - 1];
        if (last && last.role === 'assistant') list[list.length - 1] = { ...last, error: true, failure: told };
        return { ...s, messages: list, updatedAt: Date.now() };
      }));
    } finally {
      setSending(false);
      abortRef.current = null;
      setTimeout(() => setSessions((prev) => { saveSessions(prev); return prev; }), 0);
    }
  };

  // Build mode: the message becomes a real remote build session.
  const startBuild = async (plan: string) => {
    if (!active) return;
    // The staged attachment rides the build as it rides a chat turn, and the
    // chip is cleared: a build used to leave it sitting there forever.
    const fullPlan = attached ? `${plan}\n\n--- attached ---\n${attached}` : plan;
    setSending(true);
    if (attached) setAttached('');
    try {
      const session: any = await api.buildRun({ plan: fullPlan });
      const note: Msg = {
        role: 'assistant',
        content: `Build **${session.id}** started (${session.status}). Watch it live in **Builds** — approvals appear there.`,
        ts: Date.now(),
      };
      patchSession(active.id, {
        messages: [...active.messages, { role: 'user', content: fullPlan, ts: Date.now() } as Msg, note],
        draft: '',
        title: active.messages.length === 0 ? threads.autoTitle(plan) : active.title,
      });
    } catch (err) {
      // A build that could not start says so where the request was made, with
      // the same failure card a chat turn uses -- the bottom bar it used to
      // write to is gone, and silently doing nothing was the alternative.
      const told = failure.attribute({
        provider: active.provider,
        providerLabel: 'Build',
        model: '',
        message: (err as Error).message,
      });
      const note: Msg = {
        role: 'assistant',
        content: '',
        error: true,
        failure: told,
        ts: Date.now(),
      };
      patchSession(active.id, {
        messages: [...active.messages, { role: 'user', content: fullPlan, ts: Date.now() } as Msg, note],
      });
    } finally {
      setSending(false);
    }
  };

  // `!` mode: the line runs in the open folder, and its output is shown now
  // and handed to the model with the next message.
  const runShell = async (command: string) => {
    if (!active) return;
    const root = openFolder();
    if (!hasShell() || !root) {
      pushToast('warn', 'Open a folder first (Ctrl+K → Open a local folder); commands run there.');
      return;
    }
    setSending(true);
    patchSession(active.id, { draft: '' });
    let out = '';
    try {
      out = await executeTool({ id: `sh${Date.now().toString(36)}`, name: 'run_command', arguments: '' } as any, { command }, { localRoot: root });
    } catch (err) {
      out = `Error: ${(err as Error).message || String(err)}`;
    }
    const block = `$ ${command}\n${toolsLib.clip(out)}`;
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === active.id
        ? { ...s, messages: [...s.messages, { role: 'user' as const, content: block, note: true, shell: block, ts: Date.now() }], updatedAt: Date.now() }
        : s));
      saveSessions(next);
      return next;
    });
    setSending(false);
    stickToBottom.current = true;
  };

  const sendToDesign = (brief: string) => {
    try { sessionStorage.setItem(DESIGN_BRIEF_KEY, brief); } catch { /* the event still carries it */ }
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { view: 'design' } }));
    pushToast('info', 'Brief sent to Design.');
  };

  // Read aloud with the voices Windows already has (speechSynthesis works in
  // WebView2). Markdown is stripped so the voice does not read the syntax.
  const [speaking, setSpeaking] = useState(false);
  const readAloud = (text: string) => {
    const synth = (globalThis as any).speechSynthesis as SpeechSynthesis | undefined;
    if (!synth) { pushToast('warn', 'This window has no speech voices.'); return; }
    if (synth.speaking) { synth.cancel(); setSpeaking(false); return; }
    const plain = text.replace(/```[\s\S]*?```/g, ' (code) ').replace(/[#*_`>|-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const utterance = new SpeechSynthesisUtterance(plain.slice(0, 4000));
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utterance);
  };

  // Attach a document as text: PDF, Word, Excel and PowerPoint through the
  // in-app extractors FilesScreen uses; anything else is read as text. The
  // chip shows a rough token cost, since a big PDF can fill a small context.
  // Pictures ride the next message; the model on screen has to be able to see.
  const addImage = (url: string) => {
    setImages((prev) => {
      if (prev.length >= MAX_IMAGES) { pushToast('warn', `Up to ${MAX_IMAGES} pictures per message.`); return prev; }
      return [...prev, url];
    });
    pushToast('ok', 'Picture attached. It needs a vision model (llava, gemma3, qwen2.5-vl, GPT-4o...).');
  };

  // The mic: first press records, second press sends the audio to Whisper and
  // types the words into the box (after whatever is already there).
  const dictate = async () => {
    if (dictation === 'recording' && recording.current) {
      const rec = recording.current;
      recording.current = null;
      setDictation('working');
      try {
        const words = await transcribeAuto(await rec.stop(), hfToken || '');
        if (words) patchSession(active.id, { draft: active.draft ? `${active.draft.replace(/\s+$/, '')} ${words}` : words });
        else pushToast('info', 'Nothing was heard.');
      } catch (e) {
        pushToast('error', ((e as Error).message || String(e)).split('\n')[0]);
      } finally {
        setDictation('idle');
        inputRef.current?.focus();
      }
      return;
    }
    // A local whisper.cpp set up in Settings → Dictation is enough on its own.
    if (!hfToken && !(await localSetup()).ready) {
      pushToast('info', 'Dictation needs whisper.cpp set up in Settings → Dictation, or a Hugging Face sign-in (Settings → Connectors). Windows can also type what you say — press Win+H.');
      inputRef.current?.focus();
      return;
    }
    try {
      recording.current = await startRecording();
      setDictation('recording');
    } catch (e) {
      pushToast('error', `Microphone: ${((e as Error).message || String(e)).split('\n')[0]}`);
    }
  };
  useEffect(() => () => recording.current?.cancel(), []);

  const screenshot = async () => {
    try {
      addImage(await captureScreen());
    } catch (e) {
      const msg = ((e as Error).message || String(e)).split('\n')[0];
      if (!/denied|abort|cancel/i.test(msg)) pushToast('error', `Screen capture: ${msg}`);
    }
  };

  useEffect(() => {
    if (sending && !busyChat.current && active) {
      busyChat.current = active.id;
      window.dispatchEvent(new CustomEvent(threads.ACTIVITY_EVENT, { detail: { id: active.id, busy: true } }));
    } else if (!sending && busyChat.current) {
      window.dispatchEvent(new CustomEvent(threads.ACTIVITY_EVENT, { detail: { id: busyChat.current, busy: false } }));
      busyChat.current = null;
    }
  }, [sending]);

  // An MCP App's ui/message (McpAppFrame) is text for the person to review:
  // it joins the draft and is never sent on its own. `active` is null until
  // the first chat exists, so the dependencies are read through `?.` -- a
  // plain `active.id` here crashed the app on a fresh start.
  const insertChatId = active?.id;
  const insertDraft = active?.draft;
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = String((e as CustomEvent).detail?.text || '').trim();
      if (!text || !active) return;
      e.preventDefault();
      patchSession(active.id, { draft: active.draft ? `${active.draft.replace(/\s+$/, '')}\n${text}` : text });
      inputRef.current?.focus();
    };
    window.addEventListener('freeai4u:composer-insert', onInsert);
    return () => window.removeEventListener('freeai4u:composer-insert', onInsert);
  }, [insertChatId, insertDraft]);

  // Ctrl+V with a picture on the clipboard attaches it; text pastes normally.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = imagesIn(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      files.forEach((f) => { imageFileToDataUrl(f).then(addImage, () => pushToast('error', 'That picture could not be read.')); });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const attachFile = async (file: File) => {
    const name = file.name;
    const ext = (name.split('.').pop() || '').toLowerCase();
    try {
      let text = '';
      if (ext === 'pdf') text = await pdf.extractPdfText(new Uint8Array(await file.arrayBuffer()));
      else if (ext === 'docx') text = await office.extractDocxText(new Uint8Array(await file.arrayBuffer()));
      else if (ext === 'pptx') text = await office.extractPptxText(new Uint8Array(await file.arrayBuffer()));
      else if (ext === 'xlsx') {
        const sheets = await office.extractXlsxSheets(new Uint8Array(await file.arrayBuffer()));
        text = sheets.map((sh) => `# ${sh.name}\n${office.sheetToText(sh.rows)}`).join('\n\n');
      } else if (/^(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
        addImage(await imageFileToDataUrl(file));
        return;
      } else {
        if (file.size > 2 * 1024 * 1024) { pushToast('warn', `${name} is over 2 MB; attach a smaller part of it.`); return; }
        text = await file.text();
      }
      if (!text.trim()) { pushToast('warn', `${name} has no text to attach.`); return; }
      const capped = text.length > 200000 ? `${text.slice(0, 200000)}\n[truncated]` : text;
      setAttached((prev) => `${prev ? prev + '\n\n' : ''}--- ${name} ---\n${capped}`);
      pushToast('ok', `Attached ${name} (~${Math.round(capped.length / 4).toLocaleString()} tokens).`);
    } catch (e) {
      pushToast('error', `${name}: ${((e as Error).message || String(e)).split('\n')[0]}`);
    }
  };

  const addNote = (content: string) => {
    if (!active) return;
    patchSession(active.id, { messages: [...active.messages, { role: 'assistant', content, note: true, model: 'NeuraOS', ts: Date.now() }], draft: '' });
  };

  const download = (name: string, text: string) => {
    if (chats.downloadJson(name, text)) pushToast('ok', `Saved ${name}.`);
    else pushToast('warn', 'This window has no download surface.');
  };

  const setMode = (mode: ModeId) => {
    if (!active) return;
    if (mode === 'shell' || mode === 'design') { setTransient(mode); return; }
    setTransient(null);
    if (mode !== active.mode) patchSession(active.id, { mode });
  };

  // One place every `/command` lands, from the menu or typed with an argument.
  const onCommand = (command: SlashCommand, arg: string) => {
    if (!active) return;
    const go = (detail: Record<string, string>) => window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail }));
    const clear = () => patchSession(active.id, { draft: '' });
    if (command.id.startsWith('skill:')) {
      patchSession(active.id, { draft: `Use the ${command.id.slice(6)} skill. ${arg}`.trim() + ' ' });
      return;
    }
    switch (command.id) {
      case 'new': startNew(); return;
      case 'history': clear(); go({ panel: 'sessions' }); return;
      case 'settings': case 'tools': case 'mcp': clear(); go({ view: 'settings' }); return;
      case 'model': clear(); window.dispatchEvent(new CustomEvent(MODEL_PICK_EVENT)); return;
      case 'help': addNote(HELP); return;
      case 'compare':
        clear();
        setCompare({ open: true, prompt: arg || active.draft || grammar.lastUserText(active.messages) });
        return;
      case 'attach': clear(); fileRef.current?.click(); return;
      case 'screenshot': clear(); screenshot(); return;
      case 'reasoning': {
        const level = (['off', 'low', 'medium', 'high'].find((l) => l === arg.toLowerCase()) || '') as ChatSession['reasoning'] | '';
        if (!level) { pushToast('info', `Reasoning is ${active.reasoning || 'the model default'}. Use /reasoning off, low, medium or high.`); clear(); return; }
        patchSession(active.id, { reasoning: level, draft: '' });
        pushToast('ok', level === 'off' ? 'Reasoning effort: model default.' : `Reasoning effort: ${level} (for models that support it).`);
        return;
      }
      case 'memory': {
        clear();
        if (!arg) { go({ view: 'settings' }); return; }
        api.raw('/api/memory', { method: 'PUT', body: JSON.stringify({ text: arg }) })
          .then(() => pushToast('ok', 'Remembered.'))
          .catch((e: unknown) => pushToast('error', ((e as Error).message || String(e)).split('\n')[0]));
        return;
      }
      case 'share': {
        clear();
        const messages = active.messages.filter((m) => !m.note).map((m) => ({ role: m.role, content: m.content }));
        api.raw('/api/share', { method: 'PUT', body: JSON.stringify({ title: active.title, messages }) })
          .then((data: any) => {
            const link = `${api.getServer().replace(/\/+$/, '')}${data?.url || ''}`;
            return navigator.clipboard.writeText(link).then(() => pushToast('ok', `Read-only link copied: ${link}`), () => pushToast('ok', link));
          })
          .catch((e: unknown) => pushToast('error', ((e as Error).message || String(e)).split('\n')[0]));
        return;
      }
      case 'copy': {
        clear();
        navigator.clipboard.writeText(grammar.threadMarkdown(active))
          .then(() => pushToast('ok', 'Thread copied as Markdown.'))
          .catch(() => pushToast('warn', 'This window would not let the app copy.'));
        return;
      }
      case 'export': {
        clear();
        const slug = (active.title || 'chat').replace(/[^\w-]+/g, '-').slice(0, 40) || 'chat';
        if (/json/i.test(arg)) download(`${slug}.json`, JSON.stringify(active, null, 2));
        else download(`${slug}.md`, grammar.threadMarkdown(active));
        return;
      }
      case 'agent': {
        clear();
        const { id, task } = agentsLib.parseCommand(arg);
        const all = agentsLib.list();
        if (!id) {
          addNote(['**Agents** — `/agent <id> <task>`', '', ...all.map((a) => `- \`${a.id}\` — ${a.description || a.name}`), '', 'Edit them under Library → Agents.'].join('\n'));
          return;
        }
        const agent = agentsLib.get(id);
        if (!agent) { pushToast('warn', `No agent "${id}". Agents: ${all.map((a) => a.id).join(', ')}.`); return; }
        runAgentInChat(agent, task, task ? `Ask the ${agent.name} agent: ${task}` : `Run the ${agent.name} agent.`);
        return;
      }
      case 'research': clear(); runResearch(arg); return;
      case 'image': {
        // From the menu there is nothing to draw yet: the composer waits for it.
        if (!arg) { patchSession(active.id, { draft: '/image ' }); requestAnimationFrame(() => inputRef.current?.focus()); return; }
        runPicture('generate', grammar.stripPictureMention(arg), `/image ${arg}`);
        return;
      }
      case 'edit': {
        // Without words, the chip above the composer says which picture this
        // will change before anything is sent.
        if (!arg) { patchSession(active.id, { draft: '/edit ' }); requestAnimationFrame(() => inputRef.current?.focus()); return; }
        const target = editTarget();
        if (!target) {
          pictureNote('There is no picture to edit yet. Attach one with the paperclip or `/attach`, paste one with Ctrl+V, or draw one with `/image` — then run `/edit` again.');
          return;
        }
        runPicture('edit', grammar.stripPictureMention(arg), `/edit ${arg}`, target);
        return;
      }
      case 'redo': clear(); redoPicture(); return;
      case 'recipe': {
        clear();
        const id = agentsLib.parseCommand(arg).id;
        const all = recipesLib.list();
        if (!id) {
          addNote(all.length
            ? ['**Recipes** — `/recipe <id> key=value ...`', '', ...all.map((r) => `- \`${r.id}\` — ${r.name}${r.params.length ? ` (${r.params.map((p) => p.name).join(', ')})` : ''}`)].join('\n')
            : 'No recipes yet. Make one under Library → Recipes.');
          return;
        }
        const recipe = recipesLib.get(id);
        if (!recipe) { pushToast('warn', `No recipe "${id}".${all.length ? ` Recipes: ${all.map((r) => r.id).join(', ')}.` : ''}`); return; }
        runRecipeInChat(recipe, recipesLib.parseCommand(arg, recipe.params).values);
        return;
      }
      default: break;
    }
    if (command.mode) setMode(command.mode);
    setFlow(command.next || command.id === 'review' ? command.id : null);
    const text = command.insertText ? command.insertText + arg : arg;
    const sessionMode = command.mode && command.mode !== 'shell' && command.mode !== 'design' ? { mode: command.mode } : {};
    patchSession(active.id, { draft: text, ...sessionMode });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Library -> Agents / Recipes "Run in chat": the command waits in
  // sessionStorage and runs once this screen is mounted (or hears the event).
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  useEffect(() => {
    const runPending = () => {
      let text = '';
      try {
        text = sessionStorage.getItem(PENDING_COMMAND_KEY) || '';
        if (text) sessionStorage.removeItem(PENDING_COMMAND_KEY);
      } catch { return; }
      const parsed = text ? grammar.parseSlash(text) : null;
      if (parsed) onCommandRef.current(parsed.command, parsed.arg);
    };
    window.addEventListener(RUN_COMMAND_EVENT, runPending);
    const timer = setTimeout(runPending, 0);
    return () => { window.removeEventListener(RUN_COMMAND_EVENT, runPending); clearTimeout(timer); };
  }, []);

  // What `@` can reach: this provider's models, the other services, files at
  // the top of the open folder, and MCP servers.
  const root = openFolder();
  useEffect(() => {
    if (!hasShell() || !root) { setFolderFiles([]); return; }
    listLocalDir(root, '')
      .then((listing: any) => setFolderFiles((listing?.entries || []).filter((e: any) => !e.dir).map((e: any) => String(e.name)).slice(0, 200)))
      .catch(() => setFolderFiles([]));
  }, [root]);
  const latestPicture = active ? grammar.latestPicture(active.messages) : null;
  const mentionSources: MentionSource[] = [
    ...models.map((m) => ({ kind: 'model' as const, id: m.id, label: m.id, hint: 'switch to this model', provider: active?.provider })),
    ...choices.filter((c) => c.id !== active?.provider).map((c) => ({ kind: 'model' as const, id: `provider:${c.id}`, label: c.label, hint: 'switch service', provider: c.id })),
    ...folderFiles.map((f) => ({ kind: 'file' as const, id: f, label: f, hint: 'attach from the open folder' })),
    ...(latestPicture ? [{ kind: 'picture' as const, id: 'picture', label: 'picture', hint: 'attach the latest picture in this chat' }] : []),
    ...toolsLib.mcpServers().map((sv) => ({ kind: 'mcp' as const, id: sv.name, label: sv.name, hint: `${sv.tools.length} tools` })),
  ];
  const onMention = (source: MentionSource): string => {
    if (!active) return '';
    if (source.kind === 'model') {
      if (source.id.startsWith('provider:')) patchSession(active.id, { provider: source.provider || '', model: '' });
      else patchSession(active.id, { model: source.id });
      pushToast('info', `Now on ${source.label}.`);
      return '';
    }
    // @picture attaches the newest picture the way @file attaches a file: it
    // rides this message, and /edit reads an attached picture first.
    if (source.kind === 'picture') {
      if (!latestPicture) return '';
      if (!images.includes(latestPicture.url)) addImage(latestPicture.url);
      return '@picture';
    }
    if (source.kind === 'file') {
      readLocalFile(root, source.id)
        .then((file: any) => {
          if (file.binary) { pushToast('warn', `${source.id} is binary; it cannot be attached as text.`); return; }
          setAttached((prev) => `${prev ? prev + '\n\n' : ''}--- ${source.id} ---\n${file.text}`);
        })
        .catch((e: unknown) => pushToast('error', ((e as Error).message || String(e)).split('\n')[0]));
      return `@${source.id}`;
    }
    return `@${source.label}`;
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Right-click on a reply: the actions for what is under the pointer, in a
  // ring at the pointer. The text is either the selection (what the user means)
  // or the code block it landed on, and it is capped so a right-click on a
  // 4000-line reply cannot paste the whole thing into the composer.
  const onMessagesContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.message')) return;
    const selection = String(window.getSelection?.() || '').trim();
    const code = target.closest('.code-block')?.querySelector('pre')?.textContent || '';
    const body = selection || code.trim() || (target.closest('.message')?.textContent || '').trim();
    if (!body) return;
    e.preventDefault();
    const snippet = body.length > 4000 ? `${body.slice(0, 4000)}\n…` : body;
    const index = Number((target.closest('.message') as HTMLElement | null)?.dataset.index ?? -1);
    const fenced = `\`\`\`\n${snippet}\n\`\`\``;
    const ask = (text: string) => {
      patchSession(active.id, { draft: text });
      inputRef.current?.focus();
    };
    const items: RadialItem[] = [
      {
        id: 'copy',
        label: 'Copy',
        icon: 'copy',
        run: () => {
          navigator.clipboard.writeText(snippet)
            .then(() => pushToast('ok', 'Copied.'))
            .catch(() => pushToast('warn', 'This window would not let the app copy.'));
        },
      },
      { id: 'explain', label: 'Explain', icon: 'chat', run: () => ask(`Explain this:\n\n${fenced}`) },
      { id: 'rework', label: 'Rework', icon: 'build', run: () => ask(`Rework this and show the improved version:\n\n${fenced}`) },
      { id: 'design', label: 'To Design', icon: 'design', run: () => sendToDesign(snippet) },
      { id: 'compare', label: 'Compare', icon: 'compass', run: () => setCompare({ open: true, prompt: grammar.lastUserText(active.messages) }) },
      {
        id: 'speak',
        label: speaking ? 'Stop' : 'Read aloud',
        icon: 'activity',
        run: () => readAloud(snippet),
      },
    ];
    if (index >= 0) {
      // A new chat with everything up to here: try another direction without
      // losing this one.
      items.push({
        id: 'branch',
        label: 'Branch',
        icon: 'plus',
        run: () => {
          const fork = { ...newSession(active.provider, active.model), title: `${active.title} (branch)`, mode: active.mode, messages: active.messages.slice(0, index + 1) };
          persist([fork, ...sessions].slice(0, MAX_SESSIONS));
          setActiveId(fork.id);
          pushToast('info', 'Branched into a new chat.');
        },
      });
    }
    if (active.messages.some((m) => m.failure)) {
      items.push({
        id: 'retry-next',
        label: 'Retry',
        icon: 'refresh',
        run: () => retry(failure.nextModel(active.model, models)),
      });
    }
    setRadial({ x: e.clientX, y: e.clientY, items });
  };

  // Copy buttons inside rendered code blocks.
  const onMessagesClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // A Mermaid block: draw it under the source, or hide the drawing again.
    if (target.classList?.contains('code-diagram')) {
      const block = target.closest('.code-block');
      const shown = block?.querySelector('.mermaid-view');
      if (shown) { shown.remove(); target.textContent = 'Diagram'; return; }
      const view = document.createElement('div');
      view.className = 'mermaid-view';
      view.textContent = 'Drawing…';
      block?.appendChild(view);
      target.textContent = 'Hide diagram';
      renderMermaid(block?.querySelector('pre')?.textContent || '')
        .then((svg) => { view.innerHTML = svg; })
        .catch((err: unknown) => { view.textContent = `Mermaid could not draw this: ${((err as Error).message || String(err)).split('\n')[0]}`; });
      return;
    }
    // An HTML block: look at it in place (sandboxed, no same-origin) or send it
    // to the Design studio.
    if (target.classList?.contains('code-preview') || target.classList?.contains('code-design')) {
      const block = target.closest('.code-block');
      const source = block?.querySelector('pre')?.textContent || '';
      if (target.classList.contains('code-design')) { sendToDesign(source); return; }
      const shown = block?.querySelector('iframe.code-preview-frame');
      if (shown) { shown.remove(); target.textContent = 'Preview'; return; }
      const frame = document.createElement('iframe');
      frame.className = 'code-preview-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('title', 'HTML preview');
      frame.srcdoc = source;
      block?.appendChild(frame);
      target.textContent = 'Hide preview';
      return;
    }
    if (!target.classList?.contains('code-copy')) return;
    const block = target.closest('.code-block');
    const pre = block?.querySelector('pre');
    if (pre) {
      navigator.clipboard.writeText(pre.textContent || '').then(() => {
        target.textContent = 'Copied';
        setTimeout(() => { target.textContent = 'Copy'; }, 1200);
      }).catch(() => {});
    }
  };

  if (!active) {
    return (
      <div className="screen chat">
        <div className="empty-state">
          <div className="empty-icon"><Icon name="chat" size={28} /></div>
          <h2>No chats yet</h2>
          <p>Starting one now…</p>
          <button className="primary" onClick={startNew}>New chat</button>
        </div>
      </div>
    );
  }

  // What the service this session is on meters, in its own numbers -- not the
  // engine's internal retry budget.
  //
  // The old line here read "rate-limit budget 20s", which is a fact about this
  // server's backoff arithmetic. It sat at the bottom of the screen in the same
  // styling as an error, so the app looked permanently broken and explained
  // nothing. The useful fact is the free tier: how many calls the day allows,
  // how many are left, and whether the allowance is shared. When a service
  // publishes no numbers there is nothing worth saying, so nothing is said.
  const tier = providerRows.find((p) => p.id === active.provider)?.freeTier as
    | { text?: string; callsToday?: number; cap?: number }
    | undefined;
  const freeTierNote = (() => {
    if (!tier) return '';
    const parts: string[] = [];
    if (tier.text) parts.push(tier.text);
    if (tier.cap && typeof tier.callsToday === 'number') {
      parts.push(`${tier.callsToday} of ${tier.cap} used today`);
    }
    return parts.join(' · ');
  })();

  // The workflow's next step, offered once the reply to this one has landed.
  const lastMsg = active.messages[active.messages.length - 1];
  const nextUp = flow && !sending && lastMsg?.role === 'assistant' && !lastMsg.note ? grammar.nextStep(flow) : null;

  return (
    <div className="screen chat">
      {active.provider === 'hf' && !hfToken && (
        <div className="hf-signin-banner" role="status">
          {/* A pasted access token, checked before it is kept: the OAuth app
              the old device-code button relied on no longer exists. */}
          <HfSignIn />
        </div>
      )}
      <RunSettings open={runOpen && isSavedProvider(active.provider)} onClose={() => setRunOpen(false)} provider={active.provider} model={active.model} />

      <div
        className="chat-messages"
        ref={listRef}
        onScroll={onScroll}
        onClick={onMessagesClick}
        onContextMenu={onMessagesContextMenu}
      >
        {active.messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon"><Icon name="chat" size={28} /></div>
            <h2>Start a conversation</h2>
            <p>Free models first, limits on the row. Plan drafts a plan; Build starts a real build session with approvals.</p>
          </div>
        )}
        {active.messages.map((msg, i) => (
          <div key={i} data-index={i} className={`message ${msg.role}${msg.error ? ' errored' : ''}${msg.note ? ' is-note' : ''}`}>
            <div className="message-role">
              {msg.shell ? 'You · command' : msg.role === 'user'
                ? 'You'
                : msg.agent
                  ? `${msg.agent} · agent${msg.model ? ` · ${msg.model}` : ''}`
                  : (msg.providerLabel && msg.model ? `${msg.providerLabel} · ${msg.model}` : (msg.model || 'Assistant'))}
            </div>
            {msg.images && msg.images.length > 0 && (
              <div className="message-images">
                {msg.images.map((url, j) => {
                  const key = `${i}:${j}`;
                  const shown = pictureHover === key;
                  return (
                    // Hover or keyboard focus shows the picture's actions. Styled
                    // inline: they sit on the picture, not in the page's flow.
                    <span
                      key={j}
                      style={{ position: 'relative', display: 'inline-block' }}
                      onMouseEnter={() => setPictureHover(key)}
                      onMouseLeave={() => setPictureHover((k) => (k === key ? '' : k))}
                      onFocus={() => setPictureHover(key)}
                      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPictureHover((k) => (k === key ? '' : k)); }}
                    >
                      <img
                        src={url}
                        alt={msg.picture ? `Picture: ${msg.picture.prompt}` : `Picture ${j + 1} sent with this message`}
                        tabIndex={0}
                      />
                      <span
                        className="picture-actions"
                        style={{
                          position: 'absolute', left: 4, right: 4, bottom: 8, display: 'flex', gap: 4, flexWrap: 'wrap',
                          opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none', transition: 'opacity 120ms',
                        }}
                      >
                        <button onClick={() => editPicture(url, i, j)} disabled={sending} title="Put /edit in the composer, aimed at this picture">Edit</button>
                        <button onClick={() => openInImages(url)} title="Change it in the Images screen">Open in Images</button>
                        <button onClick={() => imageRun.savePicture(url)} title="Save it to a file">Save</button>
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
            {msg.role === 'assistant'
              ? (msg.content
                ? <div
                    className="message-content"
                    // A research reply's [n] become superscript links to its sources.
                    dangerouslySetInnerHTML={{ __html: msg.sources?.length
                      ? research.superscriptCitations(renderMarkdown(research.linkCitations(msg.content, msg.sources)))
                      : renderMarkdown(msg.content) }}
                  />
                : null)
              : msg.shell
                ? <pre className="message-content shell-output">{msg.shell}</pre>
                : <div className="message-content">{msg.content}</div>}
            {msg.role === 'assistant' && msg.tools && msg.tools.length > 0 && (
              <ToolCards events={msg.tools} expandAll={cardsOpen} onDecide={sending && i === active.messages.length - 1 ? decide : undefined} />
            )}
            {msg.research && msg.content && !msg.error && !(sending && i === active.messages.length - 1) && (
              <div className="research-footer">
                {msg.research.noSources && <div className="research-nosources">{research.NO_SOURCES_LABEL}</div>}
                {msg.sources && msg.sources.length > 0 && (
                  <details className="research-sources" open>
                    <summary>Sources ({msg.sources.length})</summary>
                    <ol>
                      {msg.sources.map((src) => (
                        <li key={src.n} value={src.n}>
                          {/^https?:\/\//i.test(src.url)
                            ? <a href={src.url} target="_blank" rel="noreferrer">{src.title}</a>
                            : <span>{src.title}</span>}
                          <span className="research-host">{hostOf(src.url)}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {!!msg.research.uncited && (
                  <div className="research-warn">
                    {msg.research.uncited} paragraph{msg.research.uncited === 1 ? '' : 's'} carr{msg.research.uncited === 1 ? 'ies' : 'y'} no citation — check {msg.research.uncited === 1 ? 'it' : 'them'} before relying on {msg.research.uncited === 1 ? 'it' : 'them'}.
                  </div>
                )}
                {msg.research.graph && (
                  <details className="research-graph" open>
                    <summary>Knowledge graph</summary>
                    {msg.research.graph.message && <div className="research-warn">{msg.research.graph.message}</div>}
                    {/* Drawn here from the JSON by diagram-layout, which escapes every label. */}
                    <div className="research-graph-view" dangerouslySetInnerHTML={{ __html: graphSvg(msg.research.graph, `Knowledge graph: ${msg.research.question}`, true) || 'Drawing…' }} />
                  </details>
                )}
                <div className="research-actions">
                  <button onClick={() => knowledgeGraph(i)} disabled={graphBusy !== null || sending}>
                    {graphBusy === i ? 'Drawing…' : msg.research.graph ? 'Redraw graph' : 'Knowledge graph'}
                  </button>
                  <button onClick={() => exportResearchMarkdown(msg)}>Export Markdown</button>
                  <button onClick={() => { exportResearchPdf(msg); }}>Export PDF</button>
                </div>
              </div>
            )}
            {/* What failed, what it was asked of (which the label above already
                names), the provider's own words, and what to do next -- instead
                of the provider's error dump standing in for a reply. */}
            {msg.failure && (
              <div className="failure-card">
                <div className="failure-head">
                  <span className="failure-tag">{msg.failure.label}</span>
                  <strong>{msg.failure.summary}</strong>
                </div>
                {msg.failure.upstream && <div className="failure-upstream">{msg.failure.upstream}</div>}
                <div className="failure-advice">{msg.failure.advice}</div>
                <div className="failure-actions">
                  {msg.research
                    ? <button onClick={() => rerunResearch(i)} disabled={sending}>Retry research</button>
                    : msg.picture
                      ? <button onClick={() => redoPicture(msg.picture)} disabled={sending}>Try again</button>
                      : <button onClick={() => retry()} disabled={sending}>Retry {msg.model}</button>}
                  {models.length > 1 && !msg.research && !msg.picture && (
                    <button
                      onClick={() => retry(failure.nextModel(msg.model || '', models))}
                      disabled={sending}
                    >
                      Try {failure.nextModel(msg.model || '', models)}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        {sending && (
          <div className="message assistant">
            <div className="message-content typing shimmer">Thinking…</div>
          </div>
        )}
      </div>

      {/* No error bar down here any more. A failure is about one turn, and it
          belongs in that turn -- the card above names what was asked of which
          service and what to do, with its own Retry. A second red strip at the
          bottom said the same thing twice and read as a permanent fault. */}
      {consent && (
        <div className="consent-backdrop" role="dialog" aria-modal="true" aria-labelledby="consent-title">
          <div className="consent-dialog">
            <h3 id="consent-title">Start {consent.servers.length === 1 ? 'this server' : 'these servers'} for “{consent.recipe.name}”?</h3>
            <p>The recipe uses {consent.servers.length === 1 ? 'this MCP server' : 'these MCP servers'}. A local one runs a program on this PC; its tools still ask before they act.</p>
            <ul className="consent-list">
              {consent.servers.map((s) => (
                <li key={s.name}>
                  <span className="mono">{s.name}</span>
                  <span className="consent-cmd mono">{toolsLib.isStdio(s) ? `${s.command} ${toolsLib.joinArgs(s.args || [])}`.trim() : s.url}</span>
                </li>
              ))}
            </ul>
            <p className="settings-hint">Your answer is remembered for this recipe.</p>
            <div className="consent-actions">
              <button onClick={() => consent.resolve(false)}>Cancel</button>
              <button className="primary" onClick={() => consent.resolve(true)} autoFocus>Allow and run</button>
            </div>
          </div>
        </div>
      )}
      {radial && (
        <RadialMenu
          x={radial.x}
          y={radial.y}
          items={radial.items}
          onClose={() => setRadial(null)}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".png,.jpg,.jpeg,.webp,.gif,.bmp,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.html,.css,.js,.ts,.tsx,.py,.rs,.go,.java,.xml,.yaml,.yml,.log"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) attachFile(f); e.target.value = ''; }}
      />
      <CompareDrawer
        open={compare.open}
        prompt={compare.prompt}
        targets={modelTargets((id) => choices.find((c) => c.id === id)?.label || id, active.provider, models)}
        onClose={() => setCompare({ open: false, prompt: '' })}
        onUse={(text, target) => {
          patchSession(active.id, {
            messages: [
              ...active.messages,
              { role: 'user', content: compare.prompt, ts: Date.now() },
              { role: 'assistant', content: text, model: target.model, provider: target.provider, providerLabel: target.label.split(' · ')[0], ts: Date.now() },
            ],
          });
          setCompare({ open: false, prompt: '' });
        }}
      />
      <Composer
        value={active.draft}
        onChange={(text) => patchSession(active.id, { draft: text })}
        mode={transient || active.mode}
        onMode={setMode}
        sending={sending}
        onSend={send}
        onStop={stop}
        onCommand={onCommand}
        slashExtra={skillRows}
        mentionSources={mentionSources}
        onMention={onMention}
        toolsOn={toolsOn}
        recall={() => grammar.lastUserText(active.messages)}
        onAttach={() => fileRef.current?.click()}
        onDictate={dictate}
        dictation={dictation}
        inputRef={inputRef}
        modelChip={(
          <>
            {/* One pill, not two dropdowns: the service and the model are one
                decision. It lives in the composer now -- Ctrl+M or @ reach it. */}
            <ModelPicker
              providers={choices}
              models={models}
              provider={active.provider}
              model={active.model}
              onPick={(provider, model) => patchSession(active.id, { provider, model })}
              disabled={sending}
            />
            {isSavedProvider(active.provider) && (
              <button className="composer-icon" onClick={() => setRunOpen((open) => !open)} title="Run settings for this model" aria-label="Run settings" aria-pressed={runOpen}>
                <Icon name="settings" size={14} />
              </button>
            )}
            {/* The free tier's own numbers, as a quiet fact: a limit working
                as intended is not a fault. */}
            {freeTierNote && (
              <span className="composer-note" title="What this service's free tier meters">{freeTierNote}</span>
            )}
          </>
        )}
        above={(
          <>
            {nextUp && (
              <div className="follow-chip-row">
                <button className="follow-chip" onClick={() => onCommand(nextUp, '')} title={nextUp.hint}>
                  Next: /{nextUp.id} <span className="follow-chip-hint">{nextUp.hint}</span>
                </button>
                <button className="follow-chip-close" onClick={() => setFlow(null)} aria-label="Dismiss the suggestion">
                  <Icon name="close" size={12} />
                </button>
              </div>
            )}
            {/^\/edit(\s|$)/i.test(active.draft || '') && (() => {
              // Said before sending: which picture /edit will change, or that
              // there is none and nothing will be sent.
              const target = editTarget();
              return (
                <div className="attach-chip">
                  <span className="attach-label">
                    {target && <img src={target.url} alt="" style={{ height: 28, width: 28, objectFit: 'cover', borderRadius: 4, verticalAlign: 'middle', marginRight: 6 }} />}
                    {target ? grammar.targetLabel(target) : 'No picture to edit — attach one, paste one, or draw one with /image first'}
                  </span>
                  {target?.from === 'picked' && (
                    <button onClick={() => setPinnedPicture(null)} title="Edit the latest picture instead" aria-label="Forget the picked picture">
                      <Icon name="close" size={13} />
                    </button>
                  )}
                </div>
              );
            })()}
            {images.length > 0 && (
              <div className="attach-images">
                {images.map((url, i) => (
                  <span className="attach-thumb" key={i}>
                    <img src={url} alt={`Attached picture ${i + 1}`} />
                    <button onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove picture ${i + 1}`}>
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attached && (
              <div className="attach-chip">
                <span className="attach-label">
                  <Icon name="paperclip" size={13} /> Attached · {attached.length.toLocaleString()} chars · ~{Math.round(attached.length / 4).toLocaleString()} tokens
                </span>
                <button onClick={() => setAttached('')} title="Remove attachment" aria-label="Remove attachment">
                  <Icon name="close" size={13} />
                </button>
              </div>
            )}
          </>
        )}
      />
    </div>
  );
}
