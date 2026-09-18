import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

export default function Terminal() {
  const [history, setHistory] = useState<Array<{ cmd: string; out: string }>>([]);
  const [input, setInput] = useState('');
  const [cwd, setCwd] = useState('.');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  const run = async () => {
    const cmd = input.trim();
    if (!cmd) return;
    setInput('');
    setHistory((prev) => [...prev, { cmd, out: 'Running…' }]);
    try {
      const res = await api.workspaceRun(cmd, cwd === '.' ? undefined : cwd);
      setHistory((prev) => prev.map((h) => (h.cmd === cmd && h.out === 'Running…' ? { cmd, out: (res as any)?.output || 'ok' } : h)));
    } catch (e) {
        setHistory((prev) => prev.map((h) => (h.cmd === cmd && h.out === 'Running…' ? { cmd, out: `Error: ${(e as Error).message}` } : h)));
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  };

  return (
    <div className="terminal">
      <div className="terminal-header">
        <span>Terminal</span>
        <span className="terminal-cwd">{cwd}</span>
      </div>
      <div className="terminal-body">
        {history.map((item, i) => (
          <div key={i} className="terminal-line">
            <div className="terminal-prompt">$ {item.cmd}</div>
            <pre className="terminal-output">{item.out}</pre>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="terminal-input-row">
        <span className="terminal-prompt">$</span>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Run a command in the workspace…"
          rows={1}
        />
      </div>
    </div>
  );
}
