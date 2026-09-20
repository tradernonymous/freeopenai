import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
// UMD module: loaded for its side effect, read off globalThis.
import '../run-result.js';

const runResult: typeof import('../run-result.js') = (globalThis as any).FreeAI4URunResult;

// The engine terminal: commands run on the server workspace (WORKSPACE_RUN=1 +
// a login). Three things here are deliberate:
//
//   1. A result is written back by the ENTRY'S ID, never by matching the
//      command text. The old code matched `cmd === cmd && out === 'Running…'`,
//      so two identical commands in a row were both overwritten by whichever
//      result arrived first, and an earlier finished command could be
//      re-overwritten later.
//   2. The output shown is the engine's real stdout/stderr and exit code. The
//      old code read a response field no route returns, so every command
//      printed "ok" no matter what it did.
//   3. The cwd is the one the engine reports for the run (or "workspace root"),
//      not a hardcoded '.' dressed up as a directory.

interface Entry {
  id: string;
  cmd: string;
  out: string;
  kind: 'running' | 'out' | 'err';
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `run-${Date.now().toString(36)}-${counter}`;
}


export default function Terminal() {
  const [history, setHistory] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [cwd, setCwd] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  const run = async () => {
    const cmd = input.trim();
    if (!cmd) return;
    setInput('');
    const id = nextId();
    setHistory((prev) => [...prev, { id, cmd, out: 'Running…', kind: 'running' }]);
    // Identity, not value: this is the fix for the same-command-twice bug.
    const settle = (patch: { out: string; kind: Entry['kind'] }) =>
      setHistory((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h)));
    try {
      const res: any = await api.workspaceRun(cmd);
      if (typeof res?.cwd === 'string' && res.cwd) setCwd(res.cwd);
      settle(runResult.formatRun(res));
    } catch (e) {
      settle({ out: `Error: ${(e as Error).message}`, kind: 'err' });
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
        <span className="terminal-cwd" title="Where the engine ran the last command">
          {cwd ? `workspace/${cwd}` : 'engine workspace'}
        </span>
      </div>
      <div className="terminal-body">
        {history.map((item) => (
          <div key={item.id} className="terminal-line">
            <div className="terminal-prompt">$ {item.cmd}</div>
            <pre className={`terminal-output ${item.kind === 'err' ? 'terminal-error' : ''}`}>{item.out}</pre>
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
          placeholder="Run a command in the engine workspace…"
          rows={1}
        />
      </div>
    </div>
  );
}
