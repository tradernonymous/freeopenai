import { useEffect, useRef, useState } from 'react';
import { streamChat } from '../api';
import { mainShow, onQuickSelection, quickHide, quickTakeSelection } from '../bridge';
import { renderMarkdown } from '../markdown';
import Icon from '../components/Icon';
import { isSavedProvider, streamSaved } from '../run-model';
import '../chats.js';
import '../hf-auth.js';
import '../hf-inference.js';

const chats: typeof import('../chats.js') = (globalThis as any).FreeAI4UChats;
const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;
const hfInference: typeof import('../hf-inference.js') = (globalThis as any).FreeAI4UHfInference;

/** The main window watches this key (a `storage` event) to open the handed-over chat. */
export const QUICK_HANDOFF_KEY = 'freeai4u.quickHandoff';

/** What the selection toolbar offers for text picked up from another app. */
export const SELECTION_ACTIONS: Array<{ id: string; label: string; prompt: string }> = [
  { id: 'explain', label: 'Explain', prompt: 'Explain this simply and briefly:' },
  { id: 'summarise', label: 'Summarise', prompt: 'Summarise this in a few bullet points:' },
  { id: 'translate', label: 'Translate', prompt: 'Translate this to English (or, if it is already English, to Malay). Reply with the translation only:' },
  { id: 'rewrite', label: 'Rewrite', prompt: 'Rewrite this to be clearer and more concise, keeping its meaning. Reply with the rewrite only:' },
];

// The Quick window: Alt+Space from anywhere (remappable in Settings ->
// Shortcuts). One question, one streamed answer, on the model the most recent
// chat uses. Esc hides it; "Continue in NeuraOS" turns the exchange into a
// real chat in the main window, where tools, history and everything else are.

export default function QuickAsk() {
  const recent = chats.byRecency(chats.readStore())[0] as any;
  const provider: string = recent?.provider || '';
  const model: string = recent?.model || '';
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Text the selection hotkey copied out of another app, awaiting an action.
  const [selection, setSelection] = useState('');

  useEffect(() => {
    document.body.classList.add('quick-body');
    const focus = () => box.current?.focus();
    focus();
    window.addEventListener('focus', focus);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (abort.current) abort.current.abort();
        else quickHide();
      }
    };
    window.addEventListener('keydown', onKey);
    // The selection hotkey leaves its text with the shell; take it when the
    // window opens and whenever the hotkey fires while it is already open.
    const take = () => {
      quickTakeSelection().then((text) => {
        if (text === null || text === undefined) return;
        if (!text) { setError('Nothing was selected. Select some text in any app, then press the selection hotkey again.'); return; }
        setError('');
        setSelection(text);
      }).catch(() => {});
    };
    take();
    let unlisten: (() => void) | null = null;
    onQuickSelection(take).then((off) => { unlisten = off; }).catch(() => {});
    return () => {
      window.removeEventListener('focus', focus);
      window.removeEventListener('keydown', onKey);
      unlisten?.();
    };
  }, []);

  const ask = async (override?: string) => {
    const text = (override ?? question).trim();
    if (!text || busy) return;
    if (!provider || !model) {
      setError('Pick a model in a chat in the main window first; Quick uses the one your latest chat uses.');
      return;
    }
    setBusy(true);
    setError('');
    setAsked(text);
    setAnswer('');
    setQuestion('');
    const controller = new AbortController();
    abort.current = controller;
    // An action on a selection sends the selected text with it; the chat shows
    // (and a hand-off keeps) the instruction plus the text.
    const content = override && selection ? `${text}\n\n---\n${selection}\n---` : text;
    if (override && selection) setAsked(content);
    const messages = [{ role: 'user', content }];
    const onFrame = (frame: { content?: string }) => { if (frame.content) setAnswer((a) => a + frame.content); };
    try {
      if (isSavedProvider(provider)) await streamSaved(provider, model, messages, onFrame, controller.signal);
      else if (provider === 'hf') await hfInference.streamChat(model, messages, onFrame, controller.signal, hfAuth.accessToken()?.access_token || undefined);
      else await streamChat(provider, { model, messages }, onFrame, controller.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(((e as Error).message || String(e)).split('\n')[0]);
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const handOff = () => {
    const now = Date.now();
    const session = {
      id: 'c' + now.toString(36) + Math.random().toString(36).slice(2, 7),
      title: asked.slice(0, 48) || 'Quick question',
      messages: [
        { role: 'user', content: asked, ts: now },
        { role: 'assistant', content: answer, model, provider, ts: now },
      ],
      provider,
      model,
      mode: 'chat',
      draft: '',
      updatedAt: now,
    };
    chats.writeStore(null, [session, ...chats.readStore()].slice(0, chats.MAX_SESSIONS));
    try { localStorage.setItem(QUICK_HANDOFF_KEY, JSON.stringify({ id: session.id, ts: now })); } catch { /* the chat is saved either way */ }
    mainShow().then(() => quickHide());
    setAsked('');
    setAnswer('');
  };

  return (
    <div className="quick">
      <div className="quick-head">
        <span className="quick-brand">NeuraOS</span>
        <span className="quick-model mono">{model || 'no model yet'}</span>
        <button className="linkish" onClick={() => quickHide()} title="Hide (Esc)" aria-label="Hide"><Icon name="close" size={13} /></button>
      </div>
      {(asked || answer) && (
        <div className="quick-answer">
          <div className="quick-q">{asked}</div>
          {answer
            ? <div className="message-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(answer) }} />
            : <div className="typing shimmer">Thinking…</div>}
        </div>
      )}
      {selection && (
        <div className="quick-selection">
          <div className="quick-selection-text" title={selection}>{selection.length > 400 ? `${selection.slice(0, 400)}…` : selection}</div>
          <div className="quick-selection-actions">
            {SELECTION_ACTIONS.map((a) => (
              <button key={a.id} onClick={() => ask(a.prompt)} disabled={busy}>{a.label}</button>
            ))}
            <button className="linkish" onClick={() => setSelection('')} aria-label="Clear the selected text">Clear</button>
          </div>
        </div>
      )}
      {error && <div className="chip-note" role="alert">{error}</div>}
      <div className="quick-box">
        <textarea
          ref={box}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (selection && question.trim()) ask(question); else ask(); } }}
          placeholder={selection ? 'Ask about the selected text — Enter sends' : 'Ask anything — Enter sends, Esc hides'}
          rows={2}
          aria-label="Quick question"
        />
        <button className="send-btn" onClick={busy ? () => abort.current?.abort() : () => (selection && question.trim() ? ask(question) : ask())} disabled={!busy && !question.trim()} aria-label={busy ? 'Stop' : 'Send'}>
          <Icon name={busy ? 'stop' : 'arrow-up'} size={busy ? 12 : 16} />
        </button>
      </div>
      {answer && !busy && (
        <button className="quick-continue" onClick={handOff}>Continue in NeuraOS <Icon name="chevron-right" size={12} /></button>
      )}
    </div>
  );
}
