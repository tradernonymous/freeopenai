import { useState, useEffect, useRef, useCallback } from 'react';
import { api, streamChat, streamLocalChat, type StreamFrame } from '../api';
import { escapeHtml } from '../markdown';
import Icon from '../components/Icon';
import SelectPill from '../components/SelectPill';
import { isSavedProvider, streamSaved } from '../run-model';
import '../saved-models.js';
import { hasShell, pickFolder, listLocalDir, readLocalFile, writeLocalFile, editLocalFile, runLocal } from '../bridge';
// UMD modules: loaded for their side effect, read off globalThis.
import '../coding-agent.js';
import '../hf-auth.js';
import '../chats.js';

const agent: typeof import('../coding-agent.js') = (globalThis as any).FreeAI4UCodingAgent;
const chats: typeof import('../chats.js') = (globalThis as any).FreeAI4UChats;

// ---- diff rendering (escape-safe, same pattern as BuildScreen) -----------

function diffHtml(preview: string): string {
  const lines = String(preview || '').split('\n');
  return lines.map((line) => {
    const safe = escapeHtml(line) || '&nbsp;';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@'))
      return `<span class="diff-hunk">${safe}</span>`;
    if (line.startsWith('+')) return `<span class="diff-add">${safe}</span>`;
    if (line.startsWith('-')) return `<span class="diff-del">${safe}</span>`;
    return `<span class="diff-ctx">${safe}</span>`;
  }).join('\n');
}

// ---- status styling ------------------------------------------------------

const STEP_STATUS: Record<string, string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

interface Step {
  id: number;
  title: string;
  status: string;
  tool: string;
  args: Record<string, unknown>;
  result: string | null;
  diff: string | null;
}

interface Approval {
  id: string;
  stepId: number;
  tool: string;
  args: Record<string, unknown>;
  diff: string | null;
  command: string | null;
}

// ---- the screen ----------------------------------------------------------

