import { useState, useEffect } from 'react';
import { api } from '../api';

interface Session {
  id: string;
  title?: string;
  createdAt: number;
  messageCount?: number;
}

export default function SessionManager() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    try {
      const data = await api.chat({ messages: [], model: '', stream: false });
      setSessions([]);
    } catch {
      setSessions([]);
    }
  };

  const filtered = sessions.filter((s) => !search || (s.title || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="session-manager">
      <div className="session-manager-header">
        <h3>History</h3>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sessions…"
        />
      </div>
      <div className="session-list">
        {filtered.map((s) => (
          <div key={s.id} className="session-item">
            <div className="session-title">{s.title || 'Untitled'}</div>
            <div className="session-meta">
              <span>{new Date(s.createdAt).toLocaleDateString()}</span>
              {s.messageCount != null && <span>{s.messageCount} msgs</span>}
            </div>
          </div>
        ))}
        {filtered.length === 0 && <div className="empty">No sessions yet</div>}
      </div>
    </div>
  );
}
