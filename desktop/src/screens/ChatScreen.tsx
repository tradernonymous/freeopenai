import { useState, useRef, useEffect, useCallback } from 'react';
import { api, streamChat, streamLocalChat, type StreamFrame } from '../api';
import { hasShell, listLocalDir, localModelStatus, openUrl, readLocalFile } from '../bridge';
import { renderMarkdown } from '../markdown';
import Icon from '../components/Icon';
import ModelPicker from '../components/ModelPicker';
import Composer from '../components/Composer';
import { NAVIGATE_EVENT } from '../Sidebar';
// UMD modules: loaded for their side effect, read off globalThis.
import RadialMenu, { type RadialItem } from '../components/RadialMenu';
import { pushToast } from '../components/Toasts';
import RunSettings from '../components/RunSettings';
import ToolCards from '../components/ToolCards';
import { GITHUB_CHANGED_EVENT } from '../components/ConnectorsCard';
import { runTurn, type ToolEvent, type TurnOptions } from '../agent-turn';
import { executeTool } from '../tool-run';
import '../tools.js';
import '../composer.js';
import { isSavedProvider, streamSaved } from '../run-model';
import '../saved-models.js';
import '../chats.js';
import '../failure.js';
import '../fallback.js';
import '../local-models.js';
import '../hf-auth.js';
import '../hf-inference.js';