export default function CodeScreen({ localRoot }: { localRoot: string }) {
  const [request, setRequest] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [status, setStatus] = useState<string>('idle');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  // The agent never had a way to be given a model, so it never had one. The
  // list is "my models" first, then the engine's first ready provider.
  const [modelChoices, setModelChoices] = useState<Array<{ provider: string; model: string; label: string }>>([]);
  useEffect(() => {
    const saved = (globalThis as any).FreeAI4USavedModels as typeof import('../saved-models.js');
    const mine = saved.list().map((m) => ({
      provider: saved.PROVIDERS[m.kind].id,
      model: m.name,
      label: `${saved.PROVIDERS[m.kind].label} \u00b7 ${m.name}`,
    }));
    setModelChoices(mine);
    if (mine.length) { setProvider(mine[0].provider); setModel(mine[0].model); }
    api.providers()
      .then((rows: any) => {
        const ready = (Array.isArray(rows) ? rows : []).find((p: any) => p.kind !== 'image' && p.configured);
        if (!ready) return null;
        return api.models(ready.id).then((list: any) => {
          const engine = (Array.isArray(list) ? list : []).slice(0, 12).map((r: any) => ({
            provider: String(ready.id),
            model: String(r.id || r),
            label: `${ready.label} \u00b7 ${String(r.id || r)}`,
          }));
          setModelChoices([...mine, ...engine]);
          if (!mine.length && engine.length) { setProvider(engine[0].provider); setModel(engine[0].model); }
        });
      })
      .catch(() => { /* no engine: my models are still there */ });
  }, []);
  const [rejectReason, setRejectReason] = useState('');

  const listRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<any>(null);

  // Auto-scroll to latest step.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [steps.length]);

  // Build the agent callbacks from the existing bridge.
  const buildCallbacks = useCallback(() => {
    const root = localRoot;
    return {
      sendMessage: async (messages: Array<{ role: string; content: string }>, model: string, provider: string) => {
        // Use the local model if available, otherwise the engine.
        // The agent's model/provider are set at session start.
        return new Promise<string>((resolve, reject) => {
          let content = '';
          const onFrame = (frame: StreamFrame) => {
            if (frame.content) content += frame.content;
            if (frame.done) resolve(content);
          };
          // "My models" run on this PC; the stream ending is the answer ending
          // whether or not a `done` frame came.
          if (isSavedProvider(provider)) {
            streamSaved(provider, model, messages, onFrame).then(() => resolve(content)).catch(reject);
          } else if (provider === 'local') {
            streamLocalChat('http://127.0.0.1:8080', model, messages, onFrame)
              .then(() => resolve(content)).catch(reject);
          } else {
            streamChat(provider, { model, messages, stream: true }, onFrame)
              .then(() => resolve(content)).catch(reject);
          }
        });
      },
      listFiles: async (root: string, path: string) => {
        return listLocalDir(root, path);
      },
      readFile: async (root: string, path: string) => {
        return readLocalFile(root, path);
      },
      writeFile: async (root: string, path: string, content: string) => {
        return writeLocalFile(root, path, content);
      },
      editFile: async (root: string, path: string, oldText: string, newText: string) => {
        return editLocalFile({ root, path, oldText, newText });
      },
      runCmd: async (root: string, command: string, cwd?: string) => {
        const runId = 'agent-' + Date.now();
        return runLocal({ root, runId, command, cwd, timeoutMs: 120_000 });
      },
      onEvent: (event: any) => {
        if (event.type === 'step') {
          setSteps(prev => {
            const idx = prev.findIndex(s => s.id === event.step?.id);
            if (idx >= 0) {
              const next = prev.slice();
              next[idx] = { ...next[idx], ...event.step };
              return next;
            }
            return [...prev, event.step];
          });
        }
        if (event.type === 'approval') {
          setApproval(event.approval);
          setStatus('awaiting');
        }
        if (event.type === 'status') {
          setStatus(event.status);
          if (event.message) setMessage(event.message);
        }
        if (event.type === 'error') {
          setError(event.error);
          setStatus('error');
        }
        if (event.type === 'round') {
          // Could show a round counter if desired.
        }
      },
      onDecision: (approvalId: string, resolve: (d: any) => void) => {
        // Store the resolver so the approve/reject buttons can call it.
        (window as any).__codeAgentResolve = resolve;
      },
    };
  }, [localRoot]);

  const startAgent = async () => {
    const text = request.trim();
    if (!text || !localRoot) return;
    setSteps([]);
    setApproval(null);
    setError('');
    setMessage('');
    setStatus('planning');

    const session = agent.createSession(localRoot, model, provider);
    session.plan = [{ id: 0, title: text, status: 'running', tool: 'user_request', args: {}, result: null, diff: null }];
    sessionRef.current = session;

    try {
      await agent.runAgent(session, buildCallbacks());
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  };

  const stopAgent = () => {
    if (sessionRef.current) {
      sessionRef.current.status = 'stopped';
      setStatus('stopped');
    }
  };

  const decide = (approved: boolean) => {
    const resolve = (window as any).__codeAgentResolve;
    if (resolve) {
      resolve({ approved, reason: approved ? undefined : rejectReason });
      (window as any).__codeAgentResolve = null;
      setApproval(null);
      setRejectReason('');
      setStatus('running');
    }
  };

  const canRun = hasShell() && localRoot && status !== 'running' && status !== 'planning' && status !== 'awaiting';

  return (
    <div className="screen code-screen">
      <header className="screen-header">
        <h1>Code Agent</h1>
        <div className="header-actions">
          {!localRoot && (
            <button className="primary" onClick={() => hasShell() && pickFolder()}>
              Open a folder
            </button>
          )}
          {localRoot && (
            <span className="code-root" title={localRoot}>
              <Icon name="folder" size={13} />
              {localRoot.split(/[/\\]/).pop()}
            </span>
          )}
        </div>
      </header>

      <div className="code-layout">
        <div className="code-request-bar">
          <SelectPill
            label="Model"
            title="Model the coding agent uses"
            value={provider && model ? `${provider}|${model}` : ''}
            options={modelChoices.map((c) => ({ value: `${c.provider}|${c.model}`, label: c.label }))}
            onPick={(value) => { const [p, ...rest] = value.split('|'); setProvider(p || ''); setModel(rest.join('|')); }}
          />
          <input
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startAgent(); } }}
            placeholder={localRoot ? 'Describe what you want to change…' : 'Open a folder first'}
            disabled={!canRun}
          />
          {status === 'running' || status === 'planning' ? (
            <button className="danger" onClick={stopAgent}>
              <Icon name="close" size={13} /> Stop
            </button>
          ) : (
            <button className="primary" onClick={startAgent} disabled={!canRun || !request.trim()}>
              <Icon name="check" size={13} /> Run
            </button>
          )}
        </div>

        {error && <div className="stream-error">{error}</div>}

        {approval && (
          <div className={`approval-card ${approval.command ? 'command' : ''}`}>
            <div className="approval-title">
              {approval.tool === 'run_command'
                ? `Run command: ${approval.command}`
                : `Approval needed: ${approval.tool}`}
            </div>
            {approval.diff && (
              <pre className="diff-view" dangerouslySetInnerHTML={{ __html: diffHtml(approval.diff) }} />
            )}
            {approval.tool === 'run_command' && typeof approval.args.cwd === 'string' && (
              <div className="approval-cwd">cwd: {approval.args.cwd}</div>
            )}
            <div className="approval-actions">
              <button className="primary" onClick={() => decide(true)}>Approve</button>
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Reason (optional)"
                className="approval-input"
                onKeyDown={(e) => { if (e.key === 'Enter') decide(false); }}
              />
              <button className="danger" onClick={() => decide(false)}>Reject</button>
            </div>
          </div>
        )}

        <div className="code-steps" ref={listRef}>
          {steps.map((step) => (
            <div
              key={step.id}
              className={`step ${STEP_STATUS[step.status] || ''}`}
            >
              <div className="step-indicator" />
              <div className="step-body">
                <div className="step-title">{step.title}</div>
                {step.diff && (
                  <pre
                    className="step-diff diff-view"
                    dangerouslySetInnerHTML={{ __html: diffHtml(step.diff) }}
                  />
                )}
                {step.result && (
                  <pre className="step-detail">{step.result}</pre>
                )}
              </div>
            </div>
          ))}
          {steps.length === 0 && status === 'idle' && (
            <div className="empty-state">
              <div className="empty-icon"><Icon name="terminal" size={28} /></div>
              <h2>Local Code Agent</h2>
              <p>
                Open a project folder, describe what you want to change, and the agent
                will plan the edit, show you the diff, and wait for your approval
                before touching any file.
              </p>
              {!localRoot && (
                <p className="code-hint">
                  Pick a folder from the Local screen to get started.
                </p>
              )}
            </div>
          )}
          {steps.length === 0 && status !== 'idle' && (
            <div className="empty">Waiting for the agent to start…</div>
          )}
        </div>

        {message && status === 'done' && (
          <div className="code-summary">
            <strong>Done.</strong> {message}
          </div>
        )}
      </div>
    </div>
  );
}
