import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { useLocalRun } from '../useLocalRun';
import { runLocal } from '../bridge';
// UMD modules: loaded for their side effect, read off globalThis.
import '../local-fs.js';
import '../run-result.js';

const localFs: typeof import('../local-fs.js') = (globalThis as any).FreeAI4ULocalFs;
const runResult: typeof import('../run-result.js') = (globalThis as any).FreeAI4URunResult;

// The local terminal dock.
//
// Commands run on THIS machine, inside the open folder, and nothing here talks
// to the engine. Three things make it a terminal rather than a submit button:
//
//   1. A cwd that survives commands. `cd` cannot be delegated to a child
//      process -- the child could never hand the change back -- so it is a
//      decision (src/local-fs.js applyCd), which is also what makes
//      `cd desktop && npm test` one line.
//   2. Output arrives as it happens: the shell streams each line as a
//      `local-run` event, and the settled result replaces the live text, so the
//      final view carries the exit code, duration and truncation either way.
//   3. A destructive command stops at a prompt. That list is the shell's, so
//      the command an agent must ask for is the one a human must confirm here.
//
// An entry is written back by its ID and its run is matched by runId, never by
// the command text: two identical commands in a row must not overwrite each
// other.

interface Entry {
  id: string;
  cmd: string;
  out: string;
  kind: 'running' | 'out' | 'err' | 'note';
  /** The shell's id for this run, so live chunks land on the right entry. */
  runId?: string;
  /** Set when the command is destructive and needs a yes before it runs. */
  pending?: { command: string; cwd: string; reason: string };
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `local-${Date.now().toString(36)}-${counter}`;
}

interface LocalTerminalProps {
  root: string;
  onOpenFolder: () => void;
  /** Lets the screen's tree follow the dock, and the dock follow the tree. */
  onCwdChange?: (cwd: string) => void;
  cwd?: string;
}

