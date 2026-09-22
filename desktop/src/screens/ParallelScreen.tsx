// Parallel agents (roadmap 5.7): up to four coding agents at once, each in its
// own git worktree and branch of the open folder, shown as a grid of cards
// with a running timer, the latest steps, and what changed. Nothing reaches
// the main tree until the person presses Merge on a card.
//
// The agent loop is the Code screen's (coding-agent.js), started once per
// worktree; only the root it is confined to differs. Because a worktree is a
// throwaway copy, edits and commands inside it can be approved automatically
// -- the shell still refuses risky commands (push, reset --hard, ...) outright.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamChat, type StreamFrame } from '../api';
import Icon from '../components/Icon';
import SelectPill from '../components/SelectPill';
import { pushToast } from '../components/Toasts';
import { isSavedProvider, streamSaved } from '../run-model';
import { editLocalFile, hasShell, listLocalDir, readLocalFile, runLocal, writeLocalFile } from '../bridge';
import '../coding-agent.js';
import '../saved-models.js';
import '../worktrees.js';

const agent: typeof import('../coding-agent.js') = (globalThis as any).FreeAI4UCodingAgent;
const worktrees: typeof import('../worktrees.js') = (globalThis as any).FreeAI4UWorktrees;

type Row = import('../worktrees.js').WorktreeRow;

interface Card {
  row: Row;
  status: string;
  startedAt: number;
  endedAt: number | null;
  steps: Array<{ id: number; title: string; status: string }>;
  approval: { id: string; tool: string; command: string | null; diff: string | null } | null;
  stat: string;
  error: string;
  merged: boolean;
}

interface Props {
  localRoot: string;
}

