import { useState, useEffect, useCallback } from 'react';
import { api } from './api';
import Sidebar, { type NavId } from './Sidebar';
import TitleBar from './TitleBar';
import ChatScreen, { OPEN_CHAT_EVENT, NEW_CHAT_EVENT } from './screens/ChatScreen';
import DesignScreen from './screens/DesignScreen';
import ImagesScreen from './screens/ImagesScreen';
import BuildScreen from './screens/BuildScreen';
import LibraryScreen from './screens/LibraryScreen';
import FilesScreen from './screens/FilesScreen';
import SettingsScreen from './screens/SettingsScreen';
import ConnectScreen from './screens/ConnectScreen';
import LocalScreen from './screens/LocalScreen';
import LocalTree from './components/LocalTree';
import LocalTerminal from './components/LocalTerminal';
import SessionManager from './components/SessionManager';
import { hasShell, pickFolder } from './bridge';
import CommandPalette, { type PaletteEntry } from './components/CommandPalette';
import StatusBar from './components/StatusBar';
import Icon from './components/Icon';
import Toasts, { pushToast } from './components/Toasts';
import './index.css';
import { APP_VERSION } from './version';
import { applyTheme, readTheme, toggleTheme, type Theme } from './theme';
import { useUpdateCheck } from './useUpdateCheck';
// UMD modules load for their side effect and are picked up off globalThis.
import './chats.js';
import './connection.js';
import './onboarding.js';
import './commands.js';

const chats: typeof import('./chats.js') = (globalThis as any).FreeAI4UChats;
const connection: typeof import('./connection.js') = (globalThis as any).FreeAI4UConnection;
const onboarding: typeof import('./onboarding.js') = (globalThis as any).FreeAI4UOnboarding;
const chatCommands: typeof import('./commands.js') = (globalThis as any).FreeAI4UCommands;

type View = NavId;
type RightPanel = 'builds' | 'knowledge' | 'none';
type PanelKey = 'folder' | 'terminal' | 'sessions' | 'builds' | 'knowledge';

// The folder the local surfaces work in. One owner (this state), one key: the
// terminal dock and the Local screen both read it from here rather than each
// keeping their own idea of "the" folder.
const LOCAL_ROOT_KEY = 'freeai4u.localRoot';

