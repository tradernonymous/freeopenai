import { useState } from 'react';
import Sidebar from './Sidebar';
import './index.css';

const VIEWS = {
  chat: '/?app=desktop#chat',
  design: '/?app=desktop#design',
  build: '/?app=desktop#build',
  settings: '/?app=desktop#settings',
};

export default function App() {
  const [active, setActive] = useState('chat');

  const handleNavigate = (view) => {
    setActive(view);
    const url = VIEWS[view] || VIEWS.chat;
    // Use hash-based navigation within the webview
    window.location.hash = view;
  };

  return (
    <div className="app">
      <Sidebar active={active} onNavigate={handleNavigate} />
      <main className="main">
        <webview
          id="main-webview"
          src={VIEWS[active]}
          style={{ width: '100%', height: '100%', border: 'none' }}
          allow="clipboard-read; clipboard-write"
        />
      </main>
    </div>
  );
}
