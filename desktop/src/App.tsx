import { useState, useEffect, useCallback } from 'react';
import { api } from './api';
import Sidebar from './Sidebar';
import TitleBar from './TitleBar';
import ChatScreen from './screens/ChatScreen';
import DesignScreen from './screens/DesignScreen';
import ImagesScreen from './screens/ImagesScreen';
import BuildScreen from './screens/BuildScreen';
import LibraryScreen from './screens/LibraryScreen';
import FilesScreen from './screens/FilesScreen';
import SettingsScreen from './screens/SettingsScreen';
import FileTree from './components/FileTree';
import Terminal from './components/Terminal';
import SessionManager from './components/SessionManager';
import './index.css';
import { APP_VERSION } from './version';
// UMD modules load for their side effect and are picked up off globalThis.
import './update.js';
import './chats.js';

const update: typeof import('./update.js') = (globalThis as any).FreeAI4UUpdate;
const chats: typeof import('./chats.js') = (globalThis as any).FreeAI4UChats;

const DISMISSED_KEY = 'freeai4u.updateDismissed';

type View = 'chat' | 'design' | 'images' | 'build' | 'library' | 'files' | 'settings';
type RightPanel = 'builds' | 'knowledge' | 'none';

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [updateInfo, setUpdateInfo] = useState<import('./update.js').VersionPayload | null>(null);
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

  // The release publishes desktop-version.json (version + sha256 + size per
  // artifact). Reading that instead of guessing a version out of asset names
  // means a build-numbered or renamed file cannot misreport, and a DOWN-dated
  // release is not an update. The fetch retries with backoff, and a failure
  // leaves the banner hidden instead of throwing.
  useEffect(() => {
    let cancelled = false;
    const checkUpdate = async () => {
      const found = await update.fetchVersion({ fetchImpl: fetch });
      if (cancelled || !found || !update.isNewer(found.version, APP_VERSION)) return;
      try {
        if (localStorage.getItem(DISMISSED_KEY) === found.version) return;
      } catch { /* no storage: show it anyway */ }
      setUpdateInfo(found);
    };
    checkUpdate();
    const interval = setInterval(checkUpdate, 1000 * 60 * 60);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  const toggleRightPanel = (panel: RightPanel) => setRightPanel((prev) => (prev === panel ? 'none' : panel));

  // Alt+1..6 walks the sidebar in its displayed order.
  useEffect(() => {
    const order: View[] = ['chat', 'images', 'build', 'design', 'library', 'files', 'settings'];
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number.parseInt(e.key, 10);
      if (n >= 1 && n <= order.length && e.altKey) {
        e.preventDefault();
        setView(order[n - 1]);
      }
      if (e.altKey && e.key === 'f' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setView('files');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const gate = loginRequired === true && !signedIn;

  // The anchor is in the document for the click and the object URL is revoked
  // afterwards; both were skipped before.
  const exportChats = () => {
    const text = localStorage.getItem('freeai4u.chats') || '[]';
    setImportMsg(chats.downloadJson('freeai4u-chats.json', text)
      ? 'Exported freeai4u-chats.json.'
      : 'Export failed: this window has no download surface.');
  };

  // Validated entries, newest copy of each id wins, and the 60 kept are the 60
  // most recently updated -- so importing old chats can never evict the new.
  const importChats = (file: File) => {
    file.text().then((text) => {
      try {
        const incoming = JSON.parse(text);
        const list = Array.isArray(incoming) ? incoming : incoming?.sessions;
        if (!Array.isArray(list)) throw new Error('not a chat export');
        const raw = JSON.parse(localStorage.getItem('freeai4u.chats') || '[]');
        const result = chats.merge(raw, incoming, chats.MAX_SESSIONS);
        localStorage.setItem('freeai4u.chats', JSON.stringify(result.sessions));
        window.dispatchEvent(new CustomEvent(chats.CHATS_CHANGED_EVENT));
        setImportMsg(chats.summary(result));
      } catch (err) {
        setImportMsg('Import failed: ' + (err as Error).message);
      }
    });
  };

  const installer = update.installerFor(updateInfo);
  const dismissUpdate = () => {
    try {
      if (updateInfo) localStorage.setItem(DISMISSED_KEY, updateInfo.version);
    } catch { /* best effort */ }
    setUpdateInfo(null);
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
          {updateInfo && (
            <div className="update-banner">
              <span>Update available: v{updateInfo.version} (this build is v{APP_VERSION})</span>
              {installer && (
                <span className="update-meta"
                  title={installer.sha256 ? `sha256 ${installer.sha256}` : undefined}>
                  {installer.name}
                  {installer.size ? ` · ${update.humanSize(installer.size)}` : ''}
                </span>
              )}
              <a href={update.desktopUrl()} target="_blank" rel="noreferrer">
                Download
              </a>
              <button onClick={dismissUpdate}>✕</button>
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
                  {view === 'files' && <FilesScreen />}
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
