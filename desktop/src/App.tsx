import { useState, useEffect, useLayoutEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { api } from './api';
import Sidebar, { destinationOf, navForKey, navKeys, tabsOf, NAVIGATE_EVENT, type NavId, type ViewId } from './Sidebar';
import TitleBar from './TitleBar';
import ChatScreen, { OPEN_CHAT_EVENT, NEW_CHAT_EVENT, MODEL_PICK_EVENT, TOOL_CARDS_EVENT, PENDING_COMMAND_KEY, RUN_COMMAND_EVENT } from './screens/ChatScreen';
import SettingsScreen from './screens/SettingsScreen';
import ConnectScreen from './screens/ConnectScreen';
import LocalScreen from './screens/LocalScreen';
import CodeScreen from './screens/CodeScreen';
// The schedulers run on every start, so they are eager; the screens they
// belong to are not (schedulers.ts fetches them only when something is due).
import { useRecipeScheduler, useEvalScheduler } from './schedulers';
import LocalTree from './components/LocalTree';
import LocalTerminal from './components/LocalTerminal';
import SessionManager from './components/SessionManager';
import Workbench from './components/Workbench';
import './workbench.js';
import { chatStoreBackend, chatStoreSetAside, onAppQuitting, quitReady, hasShell, launchTakePath, onDeepLink, onOpenPath, pickFolder, quickHotkeySet, secretDelete, secretGet, secretSet, selectionHotkeySet } from './bridge';
import { QUICK_HANDOFF_KEY } from './screens/QuickAsk';
import { QUICK_HOTKEY_KEY, SELECTION_HOTKEY_KEY } from './components/ShortcutsCard';
import { PENDING_MODEL_EVENT, PENDING_MODEL_KEY } from './components/LocalModelsCard';
import './hf-auth.js';
import './local-models.js';
import './saved-models.js';

const hfAuth: typeof import('./hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;
const localModels: typeof import('./local-models.js') = (globalThis as any).FreeAI4ULocalModels;
import CommandPalette, { type PaletteEntry } from './components/CommandPalette';
import StatusBar from './components/StatusBar';
import Icon from './components/Icon';
import Toasts, { pushToast } from './components/Toasts';
import './index.css';
import { APP_VERSION } from './version';
import { applyTheme, readTheme, toggleTheme, useParallax, type Theme } from './theme';
import { useUpdateCheck } from './useUpdateCheck';
// UMD modules load for their side effect and are picked up off globalThis.
import './chats.js';
import './connection.js';
import './onboarding.js';
import './commands.js';
import '../../shared/keymap.js';
import './diagnostics.js';

const chats: typeof import('./chats.js') = (globalThis as any).FreeAI4UChats;
const connection: typeof import('./connection.js') = (globalThis as any).FreeAI4UConnection;
const onboarding: typeof import('./onboarding.js') = (globalThis as any).FreeAI4UOnboarding;
const chatCommands: typeof import('./commands.js') = (globalThis as any).FreeAI4UCommands;
const keymap: typeof import('../../shared/keymap.js') = (globalThis as any).FreeAI4UKeymap;
const diagnostics: typeof import('./diagnostics.js') = (globalThis as any).FreeAI4UDiagnostics;
// The rails' memory: which of the two is pinned, and which tool the right one
// is showing. The rules are in workbench.js so the damaged-storage cases are
// tested without a DOM; this file only holds the answers in state.
const rails: typeof import('./workbench.js') = (globalThis as any).FreeAI4UWorkbench;

// Chat is the default view and stays in the first bundle. The heavy screens
// are fetched the first time they are opened, so the window paints sooner.
const DesignScreen = lazy(() => import('./screens/DesignScreen'));
const ImagesScreen = lazy(() => import('./screens/ImagesScreen'));
const BuildScreen = lazy(() => import('./screens/BuildScreen'));
const LibraryScreen = lazy(() => import('./screens/LibraryScreen'));
const FilesScreen = lazy(() => import('./screens/FilesScreen'));
const EvalsScreen = lazy(() => import('./screens/EvalsScreen'));
const AgentsScreen = lazy(() => import('./screens/AgentsScreen'));
const RecipesScreen = lazy(() => import('./screens/RecipesScreen'));
const ParallelScreen = lazy(() => import('./screens/ParallelScreen'));

/** What a lazy screen shows for the moment its chunk is on its way. */
function ScreenSkeleton() {
  return (
    <div className="screen screen-skeleton" aria-busy="true" aria-label="Loading">
      <div className="skeleton-bar skeleton-title" />
      <div className="skeleton-bar" />
      <div className="skeleton-bar skeleton-short" />
    </div>
  );
}

type View = ViewId;
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
    checkError,
    installNotice,
  } = useUpdateCheck();
  const [showFolder, setShowFolder] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [rightPanel, setRightPanel] = useState<RightPanel>('none');
  // Both rails peek open on hover; a pin keeps one open and takes it out of
  // overlay, which is a decision about the workspace and so survives a restart.
  const [leftPinned, setLeftPinned] = useState(() => rails.readPinned(rails.LEFT_KEY));
  const [rightPinned, setRightPinned] = useState(() => rails.readPinned(rails.RIGHT_KEY));
  const [tool, setTool] = useState(() => rails.readTool());
  const [localRoot, setLocalRoot] = useState<string>(readLocalRoot);
  const [localCwd, setLocalCwd] = useState('');
  // What the engine said, and how the shell should react to it. The decision
  // itself is onboarding.shellState (pure, tested); these are its inputs.
  const [health, setHealth] = useState<any>(null);
  const [outcome, setOutcome] = useState<import('./connection.js').ConnectionOutcome | null>(null);
  const [signedIn, setSignedIn] = useState<boolean>(false);
  const [importMsg, setImportMsg] = useState('');
  const [chatRecovery, setChatRecovery] = useState<import('./chats.js').ChatRecovery | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Zen is a mode, not a setting: it is deliberately not written to disk,
  // because the app should open looking the same way every time. Ctrl+Shift+Z
  // drops the chrome from anywhere; the peek pill brings it back.
  const [zen, setZen] = useState(false);
  const [paletteExtra, setPaletteExtra] = useState<PaletteEntry[]>([]);
  const [skillEntries, setSkillEntries] = useState<PaletteEntry[]>([]);
  // Scheduled recipes run while the app is open, whatever screen is showing.
  useRecipeScheduler();
  useEvalScheduler();
  // The ambient layer's <=6px drift toward the pointer; off under reduced motion.
  useParallax();
  // Cold-start marks (NEURA-035, reported in Settings → Diagnostics). Layout
  // effects run right after React's first commit; "chat ready" is the first
  // frame after paint with Chat's composer in the DOM. Both are set once.
  useLayoutEffect(() => { diagnostics.markStartup('first-commit'); }, []);
  useEffect(() => {
    if (view !== 'chat') return undefined;
    let frame = 0;
    let tries = 0;
    const probe = () => {
      if (document.querySelector('.composer-box textarea')) { diagnostics.markStartup('chat-ready'); return; }
      if (++tries < 300) frame = requestAnimationFrame(probe);
    };
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(probe); });
    return () => cancelAnimationFrame(frame);
  }, [view]);

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

  // Under the shell the Hugging Face token lives in the OS credential store,
  // not localStorage: point hf-auth at it and read it in (moving a plain-text
  // token over on the first run). Screens hear AUTH_CHANGED_EVENT when it lands.
  useEffect(() => {
    if (!hasShell()) return;
    hfAuth.configureStore({
      get: (key: string) => secretGet(key),
      set: (key: string, value: string) => secretSet(key, value),
      remove: (key: string) => secretDelete(key),
    });
    hfAuth.hydrate().catch(() => { /* not signed in is a normal state */ });
    // Chat history: the encrypted SQLite store (chats.js, chat_store.rs). A key
    // that cannot open the stored chats asks what to do (NEURA-022).
    chats.hydrate(chatStoreBackend, {
      onNotice: (text: string) => pushToast('warn', text),
      onRecovery: (plan) => setChatRecovery(plan),
    });
    // The tray Quit waits (up to ~800 ms) for this: send the edits the 400 ms
    // debounce still holds, then let the shell exit (NEURA-021).
    let stopQuit = () => {};
    onAppQuitting(() => {
      chats.flush().catch(() => false).finally(() => { quitReady().catch(() => {}); });
    }).then((unsubscribe) => { stopQuit = unsubscribe; });
    return () => stopQuit();
  }, []);

  const answerChatRecovery = (choice: import('./chats.js').ChatRecoveryChoice) => {
    setChatRecovery(null);
    chats.recover(choice, { setAside: chatStoreSetAside, backend: chatStoreBackend })
      .then((result) => {
        if (choice !== 'start-fresh') return;
        if (result.mode === 'shell') {
          pushToast('ok', `Started a new encrypted chat history. The old file is kept as ${result.movedTo || 'chats.unreadable-<time>.sqlite3'}.`);
        } else {
          pushToast('warn', `The old file was set aside, but the new store did not open (${result.error || 'unknown'}); chats stay in browser storage.`);
        }
      })
      .catch((err: unknown) => {
        setChatRecovery(chats.recovery());
        pushToast('error', `Could not set the old chat file aside: ${(err as Error)?.message || String(err)}. Nothing was changed.`);
      });
  };

  // neuraos://model?repo=...&file=... -- from a Hugging Face "Use this model"
  // entry once NeuraOS is listed there, or the app's own bookmarklet. Nothing
  // is downloaded on the strength of a link: Settings opens with the model
  // looked up and the person clicks Download.
  useEffect(() => {
    if (!hasShell()) return;
    let stop = () => {};
    onDeepLink((urls) => {
      for (const url of urls) {
        const ref = localModels.parseHfRef(url);
        if (!ref) continue;
        try { localStorage.setItem(PENDING_MODEL_KEY, JSON.stringify(ref)); } catch { /* best effort */ }
        setView('settings');
        window.dispatchEvent(new Event(PENDING_MODEL_EVENT));
        return;
      }
    }).then((unsubscribe) => { stop = unsubscribe; });
    return () => stop();
  }, []);

  // Opened WITH something (5.4): a .gguf joins My models; a folder becomes the
  // working folder. A first launch asks the shell once; a second launch sends
  // an event. Either way the person sees where it went.
  useEffect(() => {
    if (!hasShell()) return;
    const open = (path: string) => {
      if (!path) return;
      if (/\.gguf$/i.test(path)) {
        const saved = (globalThis as any).FreeAI4USavedModels?.add({ kind: 'unsloth', path });
        setView('settings');
        pushToast(saved?.ok ? 'ok' : 'warn', saved?.ok ? `${saved.added ? 'Added' : 'Already in'} My models: ${path.split(/[\\/]/).pop()}` : (saved?.reason || 'That model could not be added.'));
        return;
      }
      try { localStorage.setItem(LOCAL_ROOT_KEY, path); } catch { /* the session still has it */ }
      setLocalRoot(path);
      setShowFolder(true);
      setView('local');
      pushToast('ok', `Working in ${path}`);
    };
    launchTakePath().then((p) => { if (p) open(p); }).catch(() => {});
    let stop = () => {};
    onOpenPath(open).then((unsubscribe) => { stop = unsubscribe; }).catch(() => {});
    return () => stop();
  }, []);

  // The Quick window hands a finished exchange over as a saved chat and this
  // key; the main window opens it. A remapped global hotkey is re-taken at
  // start (the shell registers the default before the frontend exists).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== QUICK_HANDOFF_KEY || !e.newValue) return;
      try {
        const { id } = JSON.parse(e.newValue);
        window.dispatchEvent(new CustomEvent(chats.CHATS_CHANGED_EVENT));
        setView('chat');
        setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: id })), 50);
      } catch { /* a malformed hand-off is ignored */ }
    };
    window.addEventListener('storage', onStorage);
    if (hasShell()) {
      let stored = '';
      try { stored = localStorage.getItem(QUICK_HOTKEY_KEY) || ''; } catch { /* default */ }
      if (stored) quickHotkeySet(stored).catch(() => pushToast('warn', `The Quick hotkey ${stored} is taken by another app; change it in Settings -> Shortcuts.`));
      let selection = '';
      try { selection = localStorage.getItem(SELECTION_HOTKEY_KEY) || ''; } catch { /* default */ }
      if (selection) selectionHotkeySet(selection.toLowerCase()).catch(() => pushToast('warn', `The selection hotkey ${selection} is taken by another app; change it in Settings -> Shortcuts.`));
    }
    return () => window.removeEventListener('storage', onStorage);
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

  // A destination remembers which of its tabs was open last, so Alt+2 goes
  // back to Local if Local is where you were, not always to the agent.
  const lastTab = useRef<Partial<Record<NavId, ViewId>>>({});
  useEffect(() => { lastTab.current[destinationOf(view)] = view; }, [view]);
  const navigate = useCallback((to: ViewId) => {
    const isDestination = tabsOf(to as NavId).length > 0 && destinationOf(to) === to;
    setView(isDestination ? (lastTab.current[to as NavId] || to) : to);
  }, []);

  // The composer's /history, /settings, /design... ask the shell to move.
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.view) setView(detail.view as View);
      if (detail.panel === 'sessions') setShowSessions((v) => !v);
    };
    window.addEventListener(NAVIGATE_EVENT, onNav);
    return () => window.removeEventListener(NAVIGATE_EVENT, onNav);
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

  const toggleLeftRail = useCallback(() => {
    setLeftPinned((on) => {
      rails.writePinned(rails.LEFT_KEY, !on);
      return !on;
    });
  }, []);

  const toggleRightRail = useCallback(() => {
    setRightPinned((on) => {
      rails.writePinned(rails.RIGHT_KEY, !on);
      return !on;
    });
  }, []);

  const pickTool = useCallback((id: import('./workbench.js').ToolId) => {
    rails.writeTool(id);
    setTool(id);
  }, []);

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
    // A palette entry that names a chat command ("Generate a picture" ->
    // /image) hands it to Chat the way Agents and Recipes already do: it waits
    // in sessionStorage and Chat picks it up once mounted. Checked before
    // `palette`, because these entries also name Chat as their screen and the
    // early return below would otherwise open Chat and fill in nothing.
    if (entry.command) {
      setView('chat');
      try { sessionStorage.setItem(PENDING_COMMAND_KEY, entry.command); } catch { /* Chat opens; the person types it */ }
      setTimeout(() => window.dispatchEvent(new Event(RUN_COMMAND_EVENT)), 50);
      return;
    }
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
        // A person asked, so a version they dismissed earlier is still reported.
        checkNow(true).then((result: 'update' | 'current' | 'unknown') => {
          if (result === 'update') pushToast('info', 'A newer build is available — see the banner at the top.');
          else if (result === 'current') pushToast('ok', 'This is the newest build.');
          else pushToast('warn', 'Could not reach the release page to check.');
        });
        break;
      default:
        break;
    }
  };

  // Every app-wide key goes through ONE table (shared/keymap.js): the resolver
  // decides what a press means -- priority, the "shortcuts off" switch, the
  // palette being open -- and this only acts on the answer. Alt+N is resolved
  // from the sidebar's own list (navForKey), so the rail and the key agree.
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = paletteOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = keymap.resolveKey({
        enabled: keymap.enabled(),
        paletteOpen: paletteOpenRef.current,
        bindings: keymap.withOverrides(keymap.readOverrides()),
        nav: (e) => navForKey(e.key),
      }, e);
      if (!hit) return;
      // Escape is shared with the composer and menus: close, never swallow.
      if (hit.action === 'escape') { setPaletteOpen(false); return; }
      e.preventDefault();
      switch (hit.action) {
        case 'palette': setPaletteOpen((open) => !open); break;
        case 'zen': setZen((on) => !on); break;
        case 'new-chat':
          setView('chat');
          window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT));
          break;
        case 'model':
          setView('chat');
          window.dispatchEvent(new CustomEvent(MODEL_PICK_EVENT));
          break;
        case 'tool-cards': window.dispatchEvent(new CustomEvent(TOOL_CARDS_EVENT)); break;
        case 'history': setShowSessions((v) => !v); break;
        case 'terminal': setShowTerminal((v) => !v); break;
        case 'nav': if (hit.to) navigate(hit.to as ViewId); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

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
          onNavigate={navigate}
          onOpenPalette={openPalette}
          onTogglePanel={togglePanel}
          panels={panels}
          pinned={leftPinned}
          onTogglePin={toggleLeftRail}
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
                {installState === 'saved' && 'Saved'}
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
          {chatRecovery && (
            <div className="server-banner chat-recovery" role="alert">
              <span>{chatRecovery.text}</span>
              {chatRecovery.actions.map((action) => (
                <button key={action.id} type="button" onClick={() => answerChatRecovery(action.id)}>
                  {action.label}
                </button>
              ))}
            </div>
          )}
          {installState === 'error' && installError && (
            <div className="server-banner">Update failed: {installError}</div>
          )}
          {installState === 'saved' && installNotice && (
            <div className="server-banner">
              {installNotice}{' '}
              {downloaded?.verified ? '(sha256 verified)' : '(no digest published by the release)'}
            </div>
          )}
          {installState === 'installing' && downloaded && (
            <div className="server-banner">
              Installed {downloaded.name}{' '}
              {downloaded.verified ? '(sha256 verified)' : '(no digest published by the release)'}
            </div>
          )}
          <div className="main-content">
            <div className="primary-pane">
              {/* A destination with more than one view shows them as tabs --
                  the screens that used to be separate rail rows. */}
              {!showConnect && tabsOf(destinationOf(view)).length > 1 && (
                <div className="sub-nav" role="tablist" aria-label="Views">
                  {tabsOf(destinationOf(view)).map((tab) => (
                    <button
                      key={tab.id}
                      role="tab"
                      aria-selected={view === tab.id}
                      className={`sub-nav-tab ${view === tab.id ? 'active' : ''}`}
                      onClick={() => setView(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}
              {showConnect ? (
                <ConnectScreen
                  reason={shell.reason}
                  onConnected={checkAuth}
                  onOpenSettings={() => setView('settings')}
                />
              ) : (
                <Suspense fallback={<ScreenSkeleton />}>
                  {view === 'chat' && <ChatScreen />}
                  {view === 'code' && <CodeScreen localRoot={localRoot} />}
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
                  {view === 'evals' && <EvalsScreen />}
                  {view === 'agents' && <AgentsScreen />}
                  {view === 'recipes' && <RecipesScreen />}
                  {view === 'parallel' && <ParallelScreen localRoot={localRoot} />}
                  {view === 'settings' && (
                    <SettingsScreen
                      onConnectionChanged={checkAuth}
                      diagnosticsState={shell.reason + (signedIn ? ' · signed in' : ' · signed out')}
                    />
                  )}
                </Suspense>
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
        {/* The right rail is a sibling of the floor, not a child of it: unpinned
            it overlays, and the stylesheet gives the floor a rail's margin so
            nothing ends up underneath. It is mounted whatever the centre column
            is showing, so the floor never changes width under the pointer. */}
        <Workbench
          tool={tool}
          onPickTool={pickTool}
          pinned={rightPinned}
          onTogglePin={toggleRightRail}
          localRoot={localRoot}
          onOpenFolder={openFolder}
          onOpenFile={() => setView('local')}
          onOpenScreen={navigate}
        />
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
        // The palette's check, lifted into an always-visible button: a manual
        // check (dismissed versions are reported) and the banner's install flow.
        onCheckUpdates={() => checkNow(true)}
        checkError={checkError}
        onInstallUpdate={installUpdate}
        installState={installState}
        installError={installError}
        installNotice={installNotice}
        onOpenPalette={openPalette}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        extra={paletteExtra}
        keys={navKeys()}
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
