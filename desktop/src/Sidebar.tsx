import { useState } from 'react';

const NAV_ITEMS = [
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'design', label: 'Design', icon: '🎨' },
  { id: 'build', label: 'Build', icon: '🛠' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
] as const;

type NavId = typeof NAV_ITEMS[number]['id'];

export default function Sidebar({ active, onNavigate }: { active: NavId; onNavigate: (id: NavId) => void }) {
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
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-version">v2.0.0</div>
      </div>
    </aside>
  );
}
