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

const NAV_ITEMS: Array<{ id: NavId; label: string; icon: IconName; keys: string }> = [
  { id: 'chat', label: 'Chat', icon: 'chat', keys: 'Alt+1' },
  { id: 'images', label: 'Images', icon: 'image', keys: 'Alt+2' },
  { id: 'build', label: 'Builds', icon: 'build', keys: 'Alt+3' },
  { id: 'local', label: 'Local', icon: 'terminal', keys: 'Alt+4' },
  { id: 'design', label: 'Design', icon: 'design', keys: 'Alt+5' },
  { id: 'library', label: 'Library', icon: 'library', keys: 'Alt+6' },
  { id: 'files', label: 'Files', icon: 'folder', keys: 'Alt+F' },
  { id: 'settings', label: 'Settings', icon: 'settings', keys: 'Alt+7' },
];

const PANEL_ITEMS: Array<{ key: 'folder' | 'terminal' | 'sessions' | 'builds' | 'knowledge'; label: string; icon: IconName; title: string }> = [
  { key: 'folder', label: 'Folder', icon: 'folder', title: 'Files in the folder you opened' },
  { key: 'terminal', label: 'Terminal', icon: 'terminal', title: 'Commands on this machine' },
  { key: 'sessions', label: 'History', icon: 'history', title: 'Saved chats' },
  { key: 'builds', label: 'Approvals', icon: 'check', title: 'Pending build approvals' },
  { key: 'knowledge', label: 'Skills', icon: 'skills', title: 'Skills and memory' },
];

export type NavId = 'chat' | 'images' | 'build' | 'local' | 'design' | 'library' | 'files' | 'settings';

export interface PanelKeyMap {
  folder: boolean;
  terminal: boolean;
  sessions: boolean;
  builds: boolean;
  knowledge: boolean;
}

export type PanelId = keyof PanelKeyMap;

interface SidebarProps {
  active: NavId;
  onNavigate: (id: NavId) => void;
  onOpenPalette: () => void;
  onTogglePanel: (key: PanelId) => void;
  panels: Partial<PanelKeyMap>;
}

export default function Sidebar({ active, onNavigate, onOpenPalette, onTogglePanel, panels }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">AI</div>
        <span className="sidebar-title">FreeAI4U</span>
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
            className={`sidebar-btn ${active === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
            title={`${item.label} — ${item.keys}`}
            aria-current={active === item.id ? 'page' : undefined}
          >
            <Icon name={item.icon} />
            <span className="sidebar-label">{item.label}</span>
            <span className="sidebar-keys">{item.keys}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-divider" />
      <div className="sidebar-group-label">Panels</div>
      <nav className="sidebar-nav" aria-label="Panels">
        {PANEL_ITEMS.map((item) => (
          <button
            key={item.key}
            className={`sidebar-btn ${panels[item.key] ? 'active' : ''}`}
            onClick={() => onTogglePanel(item.key)}
            title={item.title}
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
