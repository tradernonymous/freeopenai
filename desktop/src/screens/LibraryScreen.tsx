import { useState, useEffect } from 'react';
import { api } from '../api';
import { OPEN_CHAT_EVENT, type ChatSession } from './ChatScreen';

interface Skill {
  source: string;
  name: string;
  description: string;
}

/** Library: the engine's skill catalogue plus the chats saved on this machine. */
export default function LibraryScreen() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [open, setOpen] = useState<Skill | null>(null);
  const [content, setContent] = useState<string>('');
  const [error, setError] = useState('');
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    setError('');
    api.skills()
      .then((rows: any) => setSkills(Array.isArray(rows) ? rows : []))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
    try {
      setChats(JSON.parse(localStorage.getItem('freeai4u.chats') || '[]'));
    } catch { setChats([]); }
  };

  useEffect(() => { load(); }, []);

  const show = (s: Skill) => {
    setOpen(s);
    setContent('Loading…');
    api.skillContent(s.name)
      .then((data: any) => setContent(typeof data === 'string' ? data : data.content || data.body || JSON.stringify(data)))
      .catch((err) => setContent('Could not load: ' + (err as Error).message));
  };

  const openChat = (id: string) => window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: id }));

  return (
    <div className="screen library">
      <header className="screen-header">
        <h1>Library</h1>
        <div className="header-actions">
          <button onClick={load} disabled={loading}>{loading ? '…' : '↻ Refresh'}</button>
        </div>
      </header>

      <div className="library-layout">
        <section className="library-col">
          <h3 className="col-title">Skills on this engine ({skills.length})</h3>
          {error && <div className="stream-error">{error}</div>}
          <div className="skill-list">
            {skills.map((s) => (
              <button key={s.source + '/' + s.name} className={`skill-item ${open?.name === s.name ? 'active' : ''}`} onClick={() => show(s)}>
                <div className="skill-name">{s.name}</div>
                <div className="skill-desc">{s.description}</div>
                <div className="skill-src">{s.source}</div>
              </button>
            ))}
            {!skills.length && !loading && <div className="empty">No skills reported yet — refresh once the engine is reachable.</div>}
          </div>
        </section>

        <section className="library-col">
          {open ? (
            <>
              <h3 className="col-title">{open.name}</h3>
              <pre className="skill-content">{content}</pre>
            </>
          ) : (
            <>
              <h3 className="col-title">Chats on this machine ({chats.length})</h3>
              <div className="skill-list">
                {chats.map((c) => (
                  <button key={c.id} className="skill-item" onClick={() => openChat(c.id)}>
                    <div className="skill-name">{c.title || 'Untitled'}</div>
                    <div className="skill-src">{c.messages.length} messages · {new Date(c.updatedAt).toLocaleString()}</div>
                  </button>
                ))}
                {!chats.length && <div className="empty">Chats you start appear here, saved on this device only.</div>}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