function readLocalRoot(): string {
  try {
    return localStorage.getItem(LOCAL_ROOT_KEY) || '';
  } catch {
    return '';
  }
}

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [theme, setTheme] = useState<Theme>(readTheme);
  const {
    info: updateInfo,
    installer,
    dismiss: dismissUpdate,
    humanSize,
    releaseUrl,
    installState,
    installError,
    downloaded,
    install: installUpdate,
    checkNow,
  } = useUpdateCheck();
  const [showFolder, setShowFolder] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [rightPanel, setRightPanel] = useState<RightPanel>('none');
  const [localRoot, setLocalRoot] = useState<string>(readLocalRoot);
  const [localCwd, setLocalCwd] = useState('');
  // What the engine said, and how the shell should react to it. The decision
  // itself is onboarding.shellState (pure, tested); these are its inputs.
  const [health, setHealth] = useState<any>(null);
  const [outcome, setOutcome] = useState<import('./connection.js').ConnectionOutcome | null>(null);
  const [signedIn, setSignedIn] = useState<boolean>(false);
  const [importMsg, setImportMsg] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Zen is a mode, not a setting: it is deliberately not written to disk,
  // because the app should open looking the same way every time. Ctrl+Shift+Z
  // drops the chrome from anywhere; the peek pill brings it back.
  const [zen, setZen] = useState(false);
  const [paletteExtra, setPaletteExtra] = useState<PaletteEntry[]>([]);
  const [skillEntries, setSkillEntries] = useState<PaletteEntry[]>([]);

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

  // Skills the engine serves, so the palette can reach them by name too. A
  // failure here is not worth a message: the Library screen reports it.
  useEffect(() => {
    api.skills()
      .then((rows: any) => {
        const list = Array.isArray(rows) ? rows : [];
        setSkillEntries(list.slice(0, 40).map((s: any) => chatCommands.skillCommand(s)));
      })
      .catch(() => setSkillEntries([]));
  }, []);

  const toggle = () => setTheme((t) => toggleTheme(t));
  const toggleRightPanel = (panel: RightPanel) => setRightPanel((prev) => (prev === panel ? 'none' : panel));

  const panels: Record<PanelKey, boolean> = {
    folder: showFolder,
    terminal: showTerminal,
    sessions: showSessions,
    builds: rightPanel === 'builds',
    knowledge: rightPanel === 'knowledge',
  };

  const togglePanel = (key: PanelKey) => {
    if (key === 'folder') setShowFolder((v) => !v);
    else if (key === 'terminal') setShowTerminal((v) => !v);
    else if (key === 'sessions') setShowSessions((v) => !v);
    else toggleRightPanel(key);
  };

  // Choosing a folder is a native dialog through the shell; a browser build has
  // no picker, so it says so instead of failing quietly.
  const openFolder = useCallback(() => {
    if (!hasShell()) {
      pushToast('warn', 'Choosing a folder needs the installed desktop app.');
      return;
    }
    pickFolder()
      .then((chosen) => {
        if (!chosen) return;
        try {
          localStorage.setItem(LOCAL_ROOT_KEY, chosen);
        } catch { /* the session still has it */ }
        setLocalRoot(chosen);
        setShowFolder(true);
        pushToast('ok', `Working in ${chosen}`);
      })
      .catch((e: unknown) => pushToast('warn', (e as Error).message || String(e)));
  }, []);

  const showLocalTerminal = useCallback(() => {
    setView('local');
    setShowTerminal(true);
  }, []);

  // The palette's rows are read when it opens, so they are current: chats are
  // read from the one store, skills from what the engine served.
  const openPalette = useCallback(() => {
    const chatRows = chats.byRecency(chats.readStore()).slice(0, 20)
      .map((s: any) => chatCommands.chatCommand(s));
    setPaletteExtra([...chatRows, ...skillEntries]);
    setPaletteOpen(true);
  }, [skillEntries]);

  const runCommand = (entry: PaletteEntry) => {
    if (entry.palette) { setView(entry.palette as View); return; }
    if (entry.chat) {
      setView('chat');
      window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: entry.chat }));
      return;
    }
    if (entry.skill) { setView('library'); return; }
    switch (entry.id) {
      case 'new-chat':
        setView('chat');
        window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT));
        break;
      case 'toggle-zen':
        setZen((on) => !on);
        break;
      case 'toggle-theme':
        toggle();
        break;
      case 'open-folder':
        openFolder();
        break;
      case 'toggle-folder-panel':
      case 'toggle-terminal':
      case 'toggle-history':
      case 'toggle-approvals':
      case 'toggle-skills':
        togglePanel(
          entry.id === 'toggle-history' ? 'sessions'
            : entry.id === 'toggle-terminal' ? 'terminal'
              : entry.id === 'toggle-approvals' ? 'builds'
                : entry.id === 'toggle-skills' ? 'knowledge'
                  : 'folder',
        );
        break;
      case 'export-chats':
        exportChats();
        break;
      case 'check-updates':
        checkNow().then((result: 'update' | 'current' | 'unknown') => {
          if (result === 'update') pushToast('info', 'A newer build is available — see the banner at the top.');
          else if (result === 'current') pushToast('ok', 'This is the newest build.');
          else pushToast('warn', 'Could not reach the release page to check.');
        });
        break;
      default:
        break;
    }
  };

  // Zen has its own listener because it is a mode rather than a move: it has
  // to work from every screen, and from inside the palette itself, where the
  // other handler is already using the keyboard.
  useEffect(() => {
    const onZen = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        setZen((on) => !on);
      }
    };
    window.addEventListener('keydown', onZen);
    return () => window.removeEventListener('keydown', onZen);
  }, []);

  // Alt+1..7 walks the sidebar in its displayed order; Ctrl+K is the palette.
  useEffect(() => {
    const order: View[] = ['chat', 'images', 'build', 'local', 'design', 'library', 'files', 'settings'];
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (key === 'escape') {
        setPaletteOpen(false);
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number.parseInt(e.key, 10);
      if (n >= 1 && n <= order.length && e.altKey) {
        e.preventDefault();
        setView(order[n - 1]);
      }
      if (e.altKey && e.key === 'f') {
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
    const ok = chats.downloadJson('freeai4u-chats.json', text);
    setImportMsg(ok ? 'Exported freeai4u-chats.json.' : 'Export failed: this window has no download surface.');
    pushToast(ok ? 'ok' : 'warn', ok ? 'Exported freeai4u-chats.json.' : 'Export failed: this window has no download surface.');
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
        pushToast('ok', chats.summary(result));
      } catch (err) {
        setImportMsg('Import failed: ' + (err as Error).message);
        pushToast('error', 'Import failed: ' + (err as Error).message);
      }
    });
  };

  return (
    <div className={zen ? 'app zen' : 'app'}>
      <TitleBar onToggleTheme={toggle} theme={theme} />
      <div className="app-body">
        <Sidebar
          active={view}
          onNavigate={setView}
          onOpenPalette={openPalette}
          onTogglePanel={togglePanel}
          panels={panels}
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
              {/* In the shell this downloads, checks the published sha256 and runs
                  the installer; in a browser it opens the release page. Without the
                  first, the integrity data CI publishes could never be used. */}
              <button className="update-install" onClick={installUpdate} disabled={installState === 'downloading' || installState === 'installing'}>
                {installState === 'downloading' && 'Downloading…'}
                {installState === 'installing' && 'Installing…'}
                {installState === 'idle' && 'Download and install'}
                {installState === 'error' && 'Try again'}
              </button>
              <a href={releaseUrl} target="_blank" rel="noreferrer">
                Download manually
              </a>
              <button onClick={dismissUpdate} aria-label="Dismiss this update">
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          {banner && (
            <div className="server-banner">{banner}</div>
          )}
          {installState === 'error' && installError && (
            <div className="server-banner">Update failed: {installError}</div>
          )}
          {installState === 'installing' && downloaded && (
            <div className="server-banner">
              Installed {downloaded.name}{' '}
              {downloaded.verified ? '(sha256 verified)' : '(no digest published by the release)'}
            </div>
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
                  {view === 'local' && (
                    <LocalScreen
                      root={localRoot}
                      cwd={localCwd}
                      terminalOpen={showTerminal}
                      onOpenFolder={openFolder}
                      onShowTerminal={showLocalTerminal}
                    />
                  )}
                  {view === 'files' && <FilesScreen />}
                  {view === 'settings' && (
                    <SettingsScreen
                      onConnectionChanged={checkAuth}
                      diagnosticsState={shell.reason + (signedIn ? ' · signed in' : ' · signed out')}
                    />
                  )}
                </>
              )}
            </div>
            {rightPanel !== 'none' && (
              <aside className="right-panel">
                <div className="right-panel-header">
                  <h3>{rightPanel === 'builds' ? 'Builds' : 'Knowledge'}</h3>
                  <button onClick={() => setRightPanel('none')} aria-label="Close panel">
                    <Icon name="close" size={14} />
                  </button>
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
        {/* The docks are mounted whether or not they are shown: a terminal that
            forgets its scrollback the moment you look at Chat is not a dock.
            The folder tree is cheap to re-read, so it is not kept. */}
        {showFolder && localRoot && (
          <LocalTree root={localRoot} onOpenFile={() => setView('local')} onOpenFolder={openFolder} />
        )}
        <div className={showTerminal ? 'dock-slot' : 'dock-slot dock-hidden'}>
          <LocalTerminal
            root={localRoot}
            cwd={localCwd}
            onCwdChange={setLocalCwd}
            onOpenFolder={openFolder}
          />
        </div>
        {showSessions && (
          <SessionManager
            onExport={exportChats}
            onImport={importChats}
            importMsg={importMsg}
          />
        )}
      </div>
      <StatusBar
        engine={api.getServer()}
        // The actionable state, not just the reachable one: an engine that
        // answers "healthy" while refusing every call wants a sign-in, and that
        // is what the bar should say.
        state={shell.reason === 'signed-out' ? 'signed-out' : (outcome ? outcome.kind : 'checking')}
        signedIn={signedIn}
        updateAvailable={updateInfo?.version}
        onOpenPalette={openPalette}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        extra={paletteExtra}
        onRun={runCommand}
      />
      {zen && (
        <button
          className="zen-peek"
          onClick={() => setZen(false)}
          title="Leave Zen mode (Ctrl+Shift+Z)"
        >
          <Icon name="close" size={12} />
          Leave Zen
        </button>
      )}
      <Toasts />
    </div>
  );
}