export default function ParallelScreen({ localRoot }: Props) {
  const [text, setText] = useState('');
  const [cards, setCards] = useState<Card[]>([]);
  const [autoApprove, setAutoApprove] = useState(true);
  const [choices, setChoices] = useState<Array<{ provider: string; model: string; label: string }>>([]);
  const [pick, setPick] = useState('');
  const [, setTick] = useState(0);
  const resolvers = useRef(new Map<string, (d: { approved: boolean; reason?: string }) => void>());

  // The same models the Code screen offers: mine first, then the engine's.
  useEffect(() => {
    const saved = (globalThis as any).FreeAI4USavedModels as typeof import('../saved-models.js');
    const mine = saved.list().map((m) => ({ provider: saved.PROVIDERS[m.kind].id, model: m.name, label: `${saved.PROVIDERS[m.kind].label} · ${m.name}` }));
    setChoices(mine);
    if (mine.length) setPick(`${mine[0].provider}|${mine[0].model}`);
    api.providers().then((rows: any) => {
      const ready = (Array.isArray(rows) ? rows : []).find((p: any) => p.kind !== 'image' && p.configured);
      if (!ready) return;
      return api.models(ready.id).then((list: any) => {
        const engine = (Array.isArray(list) ? list : []).slice(0, 12).map((r: any) => ({ provider: String(ready.id), model: String(r.id || r), label: `${ready.label} · ${String(r.id || r)}` }));
        setChoices([...mine, ...engine]);
        if (!mine.length && engine.length) setPick(`${engine[0].provider}|${engine[0].model}`);
      });
    }).catch(() => { /* no engine: my models still work */ });
  }, []);

  // One timer for every running card.
  const running = cards.some((c) => !c.endedAt);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const patch = useCallback((slug: string, change: Partial<Card> | ((c: Card) => Partial<Card>)) => {
    setCards((prev) => prev.map((c) => (c.row.slug === slug ? { ...c, ...(typeof change === 'function' ? change(c) : change) } : c)));
  }, []);

  const git = (command: string, cwd?: string, approveRisky = false) =>
    runLocal({ root: localRoot, runId: 'wt-' + Date.now() + Math.random().toString(36).slice(2, 6), command, cwd, timeoutMs: 120_000, approveRisky });

  const ask = (provider: string, model: string) => (messages: Array<{ role: string; content: string }>) =>
    new Promise<string>((resolve, reject) => {
      let content = '';
      const onFrame = (f: StreamFrame) => { if (f.content) content += f.content; };
      const done = () => resolve(content);
      if (isSavedProvider(provider)) streamSaved(provider, model, messages, onFrame).then(done, reject);
      else streamChat(provider, { model, messages, stream: true }, onFrame).then(done, reject);
    });

  const runOne = async (row: Row, provider: string, model: string) => {
    const root = worktrees.absolute(localRoot, row.dir);
    const send = ask(provider, model);
    const session = agent.createSession(root, model, provider);
    session.plan = [{ id: 0, title: row.task, status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
    try {
      await agent.runAgent(session, {
        sendMessage: (messages) => send(messages),
        listFiles: (r, p) => listLocalDir(r, p),
        readFile: (r, p) => readLocalFile(r, p),
        writeFile: (r, p, c) => writeLocalFile(r, p, c),
        editFile: (r, p, o, n) => editLocalFile({ root: r, path: p, oldText: o, newText: n }),
        runCmd: (r, command, cwd) => runLocal({ root: r, runId: 'pa-' + Date.now(), command, cwd, timeoutMs: 120_000 }),
        onEvent: (event: any) => {
          if (event.type === 'step' && event.step) {
            patch(row.slug, (c) => {
              const at = c.steps.findIndex((s) => s.id === event.step.id);
              const step = { id: event.step.id, title: String(event.step.title || event.step.tool || ''), status: String(event.step.status || '') };
              const steps = at >= 0 ? c.steps.map((s, i) => (i === at ? step : s)) : [...c.steps, step];
              return { steps };
            });
          }
          if (event.type === 'status') patch(row.slug, { status: String(event.status) });
          if (event.type === 'approval') patch(row.slug, { approval: event.approval, status: 'awaiting' });
          if (event.type === 'error') patch(row.slug, { error: String(event.error), status: 'error' });
        },
        onDecision: (approvalId, resolve) => {
          if (autoApprove) { resolve({ approved: true }); patch(row.slug, { approval: null }); return; }
          resolvers.current.set(row.slug, (d) => { resolve(d); patch(row.slug, { approval: null, status: 'running' }); });
          void approvalId;
        },
      });
      const stat = await git(worktrees.statCommand(), row.dir).catch(() => null);
      patch(row.slug, { endedAt: Date.now(), status: session.status === 'error' ? 'error' : 'done', stat: (stat?.stdout || '').trim() || 'No changes.' });
    } catch (e) {
      patch(row.slug, { endedAt: Date.now(), status: 'error', error: ((e as Error).message || String(e)).split('\n')[0] });
    }
  };

  const start = async () => {
    if (!hasShell()) { pushToast('warn', 'Parallel agents need the installed desktop app.'); return; }
    if (!localRoot) { pushToast('warn', 'Open a folder first (a git repository).'); return; }
    const [provider, ...rest] = pick.split('|');
    const model = rest.join('|');
    if (!provider || !model) { pushToast('warn', 'Pick a model.'); return; }
    const rows = worktrees.plan(worktrees.tasksFrom(text));
    if (!rows.length) { pushToast('warn', 'Write one task per line.'); return; }
    const inside = await git('git rev-parse --is-inside-work-tree').catch(() => null);
    if (!inside || !/true/.test(inside.stdout || '')) { pushToast('error', 'The open folder is not a git repository; worktrees need one (git init, then commit once).'); return; }
    await writeLocalFile(localRoot, '.neuraos/.gitignore', '*\n').catch(() => {});
    const now = Date.now();
    setCards((prev) => [...rows.map((row) => ({ row, status: 'creating', startedAt: now, endedAt: null, steps: [], approval: null, stat: '', error: '', merged: false })), ...prev]);
    setText('');
    for (const row of rows) {
      const made = await git(worktrees.addCommand(row)).catch((e: Error) => ({ exitCode: 1, stderr: e.message, stdout: '' } as any));
      if (made.exitCode !== 0) {
        patch(row.slug, { status: 'error', endedAt: Date.now(), error: String(made.stderr || made.stdout || 'git worktree add failed').split('\n')[0] });
        continue;
      }
      patch(row.slug, { status: 'planning' });
      void runOne(row, provider, model);
    }
  };

  const decide = (card: Card, approved: boolean) => {
    const resolve = resolvers.current.get(card.row.slug);
    resolvers.current.delete(card.row.slug);
    resolve?.({ approved, reason: approved ? undefined : 'Rejected in the grid' });
  };

  const merge = async (card: Card) => {
    const committed = await git(worktrees.commitCommand(card.row), card.row.dir).catch((e: Error) => ({ exitCode: 1, stderr: e.message } as any));
    if (committed.exitCode !== 0 && !/nothing to commit/i.test(String(committed.stdout || '') + String(committed.stderr || ''))) {
      pushToast('error', `Commit failed: ${String(committed.stderr || committed.stdout).split('\n')[0]}`);
      return;
    }
    const merged = await git(worktrees.mergeCommand(card.row)).catch((e: Error) => ({ exitCode: 1, stderr: e.message } as any));
    if (merged.exitCode !== 0) {
      pushToast('error', `Merge stopped (conflicts?): ${String(merged.stderr || merged.stdout).split('\n')[0]}. Resolve it in the Terminal, then Discard this card.`);
      return;
    }
    patch(card.row.slug, { merged: true });
    pushToast('ok', `Merged ${card.row.branch}.`);
  };

  const discard = async (card: Card) => {
    for (const command of worktrees.discardCommands(card.row)) {
      await git(command, undefined, true).catch(() => null);
    }
    setCards((prev) => prev.filter((c) => c.row.slug !== card.row.slug));
  };

  return (
    <div className="parallel-screen">
      <div className="parallel-head">
        <h2>Parallel agents</h2>
        <p className="settings-hint">
          One task per line, up to {worktrees.MAX_AGENTS}. Each runs in its own worktree and branch under <code>{worktrees.BASE}</code>; nothing touches your checkout until you press Merge.
        </p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={'Add input validation to the signup form\nWrite tests for utils/date.ts'} aria-label="Tasks, one per line" />
        <div className="parallel-controls">
          <SelectPill label="Model" title="Model every agent uses" value={pick} options={choices.map((c) => ({ value: `${c.provider}|${c.model}`, label: c.label }))} onPick={setPick} />
          <label className="toggle">
            <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
            Approve edits inside worktrees automatically
          </label>
          <button className="primary" onClick={start} disabled={!text.trim()}>
            <Icon name="plus" size={13} /> Start agents
          </button>
        </div>
        {!localRoot && <div className="chip-note">Open a folder (a git repository) first.</div>}
      </div>
      <div className="parallel-grid">
        {cards.map((card) => (
          <article key={card.row.slug} className={`parallel-card is-${card.status}`}>
            <header>
              <strong title={card.row.task}>{card.row.task}</strong>
              <span className="parallel-timer mono">{worktrees.elapsed((card.endedAt || Date.now()) - card.startedAt)}</span>
            </header>
            <div className="parallel-meta mono">{card.row.branch} · {card.merged ? 'merged' : card.status}</div>
            <ol className="parallel-steps">
              {card.steps.slice(-5).map((s) => <li key={s.id} className={`is-${s.status}`}>{s.title}</li>)}
            </ol>
            {card.approval && !autoApprove && (
              <div className="parallel-approval">
                <div className="mono">{card.approval.tool}{card.approval.command ? `: ${card.approval.command}` : ''}</div>
                {card.approval.diff && <pre>{card.approval.diff.slice(0, 1200)}</pre>}
                <div className="parallel-actions">
                  <button className="primary" onClick={() => decide(card, true)}>Approve</button>
                  <button onClick={() => decide(card, false)}>Reject</button>
                </div>
              </div>
            )}
            {card.error && <div className="chip-note" role="alert">{card.error}</div>}
            {card.stat && <pre className="parallel-stat">{card.stat}</pre>}
            {card.endedAt && (
              <div className="parallel-actions">
                {!card.merged && card.status !== 'error' && <button className="primary" onClick={() => merge(card)}>Merge</button>}
                <button onClick={() => discard(card)}>{card.merged ? 'Remove worktree' : 'Discard'}</button>
              </div>
            )}
          </article>
        ))}
        {cards.length === 0 && <div className="empty">No agents yet.</div>}
      </div>
    </div>
  );
}