const chats: typeof import('../chats.js') = (globalThis as any).FreeAI4UChats;
const failure: typeof import('../failure.js') = (globalThis as any).FreeAI4UFailure;
const fallback: typeof import('../fallback.js') = (globalThis as any).FreeAI4UFallback;
const localModels: typeof import('../local-models.js') = (globalThis as any).FreeAI4ULocalModels;
const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;
const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;
const toolsLib: typeof import('../tools.js') = (globalThis as any).FreeAI4UTools;
const grammar: typeof import('../composer.js') = (globalThis as any).FreeAI4UComposer;

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
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Msg[];
  provider: string;
  model: string;
  mode: 'chat' | 'plan' | 'build';
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
function saveSessions(sessions: ChatSession[]) {
  const report = chats.writeStoreReport(null, sessions);
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

/** The turns a model is shown: notes are for the person, shell output rides along. */
export function turnsFor(messages: Msg[]): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  let pending = '';
  for (const m of messages) {
    if (m.note) {
      if (m.shell) pending += `${m.shell}\n\n`;
      continue;
    }
    if (m.role === 'user' && pending) {
      out.push({ role: 'user', content: `Command output from the open folder:\n${pending}---\n${m.content}` });
      pending = '';
    } else {
      out.push({ role: m.role, content: m.content });
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
  // Hugging Face sign-in, right here: a device code, the same flow Library uses.
  const [hfCode, setHfCode] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const signInHf = () => {
    hfAuth.startDeviceCode()
      .then((dc: any) => {
        setHfCode({ user_code: dc.user_code, verification_uri: dc.verification_uri });
        const page = dc.verification_uri_complete || dc.verification_uri;
        if (hasShell()) openUrl(page).catch(() => { /* the code and the address are on screen */ });
        else window.open(page, '_blank');
        return hfAuth.pollDeviceCode(dc.device_code, dc.interval, Date.now() + dc.expires_in * 1000);
      })
      .then(() => { setHfCode(null); pushToast('ok', 'Signed in to Hugging Face.'); })
      .catch((e: unknown) => { setHfCode(null); pushToast('error', ((e as Error).message || String(e)).split('\n')[0]); });
  };
  const hfRow = hfInference.providerRow(hfToken);
  const choices = [
    ...savedRows,
    ...(localRow && !providerRows.some((p) => p.id === 'local') ? [localRow] : []),
    ...(hfRow && !providerRows.some((p) => p.id === 'hf') ? [hfRow] : []),
    ...providerRows,
  ];
  const [sending, setSending] = useState(false);
  const [attached, setAttached] = useState<string>('');
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
    if (active.mode === 'build') {
      await startBuild(text);
      return;
    }
    const userMsg: Msg = {
      role: 'user',
      content: attached ? `${text}\n\n--- attached ---\n${attached}` : text,
      ts: Date.now(),
    };
    if (attached) setAttached('');
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
      title: active.messages.length === 0 ? text.slice(0, 48) : active.title,
    });
    setSending(true);
    stickToBottom.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    const sid = active.id;
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
      const provider = active.provider;
      const model = active.model;
      // One request, to whichever provider the session is on. The turn calls
      // it again after every round of tool results.
      const streamOnce: TurnOptions['stream'] = (messages, offered, onFrame, signal) => {
        if (provider === 'hf') {
          return hfInference.streamChat(model, messages, onFrame, signal, hfToken || undefined, offered);
        }
        if (isSavedProvider(provider)) {
          return streamSaved(provider, model, messages, onFrame, signal, (stage) => { if (stage) pushToast('info', stage); }, offered);
        }
        if (provider === 'local') {
          return streamLocalChat(localRow?.baseUrl || '', model, messages, onFrame, signal, localRow?.apiKey || undefined, offered ? { tools: offered } : undefined);
        }
        return streamChat(provider, { model, messages, ...(offered ? { tools: offered } : {}) }, onFrame, signal);
      };
      const upsertTool = (event: ToolEvent) => {
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
      const root = openFolder();
      await runTurn({
        messages: turns,
        tools: toolsOn
          ? toolsLib.catalogue({ github: githubConnected, localRoot: root, shell: hasShell() })
            // Plan changes nothing, so it is offered nothing that could.
            .filter((t) => active.mode !== 'plan' || (!toolsLib.ASKS[t.function.name] && !t.function.name.startsWith('mcp__')))
          : [],
        stream: streamOnce,
        execute: (call, args) => executeTool(call, args, { localRoot: root }),
        // Stopping the turn is a Deny for whatever was waiting.
        approve: (event) => new Promise<boolean>((resolve) => {
          approvals.current[event.id] = resolve;
          controller.signal.addEventListener('abort', () => { delete approvals.current[event.id]; resolve(false); }, { once: true });
        }),
        onText: append,
        onTool: upsertTool,
        onNote: (note) => pushToast('info', note),
        signal: controller.signal,
      });
      // persist the finished transcript
      setSessions((prev) => { saveSessions(prev); return prev; });
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
        title: active.messages.length === 0 ? plan.slice(0, 48) : active.title,
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
      default: break;
    }
    if (command.mode) setMode(command.mode);
    setFlow(command.next || command.id === 'review' ? command.id : null);
    const text = command.insertText ? command.insertText + arg : arg;
    const sessionMode = command.mode && command.mode !== 'shell' && command.mode !== 'design' ? { mode: command.mode } : {};
    patchSession(active.id, { draft: text, ...sessionMode });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // What `@` can reach: this provider's models, the other services, files at
  // the top of the open folder, and MCP servers.
  const root = openFolder();
  useEffect(() => {
    if (!hasShell() || !root) { setFolderFiles([]); return; }
    listLocalDir(root, '')
      .then((listing: any) => setFolderFiles((listing?.entries || []).filter((e: any) => !e.dir).map((e: any) => String(e.name)).slice(0, 200)))
      .catch(() => setFolderFiles([]));
  }, [root]);
  const mentionSources: MentionSource[] = [
    ...models.map((m) => ({ kind: 'model' as const, id: m.id, label: m.id, hint: 'switch to this model', provider: active?.provider })),
    ...choices.filter((c) => c.id !== active?.provider).map((c) => ({ kind: 'model' as const, id: `provider:${c.id}`, label: c.label, hint: 'switch service', provider: c.id })),
    ...folderFiles.map((f) => ({ kind: 'file' as const, id: f, label: f, hint: 'attach from the open folder' })),
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
          {hfCode ? (
            <span>
              Enter <strong className="mono">{hfCode.user_code}</strong> at{' '}
              <span className="mono">{hfCode.verification_uri}</span> (it opened in your browser). This finishes on its own.
            </span>
          ) : (
            <>
              <span>Hugging Face needs a sign-in. The token stays on this PC, in Windows Credential Manager.</span>
              <button className="primary" onClick={signInHf}>Sign in to Hugging Face</button>
            </>
          )}
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
                : (msg.providerLabel && msg.model ? `${msg.providerLabel} · ${msg.model}` : (msg.model || 'Assistant'))}
            </div>
            {msg.role === 'assistant'
              ? (msg.content
                ? <div className="message-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                : null)
              : msg.shell
                ? <pre className="message-content shell-output">{msg.shell}</pre>
                : <div className="message-content">{msg.content}</div>}
            {msg.role === 'assistant' && msg.tools && msg.tools.length > 0 && (
              <ToolCards events={msg.tools} expandAll={cardsOpen} onDecide={sending && i === active.messages.length - 1 ? decide : undefined} />
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
                  <button onClick={() => retry()} disabled={sending}>Retry {msg.model}</button>
                  {models.length > 1 && (
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
      {radial && (
        <RadialMenu
          x={radial.x}
          y={radial.y}
          items={radial.items}
          onClose={() => setRadial(null)}
        />
      )}
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
            {attached && (
              <div className="attach-chip">
                <span className="attach-label">
                  <Icon name="paperclip" size={13} /> Attached text · {attached.length.toLocaleString()} chars
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
