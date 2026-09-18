import { useState, useEffect } from 'react';
import Sidebar from './Sidebar';
import TitleBar from './TitleBar';
import ChatScreen from './screens/ChatScreen';
import DesignScreen from './screens/DesignScreen';
import BuildScreen from './screens/BuildScreen';
import SettingsScreen from './screens/SettingsScreen';
import './index.css';

type View = 'chat' | 'design' | 'build' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('freeai4u-theme', theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('freeai4u-theme') as 'light' | 'dark' | null;
      if (saved) setTheme(saved);
    } catch {}
  }, []);

  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const res = await fetch('https://api.github.com/repos/tradernonymous/freeopenai/releases/latest');
        if (!res.ok) return;
        const data = await res.json();
        const latest = data.tag_name?.replace('desktop-', '') || '';
        const current = '2.0.0';
        if (latest && latest !== current) {
          setUpdateAvailable(true);
        }
      } catch {}
    };
    checkUpdate();
    const interval = setInterval(checkUpdate, 1000 * 60 * 60);
    return () => clearInterval(interval);
  }, []);

  const toggleTheme = () => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  };

  return (
    <div className="app">
      <TitleBar onToggleTheme={toggleTheme} theme={theme} />
      <div className="app-body">
        <Sidebar active={view} onNavigate={setView} />
        <main className="main">
          {updateAvailable && (
            <div className="update-banner">
              <span>Update available</span>
              <a href="https://github.com/tradernonymous/freeopenai/releases/tag/desktop-latest" target="_blank" rel="noreferrer">
                Download
              </a>
              <button onClick={() => setUpdateAvailable(false)}>✕</button>
            </div>
          )}
          {view === 'chat' && <ChatScreen />}
          {view === 'design' && <DesignScreen />}
          {view === 'build' && <BuildScreen />}
          {view === 'settings' && <SettingsScreen />}
        </main>
      </div>
    </div>
  );
}
