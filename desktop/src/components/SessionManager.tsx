import { useState, useEffect } from 'react';
import { OPEN_CHAT_EVENT } from '../screens/ChatScreen';
import type { ChatSession } from '../screens/ChatScreen';
import Icon from './Icon';
// UMD modules: loaded for their side effect, read off globalThis. The history this
// panel shows is the chat store's, not a second parse of localStorage.
import '../chats.js';
import '../threads.js';

const chats: typeof import('../chats.js') = (globalThis as any).FreeAI4UChats;
const threads: typeof import('../threads.js') = (globalThis as any).FreeAI4UThreads;

// Which chats are generating right now. Kept at module level and listened for
// from the moment the app loads, so a panel opened mid-reply still spins.
const busy = new Set<string>();
if (typeof window !== 'undefined') {
  window.addEventListener(threads.ACTIVITY_EVENT, (e) => {
    const { id, busy: on } = (e as CustomEvent).detail || {};
    if (!id) return;
    if (on) busy.add(id); else busy.delete(id);
  });
}

interface Props {
  onExport: () => void;
  onImport: (file: File) => void;
  importMsg: string;
}

/**
 * History as a thread sidebar: pinned chats, folders, then everything else;
 * a spinner on chats that are still answering; a hover card with the last
 * message. It redraws whenever the chat store is saved.
 */
export default function SessionManager({ onExport, onImport, importMsg }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [meta, setMeta] = useState(() => threads.readMeta());
  const [search, setSearch] = useState('');
  const [, setTick] = useState(0);
  const [filing, setFiling] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    const load = () => setSessions(chats.readStore() as ChatSession[]);
    const spin = () => setTick((t) => t + 1);
    load();
    window.addEventListener(threads.CHANGED_EVENT, load);
    window.addEventListener(threads.ACTIVITY_EVENT, spin);
    return () => {
      window.removeEventListener(threads.CHANGED_EVENT, load);
      window.removeEventListener(threads.ACTIVITY_EVENT, spin);
    };
  }, []);

  const update = (next: import('../threads.js').ThreadMeta) => {
    threads.writeMeta(next);
    setMeta(next);
  };

  const fileUnder = () => {
    if (!filing) return;
    update(threads.setFolder(meta, filing.id, filing.name));
    setFiling(null);
  };

  const groups = threads.sections(sessions, meta, search);
  const folders = threads.folderNames(meta);

  return (
    <div className="session-manager">
      <div className="session-manager-header">
        <h3>History</h3>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats…" aria-label="Search chats" />
      </div>
      <div className="session-list">
        {groups.map((group) => (
          <section key={group.key} className="thread-group">
            {group.title && <div className="thread-group-title">{group.title}</div>}
            {group.items.map((s) => {
              const pinned = meta.pinned.includes(s.id);
              return (
                <div key={s.id} className="session-item thread-item">
                  <button
                    className="thread-open"
                    onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: s.id }))}
                    aria-describedby={`thread-preview-${s.id}`}
                  >
                    <span className="session-title">
                      {busy.has(s.id) && <span className="thread-spinner" role="status" aria-label="Answering" />}
                      {s.title || 'Untitled'}
                    </span>
                    <span className="session-meta">
                      <span>{new Date(s.updatedAt || Date.now()).toLocaleString()}</span>
                      <span>{s.messages.length} msgs</span>
                    </span>
                  </button>
                  <div className="thread-preview" id={`thread-preview-${s.id}`} role="tooltip">{threads.preview(s)}</div>
                  <div className="thread-actions">
                    <button onClick={() => update(threads.togglePin(meta, s.id))} title={pinned ? 'Unpin' : 'Pin to the top'} aria-pressed={pinned} aria-label={pinned ? 'Unpin' : 'Pin'}>
                      <Icon name={pinned ? 'check' : 'plus'} size={12} />
                    </button>
                    <button onClick={() => setFiling({ id: s.id, name: meta.folders[s.id] || '' })} title="Move to a folder" aria-label="Move to a folder">
                      <Icon name="folder" size={12} />
                    </button>
                  </div>
                  {filing?.id === s.id && (
                    <form className="thread-filing" onSubmit={(e) => { e.preventDefault(); fileUnder(); }}>
                      <input
                        autoFocus
                        value={filing.name}
                        onChange={(e) => setFiling({ id: s.id, name: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Escape') setFiling(null); }}
                        placeholder="Folder name (empty = none)"
                        list="thread-folders"
                        aria-label="Folder name"
                      />
                      <button type="submit">Move</button>
                    </form>
                  )}
                </div>
              );
            })}
          </section>
        ))}
        {groups.length === 0 && <div className="empty">No chats match.</div>}
        <datalist id="thread-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
      </div>
      <div className="session-manager-footer">
        <button onClick={onExport}>Export</button>
        <label className="import-label">
          Import
          <input type="file" accept="application/json" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); }} />
        </label>
      </div>
      {importMsg && <div className="sidebar-hint">{importMsg}</div>}
      {/* NEURA-022: the encrypted history opens only with the key in this PC's
          credential store; an export is the copy that survives losing it. */}
      {chats.persistent() && (
        <div className="sidebar-hint export-hint">
          Tip: Export now and then. Saved chats are encrypted with a key kept in this PC&apos;s credential store;
          if that key is lost, an export is the copy you can still import.
        </div>
      )}
    </div>
  );
}
