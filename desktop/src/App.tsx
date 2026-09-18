import { useState, useEffect, useCallback } from 'react';
import { api } from './api';
import Sidebar from './Sidebar';
import TitleBar from './TitleBar';
import ChatScreen from './screens/ChatScreen';
import DesignScreen from './screens/DesignScreen';
import ImagesScreen from './screens/ImagesScreen';
import BuildScreen from './screens/BuildScreen';
import LibraryScreen from './screens/LibraryScreen';
import SettingsScreen from './screens/SettingsScreen';
import FileTree from './components/FileTree';
import Terminal from './components/Terminal';
import SessionManager from './components/SessionManager';
import './index.css';
import { APP_VERSION } from './version';

type View = 'chat' | 'design' | 'images' | 'build' | 'library' | 'settings';
type RightPanel = 'builds' | 'knowledge' | 'none';

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [rightPanel, setRightPanel] = useState<RightPanel>('none');
  const [loginRequired, setLoginRequired] = useState<boolean | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | false>(false);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [importMsg, setImportMsg] = useState('');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('freeai4u-theme', theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('freeai4u-theme') as 'light' | 'dark' | null;
      if (saved) setTheme(saved);
    } catch {}
  }, []);

  const checkAuth = useCallback(() => {
    api.health()
      .then((h: any) => {
        setServerOk(!!h?.ok);
        const required = !!(h && h.loginRequired);
        setLoginRequired(required);
        if (!required) return null;
        return api.session().then((s: any) => setSignedIn(!!(s && s.gate && s.user)));
      })
      .catch(() => setServerOk(false));
  }, []);

  useEffect(() => {
    checkAuth();
    const onAuth = () => setSignedIn(false);
    window.addEventListener('auth-required', onAuth);
    return () => window.removeEventListener('auth-required', onAuth);
  }, [checkAuth]);

  // Re-check the gate when the user returns from Settings (server may have changed).
  useEffect(() => {
    if (view === 'settings') checkAuth();
  }, [view, checkAuth]);

  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const res = await fetch('https://api.github.com/repos/tradernonymous/freeopenai/releases/tags/desktop-latest');
        if (!res.ok) return;
        const data = await res.json();
        // The tag is 'desktop-latest' (a moving label), so the version has
        // to come from the asset names themselves: FreeAI4U.Desktop_2.1.1_x64-setup.exe.
        const assets: string[] = (data.assets || []).map((a: any) => String(a.name || ''));
        const m = assets.join(' ').match(/(\d+\.\d+\.\d+)/);
        if (m && m[1] !== APP_VERSION) setUpdateAvailable(true);
      } catch {}
    };
    checkUpdate();
    const interval = setInterval(checkUpdate, 1000 * 60 * 60);
    return () => clearInterval(interval);
  }, []);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  const toggleRightPanel = (panel: RightPanel) => setRightPanel((prev) => (prev === panel ? 'none' : panel));

  // Alt+1..6 walks the sidebar in its displayed order.
  useEffect(() => {
    const order: View[] = ['chat', 'images', 'build', 'design', 'library', 'settings'];
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number.parseInt(e.key, 10);
      if (n >= 1 && n <= order.length) {
        e.preventDefault();
        setView(order[n - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const gate = loginRequired === true && !signedIn;

  const exportChats = () => {
    const blob = new Blob([localStorage.getItem('freeai4u.chats') || '[]'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'freeai4u-chats.json';
    a.click();
  };

  const importChats = (file: File) => {
    file.text().then((text) => {
      try {
        const incoming = JSON.parse(text);
        if (!Array.isArray(incoming)) throw new Error('not a chat export');
        const raw = JSON.parse(localStorage.getItem('freeai4u.chats') || '[]');
        const byId = new Map<string, any>();
        for (const s of [...raw, ...incoming]) if (s && s.id) byId.set(s.id, s);
        localStorage.setItem('freeai4u.chats', JSON.stringify(byId.size ? [...byId.values()].slice(-60) : []));
        setImportMsg('Imported. Open the Library to see them.');
      } catch (err) {
        setImportMsg('Import failed: ' + (err as Error).message);
      }
    });
  };

  return (
    <div className="app">
      <TitleBar onToggleTheme={toggleTheme} theme={theme} />
      <div className="app-body">
        <Sidebar
          active={view}
          onNavigate={setView}
          onToggleFiles={() => setShowFiles((v) => !v)}
          onToggleTerminal={() => setShowTerminal((v) => !v)}
          onToggleSessions={() => setShowSessions((v) => !v)}
          onToggleBuilds={() => toggleRightPanel('builds')}
          onToggleKnowledge={() => toggleRightPanel('knowledge')}
          showFiles={showFiles}
          showTerminal={showTerminal}
          showSessions={showSessions}
          showBuilds={rightPanel === 'builds'}
          showKnowledge={rightPanel === 'knowledge'}
        />
        <main className="main">
          {updateAvailable && (
            <div className="update-banner">
              <span>Update available</span>
              <a href="https://github.com/tradernonymous/freeopenai/releases/tag/desktop-latest" target="_blank" rel="noreferrer">
                Download
              </a>
              <button onClick={() => setUpdateAvailable(false)}>✕</button>
            </div>
          )}
          {serverOk === false && (
            <div className="server-banner">
              Cannot reach the engine right now — check the address in Settings.
            </div>
          )}
          <div className="main-content">
            <div className="primary-pane">
              {gate ? (
                <div className="empty-state" style={{ height: '100%' }}>
                  <div className="empty-icon">🔒</div>
                  <h2>Sign-in required</h2>
                  <p>This engine asks for a login. Sign in once in Settings — the session is kept in this window's profile.</p>
                  <button className="primary" onClick={() => setView('settings')}>Open Settings to sign in</button>
                </div>
              ) : (
                <>
                  {view === 'chat' && <ChatScreen />}
                  {view === 'design' && <DesignScreen />}
                  {view === 'images' && <ImagesScreen />}
                  {view === 'build' && <BuildScreen />}
                  {view === 'library' && <LibraryScreen />}
                  {view === 'settings' && <SettingsScreen />}
                </>
              )}
            </div>
            {rightPanel !== 'none' && (
              <aside className="right-panel">
                <div className="right-panel-header">
                  <h3>{rightPanel === 'builds' ? 'Builds' : 'Knowledge'}</h3>
                  <button onClick={() => setRightPanel('none')}>✕</button>
                </div>
                <div className="right-panel-body">
                  {rightPanel === 'builds' && (
                    <div className="empty">
                      Live build approvals dock here. Open <strong>Builds</strong> in the sidebar for the full view —
                      starting a build from Chat mode lands its approvals here too.
                    </div>
                  )}
                  {rightPanel === 'knowledge' && (
                    <div className="empty">
                      Skills and memory. Open <strong>Library</strong> for the full catalogue.
                    </div>
                  )}
                </div>
              </aside>
            )}
          </div>
        </main>
        {showFiles && <FileTree />}
        {showTerminal && <Terminal />}
        {showSessions && (
          <SessionManager
            onExport={exportChats}
            onImport={importChats}
            importMsg={importMsg}
          />
        )}
      </div>
    </div>
  );
}
