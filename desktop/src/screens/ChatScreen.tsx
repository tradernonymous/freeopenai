import { useState, useRef, useEffect, useCallback } from 'react';
import { api, streamChat, type StreamFrame } from '../api';
import { renderMarkdown } from '../markdown';
// UMD module: loaded for its side effect, read off globalThis.
import '../chats.js';

const chats: typeof import('../chats.js') = (globalThis as any).FreeAI4UChats;

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  ts?: number;
  error?: boolean;
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

interface ProviderRow {
  id: string;
  label: string;
  configured: boolean;
  kind?: string;
  freeTier?: any;
}

export default function ChatScreen() {
  // Parsed once. The active id is taken from the list this component already
  // loaded; the old code read and parsed localStorage a second time here.
  const [sessions, setSessions] = useState<ChatSession[]>(() => chats.readStore() as ChatSession[]);
  const [activeId, setActiveId] = useState<string>(() => sessions[0]?.id ?? '');
  const [providerRows, setProviderRows] = useState<ProviderRow[]>([]);
  const [models, setModels] = useState<Array<{ id: string; free?: string }>>([]);
  const [limits, setLimits] = useState<any>(null);
  const [sending, setSending] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [attached, setAttached] = useState<string>('');

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
    api.limits().then(setLimits).catch(() => setLimits(null));
  }, []);

  // models follow the provider
  useEffect(() => {
    if (!active?.provider) {
      setModels([]);
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
    const assistantMsg: Msg = { role: 'assistant', content: '', model: active.model, ts: Date.now() };
    const history = [...active.messages, userMsg];
    patchSession(active.id, {
      messages: [...history, assistantMsg],
      draft: '',
      title: active.messages.length === 0 ? text.slice(0, 48) : active.title,
    });
    setSending(true);
    setStreamError('');
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
      await streamChat(
        active.provider,
        { model: active.model, messages: history.map(({ role, content }) => ({ role, content })) },
        (frame: StreamFrame) => {
          if (frame.content) append(frame.content);
        },
        controller.signal,
      );
      // persist the finished transcript
      setSessions((prev) => { saveSessions(prev); return prev; });
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      const message = aborted ? 'Stopped.' : (err as Error).message || 'The reply failed.';
      setSessions((prev) => prev.map((s) => {
        if (s.id !== sid) return s;
        const msgs = s.messages.slice();
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') {
          msgs[msgs.length - 1] = { ...last, content: last.content || (aborted ? '' : message), error: !aborted };
          if (aborted && !last.content) msgs.pop();
        }
        return { ...s, messages: msgs, updatedAt: Date.now() };
      }));
      if (!aborted) setStreamError(message);
    } finally {
      setSending(false);
      abortRef.current = null;
      // one authoritative save with the final state
      setTimeout(() => setSessions((prev) => { saveSessions(prev); return prev; }), 0);
      inputRef.current?.focus();
    }
  };

  const stop = () => abortRef.current?.abort();

  const retry = async () => {
    if (!active || sending) return;
    const msgs = active.messages.slice();
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
    const lastUser = msgs[msgs.length - 1];
    if (!lastUser || lastUser.role !== 'user') return;
    patchSession(active.id, { messages: msgs });
    setSending(true);
    setStreamError('');
    const controller = new AbortController();
    abortRef.current = controller;
    const sid = active.id;
    setSessions((prev) => prev.map((s) => (s.id === sid
      ? { ...s, messages: [...msgs, { role: 'assistant', content: '', model: s.model, ts: Date.now() }], updatedAt: Date.now() }
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
      await streamChat(
        active.provider,
        { model: active.model, messages: msgs.map(({ role, content }) => ({ role, content })) },
        (frame) => { if (frame.content) append(frame.content); },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setStreamError((err as Error).message);
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
    setStreamError('');
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
      setStreamError((err as Error).message);
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
          <div className="empty-icon">💬</div>
          <h2>No chats yet</h2>
          <p>Starting one now…</p>
          <button className="primary" onClick={startNew}>New chat</button>
        </div>
      </div>
    );
  }

  const freeTierNote = limits?.retries?.budgetMs != null
    ? `rate-limit budget ${Math.round(limits.retries.budgetMs / 1000)}s`
    : '';

  return (
    <div className="screen chat">
      <header className="screen-header">
        <div className="mode-tabs">
          {(['chat', 'plan', 'build'] as const).map((m) => (
            <button key={m} className={`mode-tab ${active.mode === m ? 'active' : ''}`}
              onClick={() => patchSession(active.id, { mode: m })}>
              {m === 'chat' ? '💬 Chat' : m === 'plan' ? '🧭 Plan' : '🛠 Build'}
            </button>
          ))}
        </div>
        <div className="header-actions">
          <select className="model-select" value={active.provider}
            onChange={(e) => patchSession(active.id, { provider: e.target.value, model: '' })}
            title="Provider">
            {providerRows.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}{p.freeTier && p.freeTier.limitText ? ` · ${p.freeTier.limitText}` : ''}
              </option>
            ))}
            {providerRows.length === 0 && <option value="">no provider</option>}
          </select>
          <select className="model-select" value={active.model}
            onChange={(e) => patchSession(active.id, { model: e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.id}{m.free ? ` · ${m.free}` : ''}</option>
            ))}
            {models.length === 0 && <option value="">—</option>}
          </select>
          <button onClick={startNew} title="New chat">＋</button>
        </div>
      </header>

      <div className="chat-messages" ref={listRef} onScroll={onScroll} onClick={onMessagesClick}>
        {active.messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <h2>Start a conversation</h2>
            <p>Free models first, limits on the row. Plan drafts a plan; Build starts a real build session with approvals.</p>
          </div>
        )}
        {active.messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}${msg.error ? ' errored' : ''}`}>
            <div className="message-role">{msg.role === 'user' ? 'You' : (msg.model || 'Assistant')}</div>
            {msg.role === 'assistant'
              ? <div className="message-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
              : <div className="message-content">{msg.content}</div>}
          </div>
        ))}
        {sending && (
          <div className="message assistant">
            <div className="message-content typing">Thinking…</div>
          </div>
        )}
      </div>

      {(streamError || freeTierNote) && (
        <div className="stream-error">
          {streamError && (
            <>
              <span>{streamError}</span>
              <button onClick={retry}>Retry</button>
            </>
          )}
          {!streamError && <span className="limit-badge">{freeTierNote}</span>}
        </div>
      )}

      <div className="composer">
        {attached && (
          <div className="attach-chip">
            <span className="attach-label">📎 Attached text · {attached.length.toLocaleString()} chars</span>
            <button onClick={() => setAttached('')} title="Remove attachment">✕</button>
          </div>
        )}
        <div className="composer-row">
          {sending
            ? <button className="stop-btn" onClick={stop} title="Stop the reply">■ Stop</button>
            : null}
          <textarea
            ref={inputRef}
            value={active.draft}
            onChange={(e) => patchSession(active.id, { draft: e.target.value })}
            onKeyDown={onKey}
            placeholder={active.mode === 'build' ? 'Describe the build — this starts a remote build session…' : 'Message FreeAI4U…'}
            rows={1}
          />
          <button onClick={send} disabled={sending || !active.draft.trim()} className="send-btn">
            {sending ? '…' : '↑'}
          </button>
        </div>
      </div>
    </div>
  );
}