export default function LocalTerminal({ root, onOpenFolder, onCwdChange, cwd: cwdProp }: LocalTerminalProps) {
  const [history, setHistory] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [ownCwd, setOwnCwd] = useState('');
  const [recall, setRecall] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  // One owner: the screen owns the cwd when it passes one down.
  const cwd = cwdProp === undefined ? ownCwd : cwdProp;
  const setCwd = useCallback(
    (next: string) => {
      if (cwdProp === undefined) setOwnCwd(next);
      onCwdChange?.(next);
    },
    [cwdProp, onCwdChange],
  );

  const running = useMemo(() => history.some((h) => h.kind === 'running'), [history]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  // A new folder starts a new terminal: a cwd from another tree is a lie.
  useEffect(() => {
    setOwnCwd('');
    setHistory([]);
    onCwdChange?.('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const startedAt = useRef(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250);
    return () => clearInterval(timer);
  }, [running]);

  const patch = useCallback((id: string, change: Partial<Entry>) => {
    setHistory((prev) => prev.map((h) => (h.id === id ? { ...h, ...change } : h)));
  }, []);

  // Live output: routed by the run's id, so interleaved commands cannot
  // mis-deliver a line. If these events never arrive the settled result below
  // still fills the entry in -- streaming is a nicety, not the mechanism.
  useLocalRun((chunk) => {
    if (chunk.done || !chunk.text) return;
    setHistory((prev) =>
      prev.map((h) => {
        if (h.runId !== chunk.runId) return h;
        const kind: Entry['kind'] = chunk.stream === 'stderr' ? 'err' : h.kind === 'err' ? 'err' : 'out';
        return {
          ...h,
          out: h.out === 'Running…' ? String(chunk.text) : h.out + String(chunk.text),
          kind,
        };
      }),
    );
  });

  const execute = useCallback(
    (command: string, runCwd: string, id: string, approveRisky: boolean) => {
      const runId = nextId();
      setHistory((prev) =>
        prev.map((h) => (h.id === id ? { ...h, runId, out: 'Running…', kind: 'running', pending: undefined } : h)),
      );
      runLocal({ root, runId, command, cwd: runCwd, approveRisky })
        .then((res) => patch(id, runResult.formatRun(res) as Partial<Entry>))
        .catch((e: unknown) => patch(id, { out: (e as Error).message || String(e), kind: 'err' }));
    },
    [root, patch],
  );

  // A destructive command stops here and waits for a human. The reason is the
  // rule's own words, so the prompt can be judged rather than trusted.
  const queue = useCallback(
    (command: string, runCwd: string) => {
      const id = nextId();
      const reason = localFs.riskOf(command);
      if (reason) {
        setHistory((prev) => [
          ...prev,
          { id, cmd: command, out: '', kind: 'note', pending: { command, cwd: runCwd, reason } },
        ]);
        return;
      }
      setHistory((prev) => [...prev, { id, cmd: command, out: 'Running…', kind: 'running' }]);
      execute(command, runCwd, id, false);
    },
    [execute],
  );

  const submit = useCallback(
    (raw: string) => {
      const command = raw.trim();
      if (!command || !root) return;
      setInput('');
      setRecall(null);

      if (command === 'clear' || command === 'cls') {
        setHistory([]);
        return;
      }

      // `cd` (and `cd x && y`) is decided here, not by a child process.
      const cd = localFs.applyCd(root, cwd, command);
      if (cd.handled) {
        const id = nextId();
        if (cd.err) {
          setHistory((prev) => [...prev, { id, cmd: command, out: cd.err as string, kind: 'err' }]);
          return;
        }
        if (cd.cwd !== cwd) setCwd(cd.cwd);
        if (cd.out) {
          setHistory((prev) => [...prev, { id, cmd: command, out: cd.out as string, kind: 'out' }]);
          return;
        }
        if (!cd.run) {
          // A pure cd: say where we are, the way a shell prompt would.
          setHistory((prev) => [
            ...prev,
            { id, cmd: command, out: cd.cwd ? cd.cwd : localFs.rootLabel(root), kind: 'note' },
          ]);
          return;
        }
        queue(cd.run as string, cd.cwd);
        return;
      }
      queue(command, cwd);
    },
    [root, cwd, setCwd, queue],
  );

  const settle = (entry: Entry, approve: boolean) => {
    if (!entry.pending) return;
    if (!approve) {
      patch(entry.id, { pending: undefined, out: 'Cancelled — nothing was run.', kind: 'note' });
      return;
    }
    execute(entry.pending.command, entry.pending.cwd, entry.id, true);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(input);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const commands = history.map((h) => h.cmd);
    if (!commands.length) return;
    e.preventDefault();
    if (e.key === 'ArrowUp') {
      const next = Math.min((recall ?? commands.length) - 1, commands.length - 1);
      setRecall(next);
      setInput(commands[next]);
      return;
    }
    if (recall === null) return;
    const next = recall + 1;
    if (next >= commands.length) {
      setRecall(null);
      setInput('');
      return;
    }
    setRecall(next);
    setInput(commands[next]);
  };

  const cwdPath = cwd ? `${localFs.rootLabel(root)}/${cwd}` : localFs.rootLabel(root);

  if (!root) {
    return (
      <div className="terminal local-terminal">
        <div className="terminal-header">
          <span className="dock-title">
            <Icon name="terminal" size={13} /> Local terminal
          </span>
        </div>
        <div className="dock-empty">
          <p>Commands here run on this machine, inside a folder you choose.</p>
          <button className="primary" onClick={onOpenFolder}>
            Open a folder
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal local-terminal">
      <div className="terminal-header">
        <span className="dock-title">
          <Icon name="terminal" size={13} /> Local terminal
        </span>
        <span className="terminal-cwd" title="Runs on this machine, inside the open folder">
          <Icon name="folder" size={12} /> {cwdPath}
        </span>
        <button className="dock-action" onClick={() => setHistory([])} title="Clear the scrollback" aria-label="Clear">
          <Icon name="close" size={12} />
        </button>
      </div>
      <div className="terminal-body">
        {history.map((item) => (
          <div key={item.id} className="terminal-line">
            <div className="terminal-prompt">
              <span className="local-mark">LOCAL</span> {item.cmd}
            </div>
            {item.pending ? (
              <div className="approval-inline">
                <span className="approval-reason">
                  <Icon name="alert" size={13} /> This command {item.pending.reason}.
                </span>
                <div className="approval-actions">
                  <button className="primary" onClick={() => settle(item, true)}>
                    Run it anyway
                  </button>
                  <button onClick={() => settle(item, false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <pre
                className={`terminal-output ${item.kind === 'err' ? 'terminal-error' : ''} ${
                  item.kind === 'note' ? 'terminal-note' : ''
                }`}
              >
                {item.out}
              </pre>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="terminal-input-row">
        <span className="terminal-prompt">{cwd ? `${cwd} $` : '$'}</span>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Run a command in this folder…  (cd, clear, ↑ recalls)"
          rows={1}
          spellCheck={false}
          disabled={running}
        />
        {running && <span className="dock-running">{elapsed.toFixed(1)}s</span>}
        <button
          className="dock-send"
          onClick={() => submit(input)}
          disabled={running || !input.trim()}
          aria-label="Run"
        >
          <Icon name={running ? 'activity' : 'arrow-up'} size={14} />
        </button>
      </div>
    </div>
  );
}
