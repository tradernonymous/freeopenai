import { useState } from 'react';

const NAV_ITEMS = [
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'design', label: 'Design', icon: '🎨' },
  { id: 'build', label: 'Build', icon: '🛠' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
] as const;

type NavId = typeof NAV_ITEMS[number]['id'];

interface SidebarProps {
  active: NavId;
  onNavigate: (id: NavId) => void;
  onToggleFiles: () => void;
  onToggleTerminal: () => void;
  onToggleSessions: () => void;
  onToggleBuilds: () => void;
  onToggleKnowledge: () => void;
  showFiles: boolean;
  showTerminal: boolean;
  showSessions: boolean;
  showBuilds: boolean;
  showKnowledge: boolean;
}

export default function Sidebar({ active, onNavigate, onToggleFiles, onToggleTerminal, onToggleSessions, onToggleBuilds, onToggleKnowledge, showFiles, showTerminal, showSessions, showBuilds, showKnowledge }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">AI</div>
        <span className="sidebar-title">FreeAI4U</span>
      </div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`sidebar-btn ${active === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
            title={item.label}
          >
            <span className="sidebar-icon">{item.icon}</span>
            <span className="sidebar-label">{item.label}</span>
          </button>
        ))}
        <div className="sidebar-divider" />
        <button
          className={`sidebar-btn ${showFiles ? 'active' : ''}`}
          onClick={onToggleFiles}
          title="Workspace"
        >
          <span className="sidebar-icon">📂</span>
          <span className="sidebar-label">Workspace</span>
        </button>
        <button
          className={`sidebar-btn ${showTerminal ? 'active' : ''}`}
          onClick={onToggleTerminal}
          title="Terminal"
        >
          <span className="sidebar-icon">⌨️</span>
          <span className="sidebar-label">Terminal</span>
        </button>
        <button
          className={`sidebar-btn ${showSessions ? 'active' : ''}`}
          onClick={onToggleSessions}
          title="History"
        >
          <span className="sidebar-icon">🕒</span>
          <span className="sidebar-label">History</span>
        </button>
        <div className="sidebar-divider" />
        <button
          className={`sidebar-btn ${showBuilds ? 'active' : ''}`}
          onClick={onToggleBuilds}
          title="Builds panel"
        >
          <span className="sidebar-icon">🛠</span>
          <span className="sidebar-label">Builds</span>
        </button>
        <button
          className={`sidebar-btn ${showKnowledge ? 'active' : ''}`}
          onClick={onToggleKnowledge}
          title="Knowledge panel"
        >
          <span className="sidebar-icon">📚</span>
          <span className="sidebar-label">Knowledge</span>
        </button>
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-version">v2.0.0</div>
      </div>
    </aside>
  );
}
