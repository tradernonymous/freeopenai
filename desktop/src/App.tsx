import { useState, useEffect } from 'react';
import Sidebar from './Sidebar';
import ChatScreen from './screens/ChatScreen';
import DesignScreen from './screens/DesignScreen';
import BuildScreen from './screens/BuildScreen';
import SettingsScreen from './screens/SettingsScreen';
import './index.css';

type View = 'chat' | 'design' | 'build' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('chat');

  return (
    <div className="app">
      <Sidebar active={view} onNavigate={setView} />
      <main className="main">
        {view === 'chat' && <ChatScreen />}
        {view === 'design' && <DesignScreen />}
        {view === 'build' && <BuildScreen />}
        {view === 'settings' && <SettingsScreen />}
      </main>
    </div>
  );
}
