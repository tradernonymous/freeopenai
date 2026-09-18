import { useState } from 'react';
import Sidebar from './Sidebar';
import ChatScreen from './screens/ChatScreen';
import DesignScreen from './screens/DesignScreen';
import BuildScreen from './screens/BuildScreen';
import SettingsScreen from './screens/SettingsScreen';
import FileTree from './components/FileTree';
import Terminal from './components/Terminal';
import SessionManager from './components/SessionManager';
import './index.css';

type View = 'chat' | 'design' | 'build' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [showFiles, setShowFiles] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showSessions, setShowSessions] = useState(false);

  return (
    <div className="app">
      <Sidebar
        active={view}
        onNavigate={setView}
        onToggleFiles={() => setShowFiles((v) => !v)}
        onToggleTerminal={() => setShowTerminal((v) => !v)}
        onToggleSessions={() => setShowSessions((v) => !v)}
        showFiles={showFiles}
        showTerminal={showTerminal}
        showSessions={showSessions}
      />
      <main className="main">
        {view === 'chat' && <ChatScreen />}
        {view === 'design' && <DesignScreen />}
        {view === 'build' && <BuildScreen />}
        {view === 'settings' && <SettingsScreen />}
      </main>
      {showFiles && <FileTree />}
      {showTerminal && <Terminal />}
      {showSessions && <SessionManager />}
    </div>
  );
}
