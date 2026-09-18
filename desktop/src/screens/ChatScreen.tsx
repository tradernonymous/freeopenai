import { useState, useRef, useEffect } from 'react';
import { api } from '../api';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  ts?: number;
}

export default function ChatScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState<string>('');
  const [models, setModels] = useState<string[]>([]);
  const [limits, setLimits] = useState<Record<string, any>>({});
  const [sending, setSending] = useState(false);
  const [skills, setSkills] = useState<string[]>([]);
  const [mode, setMode] = useState<'chat' | 'plan' | 'build'>('chat');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.models().then((m: any) => {
      const list = Array.isArray(m) ? m.map((x: any) => x.id || x) : [];
      setModels(list);
      if (list.length) setModel(list[0]);
    });
    api.limits().then((l: any) => setLimits(l || {}));
    api.skills().then((s: any) => setSkills(Array.isArray(s) ? s.map((x: any) => x.id || x.name || x) : []));
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    const userMsg: Message = { role: 'user', content: text, ts: Date.now() };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const stream = mode === 'build' ? 'build' : mode === 'plan' ? 'plan' : 'chat';
      await api.chat({
        messages: [...messages, userMsg].map(({ role, content }) => ({ role, content })),
        model,
        stream: true,
        mode: stream,
        skills,
      });
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${(e as Error).message}`, ts: Date.now() }]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="screen chat">
      <header className="screen-header">
        <div className="mode-tabs">
          {(['chat', 'plan', 'build'] as const).map((m) => (
            <button key={m} className={`mode-tab ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
              {m === 'chat' ? '💬 Chat' : m === 'plan' ? '🧭 Plan' : '🛠 Build'}
            </button>
          ))}
        </div>
        <div className="header-actions">
          <select value={model} onChange={(e) => setModel(e.target.value)} className="model-select">
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <h2>Start a conversation</h2>
            <p>Send a message to begin. Use Plan or Build mode for structured work.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <div className="message-role">{msg.role === 'user' ? 'You' : msg.model || 'Assistant'}</div>
            <div className="message-content">{msg.content}</div>
          </div>
        ))}
        {sending && <div className="message assistant"><div className="message-content typing">Thinking…</div></div>}
      </div>

      <div className="composer">
        <div className="composer-meta">
          {skills.length > 0 && (
            <div className="chips">
              {skills.map((s) => (
                <span key={s} className="chip">
                  {s}
                </span>
              ))}
            </div>
          )}
          {limits.freeTier && <span className="limit-badge">Free tier active</span>}
        </div>
        <div className="composer-row">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Message FreeAI4U…"
            rows={1}
          />
          <button onClick={send} disabled={sending || !input.trim()} className="send-btn">
            {sending ? '…' : '↑'}
          </button>
        </div>
      </div>
    </div>
  );
}
