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
import ConnectScreen from './screens/ConnectScreen';
import FileTree from './components/FileTree';
import Terminal from './components/Terminal';
import SessionManager from './components/SessionManager';
import './index.css';
import { APP_VERSION } from './version';
import { applyTheme, readTheme, toggleTheme, type Theme } from './theme';
import { useUpdateCheck } from './useUpdateCheck';
// UMD modules load for their side effect and are picked up off globalThis.
import './chats.js';
import './connection.js';
import './onboarding.js';

const chats: typeof import('./chats.js') = (globalThis as any).FreeAI4UChats;
const connection: typeof import('./connection.js') = (globalThis as any).FreeAI4UConnection;
const onboarding: typeof import('./onboarding.js') = (globalThis as any).FreeAI4UOnboarding;

type View = 'chat' | 'design' | 'images' | 'build' | 'library' | 'files' | 'settings';
type RightPanel = 'builds' | 'knowledge' | 'none';

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [theme, setTheme] = useState<Theme>(readTheme);
  const { info: updateInfo, installer, dismiss: dismissUpdate, humanSize, releaseUrl } = useUpdateCheck();
  const [showFiles, setShowFiles] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [rightPanel, setRightPanel] = useState<RightPanel>('none');
  // What the engine said, and how the shell should react to it. The decision
  // itself is onboarding.shellState (pure, tested); these are its inputs.
  const [health, setHealth] = useState<any>(null);
  const [outcome, setOutcome] = useState<import('./connection.js').ConnectionOutcome | null>(null);
  const [signedIn, setSignedIn] = useState<boolean>(false);
  const [importMsg, setImportMsg] = useState('');

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // One probe decides everything the shell shows. A failure is classified, not
  // collapsed: "the engine wants a login" and "the engine never answered" are
  // different states with different surfaces, and they used to look identical.
  const checkAuth = useCallback(() => {
    api.health()
      .then((h: any) => {
        setHealth(h);
        setOutcome(connection.classify({ status: 200 }));
        if (h && h.loginRequired) {
          return api.session()
            .then((s: any) => setSignedIn(!!(s && s.gate && s.user)))
            .catch(() => setSignedIn(false));
        }
        setSignedIn(true);
        return null;
      })
      .catch((err) => {
        setHealth(null);
        setSignedIn(false);
        setOutcome(connection.classify({ error: err, origin: api.getServer() }));
      });
  }, []);

  useEffect(() => {
    checkAuth();
    // A 401 anywhere in the app means the session went away: re-probe rather
    // than trusting a stale "signed in".
    const onAuth = () => checkAuth();
    window.addEventListener('auth-required', onAuth);
    return () => window.removeEventListener('auth-required', onAuth);
  }, [checkAuth]);

  const toggle = () => setTheme((t) => toggleTheme(t));
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

  // The shell's screen decision: show the way in when the user can act on it,
  // otherwise the app. Settings stays reachable from the connect surface, since
  // it is where a power user expects the address and sign-in to live too.
  const shell = onboarding.shellState({
    outcome,
    health,
    signedIn,
    serverSaved: api.serverSaved(),
  });
  const showConnect = shell.surface === 'connect' && view !== 'settings';
  const banner: string | null =
    shell.surface === 'app' && shell.bannerKind ? connection.bannerFor(shell.bannerKind) : null;

  // The anchor is in the document for the click and the object URL is revoked
  // afterwards; both were skipped before.
  const exportChats = () => {
    const text = JSON.stringify(chats.readStore());
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
        const result = chats.merge(chats.readStore(), incoming, chats.MAX_SESSIONS);
        chats.writeStore(null, result.sessions);
        window.dispatchEvent(new CustomEvent(chats.CHATS_CHANGED_EVENT));
        setImportMsg(chats.summary(result));
      } catch (err) {
        setImportMsg('Import failed: ' + (err as Error).message);
      }
    });
  };

  return (
    <div className="app">
      <TitleBar onToggleTheme={toggle} theme={theme} />
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
                  {installer.size ? ` · ${humanSize(installer.size)}` : ''}
                </span>
              )}
              <a href={releaseUrl} target="_blank" rel="noreferrer">
                Download
              </a>
              <button onClick={dismissUpdate}>✕</button>
            </div>
          )}
          {banner && (
            <div className="server-banner">{banner}</div>
          )}
          <div className="main-content">
            <div className="primary-pane">
              {showConnect ? (
                <ConnectScreen
                  reason={shell.reason}
                  onConnected={checkAuth}
                  onOpenSettings={() => setView('settings')}
                />
              ) : (
                <>
                  {view === 'chat' && <ChatScreen />}
                  {view === 'design' && <DesignScreen />}
                  {view === 'images' && <ImagesScreen />}
                  {view === 'build' && <BuildScreen />}
                  {view === 'library' && <LibraryScreen />}
                  {view === 'files' && <FilesScreen />}
                  {view === 'settings' && <SettingsScreen onConnectionChanged={checkAuth} />}
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
