import { useState, useEffect } from 'react';
import { OPEN_CHAT_EVENT } from '../screens/ChatScreen';
import type { ChatSession } from '../screens/ChatScreen';

interface Props {
  onExport: () => void;
  onImport: (file: File) => void;
  importMsg: string;
}

/** History panel: the chats saved on this machine, newest first. */
export default function SessionManager({ onExport, onImport, importMsg }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('freeai4u.chats') || '[]');
      const rows: ChatSession[] = Array.isArray(raw) ? raw : [];
      rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      setSessions(rows);
    } catch { setSessions([]); }
  }, []);

  const filtered = sessions.filter((s) =>
    !search ||
    (s.title || '').toLowerCase().includes(search.toLowerCase()) ||
    s.messages.some((m) => m.content.toLowerCase().includes(search.toLowerCase())));

  return (
    <div className="session-manager">
      <div className="session-manager-header">
        <h3>History</h3>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats…" />
      </div>
      <div className="session-list">
        {filtered.map((s) => (
          <div key={s.id} className="session-item" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: s.id }))}>
            <div className="session-title">{s.title || 'Untitled'}</div>
            <div className="session-meta">
              <span>{new Date(s.updatedAt || Date.now()).toLocaleString()}</span>
              <span>{s.messages.length} msgs</span>
            </div>
          </div>
        ))}
        {filtered.length === 0 && <div className="empty">No chats match.</div>}
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
    </div>
  );
}
