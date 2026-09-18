import { useState, useEffect } from 'react';
import Sidebar from './Sidebar';
import TitleBar from './TitleBar';
import ChatScreen from './screens/ChatScreen';
import DesignScreen from './screens/DesignScreen';
import BuildScreen from './screens/BuildScreen';
import SettingsScreen from './screens/SettingsScreen';
import FileTree from './components/FileTree';
import Terminal from './components/Terminal';
import SessionManager from './components/SessionManager';
import './index.css';

type View = 'chat' | 'design' | 'build' | 'settings';
type RightPanel = 'builds' | 'knowledge' | 'none';

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [rightPanel, setRightPanel] = useState<RightPanel>('none');

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

  const toggleRightPanel = (panel: RightPanel) => {
    setRightPanel((prev) => (prev === panel ? 'none' : panel));
  };

  return (
    <div className="app">
      <TitleBar onToggleTheme={toggleTheme} theme={theme} />
      <div className="app-body">
        <Sidebar
          active={view}
          onNavigate={setView}
          onToggleFiles={() => setShowFiles((v) => !v)}
          onToggleTerminal={() => setShowTerminal((v) => !v)}
          onToggleSessions={() => setShowSessions((v) => !v)}
          onToggleBuilds={() => toggleRightPanel('builds')}
          onToggleKnowledge={() => toggleRightPanel('knowledge')}
          showFiles={showFiles}
          showTerminal={showTerminal}
          showSessions={showSessions}
          showBuilds={rightPanel === 'builds'}
          showKnowledge={rightPanel === 'knowledge'}
        />
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
          <div className="main-content">
            <div className="primary-pane">
              {view === 'chat' && <ChatScreen />}
              {view === 'design' && <DesignScreen />}
              {view === 'build' && <BuildScreen />}
              {view === 'settings' && <SettingsScreen />}
            </div>
            {rightPanel !== 'none' && (
              <aside className="right-panel">
                <div className="right-panel-header">
                  <h3>{rightPanel === 'builds' ? 'Builds' : 'Knowledge'}</h3>
                  <button onClick={() => setRightPanel('none')}>✕</button>
                </div>
                <div className="right-panel-body">
                  {rightPanel === 'builds' && <div className="empty">Builds panel — coming soon</div>}
                  {rightPanel === 'knowledge' && <div className="empty">Knowledge panel — coming soon</div>}
                </div>
              </aside>
            )}
          </div>
        </main>
        {showFiles && <FileTree />}
        {showTerminal && <Terminal />}
        {showSessions && <SessionManager />}
      </div>
    </div>
  );
}
