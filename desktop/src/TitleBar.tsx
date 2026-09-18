import { useState } from 'react';

type TitleBarProps = {
  onToggleTheme: () => void;
  theme: 'light' | 'dark';
};

export default function TitleBar({ onToggleTheme, theme }: TitleBarProps) {
  return (
    <div className="titlebar">
      <div className="titlebar-drag">
        <span className="titlebar-brand">◆ FreeAI4U</span>
      </div>
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={onToggleTheme} aria-label="Toggle theme" title={`${theme === 'dark' ? 'Light' : 'Dark'} theme`}>
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>
    </div>
  );
}
