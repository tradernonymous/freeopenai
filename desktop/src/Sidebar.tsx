import { useState } from 'react';

const NAV_ITEMS = [
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'design', label: 'Design', icon: '🎨' },
  { id: 'build', label: 'Build', icon: '🛠' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

export default function Sidebar({ active, onNavigate }: { active: string; onNavigate: (id: string) => void }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">◆</span>
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
        <button className="sidebar-btn" onClick={() => window.location.href = '/?app=desktop'} title="Open in browser">
          <span className="sidebar-icon">🌐</span>
          <span className="sidebar-label">Web</span>
        </button>
      </div>
    </aside>
  );
}
