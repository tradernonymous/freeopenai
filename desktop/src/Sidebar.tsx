// The sidebar. It used to be twelve flat buttons whose icons were emoji
// (💬 🖼 🛠 …), which render differently on every Windows build, cannot be
// aligned or sized, and made the app look unfinished at a glance. Now every row
// is the same 24x24 stroke icon at the same weight as its label.
//
// The four-second hint that used to appear down here is gone: feedback belongs
// in the toast queue (src/toasts.js), where it can be read, dismissed and
// announced.
//
// The panels used to advertise the ENGINE's workspace and terminal, two things
// that mostly refuse to work (they need WORKSPACE_RUN=1 and a login on the
// server). Folder and Terminal are now the local ones -- real files on this
// machine, which is what a desktop app should answer for -- and the engine's
// two live under Settings → Advanced, labelled for what they are.
import Icon, { type IconName } from './components/Icon';
import { APP_VERSION } from './version';

// The ONE list of destinations and their keys. App.tsx resolves Alt+N from it,
// the command palette shows its keys, and test/desktop-shortcuts.test.js holds
// README.md and docs/desktop.md to it -- three places used to disagree.
//
// Five, not nine: the screens that overlapped now live inside a destination as
// its tabs (SUB_VIEWS). Chat holds Builds; Code holds the local folder and the
// Files generator; Library holds Images. Nothing was removed -- every view is
// still one Ctrl+K away and keeps its own screen.
export const NAV_ITEMS: Array<{ id: NavId; label: string; icon: IconName; keys: string }> = [
  { id: 'chat', label: 'Chat', icon: 'chat', keys: 'Alt+1' },
  { id: 'code', label: 'Code', icon: 'terminal', keys: 'Alt+2' },
  { id: 'design', label: 'Design', icon: 'design', keys: 'Alt+3' },
  { id: 'library', label: 'Library', icon: 'library', keys: 'Alt+4' },
  { id: 'settings', label: 'Settings', icon: 'settings', keys: 'Alt+5' },
];

/** Every view, and the destination whose tab strip it sits in. */
export const SUB_VIEWS: Array<{ id: ViewId; label: string; parent: NavId }> = [
  { id: 'chat', label: 'Chat', parent: 'chat' },
  { id: 'build', label: 'Builds', parent: 'chat' },
  { id: 'code', label: 'Agent', parent: 'code' },
  { id: 'local', label: 'Local', parent: 'code' },
  { id: 'files', label: 'Files', parent: 'code' },
  { id: 'parallel', label: 'Parallel', parent: 'code' },
  { id: 'design', label: 'Design', parent: 'design' },
  { id: 'library', label: 'Library', parent: 'library' },
  { id: 'images', label: 'Images', parent: 'library' },
  { id: 'evals', label: 'Evals', parent: 'library' },
  { id: 'agents', label: 'Agents', parent: 'library' },
  { id: 'recipes', label: 'Recipes', parent: 'library' },
  { id: 'settings', label: 'Settings', parent: 'settings' },
];

/** Anything can ask the shell to move: detail { view?: ViewId, panel?: 'sessions' }. */
export const NAVIGATE_EVENT = 'freeai4u:navigate';

/** The destination a view belongs to. */
export function destinationOf(view: ViewId): NavId {
  return SUB_VIEWS.find((v) => v.id === view)?.parent || 'chat';
}

/** The tabs a destination shows; one tab means no strip. */
export function tabsOf(destination: NavId): Array<{ id: ViewId; label: string }> {
  return SUB_VIEWS.filter((v) => v.parent === destination);
}

const PANEL_ITEMS: Array<{ key: 'folder' | 'terminal' | 'sessions' | 'builds' | 'knowledge'; label: string; icon: IconName; title: string }> = [
  { key: 'folder', label: 'Folder', icon: 'folder', title: 'Files in the folder you opened' },
  { key: 'terminal', label: 'Terminal', icon: 'terminal', title: 'Commands on this machine' },
  { key: 'sessions', label: 'History', icon: 'history', title: 'Saved chats' },
  { key: 'builds', label: 'Approvals', icon: 'check', title: 'Pending build approvals' },
  { key: 'knowledge', label: 'Skills', icon: 'skills', title: 'Skills and memory' },
];

/** The {view: 'Alt+N'} map the palette is handed. */
export function navKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of NAV_ITEMS) out[item.id] = item.keys;
  return out;
}

/** The destination a key press names, or null. `Alt+5` -> 'settings'. */
export function navForKey(key: string): NavId | null {
  const wanted = `Alt+${String(key || '').toUpperCase()}`;
  const hit = NAV_ITEMS.find((item) => item.keys.toUpperCase() === wanted);
  return hit ? hit.id : null;
}

export type NavId = 'chat' | 'code' | 'design' | 'library' | 'settings';
/** A view: a destination, or one of the tabs inside one. */
export type ViewId = NavId | 'build' | 'local' | 'files' | 'images' | 'evals' | 'agents' | 'recipes' | 'parallel';

export interface PanelKeyMap {
  folder: boolean;
  terminal: boolean;
  sessions: boolean;
  builds: boolean;
  knowledge: boolean;
}

export type PanelId = keyof PanelKeyMap;

interface SidebarProps {
  active: ViewId;
  onNavigate: (id: ViewId) => void;
  onOpenPalette: () => void;
  onTogglePanel: (key: PanelId) => void;
  panels: Partial<PanelKeyMap>;
}

// The name is the product's, not the engine's: this is NeuraOS, and the engine
// it talks to is still the FreeAI4U server. The crate, the binary, the bundle
// identifier and the localStorage keys all keep their freeai4u-* spelling, so
// an existing install updates in place and existing chats and settings survive
// the rename.
export default function Sidebar({ active, onNavigate, onOpenPalette, onTogglePanel, panels }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">N</div>
        <span className="sidebar-title">NeuraOS</span>
      </div>

      <button className="sidebar-search" type="button" onClick={onOpenPalette}>
        <Icon name="search" size={14} />
        <span>Search or run a command</span>
        <kbd>Ctrl+K</kbd>
      </button>

      <nav className="sidebar-nav" aria-label="Screens">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`sidebar-btn ${destinationOf(active) === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
            title={`${item.label} — ${item.keys}`}
            aria-current={destinationOf(active) === item.id ? 'page' : undefined}
          >
            <Icon name={item.icon} />
            <span className="sidebar-label">{item.label}</span>
            <span className="sidebar-keys">{item.keys}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-divider" />
      {/* The docks are toggles, not places: a quiet row of icons, each also on
          the keyboard (Ctrl+H history, Ctrl+` terminal) and in Ctrl+K. */}
      <nav className="sidebar-nav sidebar-panels" aria-label="Panels">
        {PANEL_ITEMS.map((item) => (
          <button
            key={item.key}
            className={`sidebar-btn sidebar-panel-btn ${panels[item.key] ? 'active' : ''}`}
            onClick={() => onTogglePanel(item.key)}
            title={`${item.label} — ${item.title}`}
            aria-label={item.label}
            aria-pressed={!!panels[item.key]}
          >
            <Icon name={item.icon} />
            <span className="sidebar-label">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <span className="sidebar-version" title="FreeAI4U Desktop">v{APP_VERSION}</span>
      </div>
    </aside>
  );
}
