import { useState, useRef, useEffect, useCallback } from 'react';
import { api, streamChat, streamLocalChat, type StreamFrame } from '../api';
import { hasShell, localModelStatus } from '../bridge';
import { renderMarkdown } from '../markdown';
import Icon from '../components/Icon';
import ModelPicker from '../components/ModelPicker';
import ModePicker from '../components/ModePicker';
// UMD modules: loaded for their side effect, read off globalThis.
import RadialMenu, { type RadialItem } from '../components/RadialMenu';
import { pushToast } from '../components/Toasts';
import '../chats.js';
import '../failure.js';
import '../fallback.js';
import '../local-models.js';

const chats: typeof import('../chats.js') = (globalThis as any).FreeAI4UChats;
const failure: typeof import('../failure.js') = (globalThis as any).FreeAI4UFailure;
const fallback: typeof import('../fallback.js') = (globalThis as any).FreeAI4UFallback;
const localModels: typeof import('../local-models.js') = (globalThis as any).FreeAI4ULocalModels;

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

function saveSessions(sessions: ChatSession[]) {
  chats.writeStore(null, sessions);
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
  const choices = localRow && !providerRows.some((p) => p.id === 'local')
    ? [localRow, ...providerRows]
    : providerRows;
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
  }, [active?.provider, active?.id]);

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
      const turns = history.map(({ role, content }) => ({ role, content }));
      if (active.provider === 'local') {
        await streamLocalChat(localRow?.baseUrl || '', active.model, turns, (frame: StreamFrame) => {
          if (frame.content) append(frame.content);
        }, controller.signal);
      } else {
        await streamChat(active.provider, { model: active.model, messages: turns }, (frame: StreamFrame) => {
          if (frame.content) append(frame.content);
        }, controller.signal);
      }
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
      const turns = msgs.map(({ role, content }) => ({ role, content }));
      if (provider === 'local') {
        await streamLocalChat(localRow?.baseUrl || '', model, turns, (frame) => {
          if (frame.content) append(frame.content);
        }, controller.signal);
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

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
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
    ];
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

  return (
    <div className="screen chat">
      <header className="screen-header">
        {/* One pill, not three tabs: the mode is a property of the next
            message, so it reads as a setting rather than as navigation. */}
        <ModePicker
          mode={active.mode}
          onPick={(m) => patchSession(active.id, { mode: m })}
          disabled={sending}
        />
        <div className="header-actions">
          {/* One pill, not two dropdowns: the service and the model are one
              decision, and the pill names both without being read as a pair. */}
          <ModelPicker
            providers={choices}
            models={models}
            provider={active.provider}
            model={active.model}
            onPick={(provider, model) => patchSession(active.id, { provider, model })}
            disabled={sending}
          />
          <button onClick={startNew} title="New chat" aria-label="New chat"><Icon name="plus" size={15} /></button>
        </div>
      </header>

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
          <div key={i} className={`message ${msg.role}${msg.error ? ' errored' : ''}`}>
            <div className="message-role">
              {msg.role === 'user'
                ? 'You'
                : (msg.providerLabel && msg.model ? `${msg.providerLabel} · ${msg.model}` : (msg.model || 'Assistant'))}
            </div>
            {msg.role === 'assistant'
              ? (msg.content
                ? <div className="message-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                : null)
              : <div className="message-content">{msg.content}</div>}
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
            <div className="message-content typing">Thinking…</div>
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
      <div className="composer">
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
        <div className="composer-row">
          {sending
            ? <button className="stop-btn" onClick={stop} title="Stop the reply"><Icon name="stop" size={12} /> Stop</button>
            : null}
          {/* The free tier's own numbers, as a quiet fact beside the box rather
              than a warning bar: a limit working as intended is not a fault. */}
          {freeTierNote && (
            <span className="composer-note" title="What this service's free tier meters">
              {freeTierNote}
            </span>
          )}
          <textarea
            ref={inputRef}
            value={active.draft}
            onChange={(e) => patchSession(active.id, { draft: e.target.value })}
            onKeyDown={onKey}
            placeholder={active.mode === 'build' ? 'Describe the build — this starts a remote build session…' : 'Message NeuraOS…'}
            rows={1}
          />
          <button onClick={send} disabled={sending || !active.draft.trim()} className="send-btn">
            {sending ? '…' : <Icon name="arrow-up" size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
