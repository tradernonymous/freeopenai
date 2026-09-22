import { useState, useEffect, useRef, useCallback } from 'react';
import { api, streamChat, streamLocalChat, type StreamFrame } from '../api';
import { escapeHtml } from '../markdown';
import Icon from '../components/Icon';
import SelectPill from '../components/SelectPill';
import { isSavedProvider, streamSaved } from '../run-model';
import type { EffectiveConfig, GlobalSettings } from '../project-config';
import '../saved-models.js';
import { hasShell, pickFolder, listLocalDir, readLocalFile, writeLocalFile, editLocalFile, runLocal } from '../bridge';
// UMD modules: loaded for their side effect, read off globalThis.
import '../coding-agent.js';
import '../hf-auth.js';
import '../chats.js';
import '../docker-sandbox.js';
// Loaded before the agent ever runs: the agent reads the folder's rules off the
// global, and without them it approval-gates every mutation.
import '../project-config.js';

const agent: typeof import('../coding-agent.js') = (globalThis as any).FreeAI4UCodingAgent;
const projectConfig: typeof import('../project-config.js') = (globalThis as any).FreeAI4UProjectConfig;
const dockerSandbox: typeof import('../docker-sandbox.js') = (globalThis as any).FreeAI4UDockerSandbox;
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

/**
 * A request handed over from another screen (Design's "Handoff to Code"),
 * read once on mount -- the same pattern as Chat -> Design's DESIGN_BRIEF_KEY.
 */
export const CODE_HANDOFF_KEY = 'freeai4u.codeHandoff';

/**
 * The person's own coding-agent settings: the ceiling a project's
 * `.freeai4u.json` can never rise above. There is no screen for these yet, so
 * what almost everyone has is the default -- ask about every mutation, allow no
 * command without asking -- and a project file can only keep it there or make
 * it stricter.
 */
export const CODE_APPROVAL_KEY = 'freeai4u.code_approval';

function myApprovalSettings(): GlobalSettings {
  try {
    const raw = localStorage.getItem(CODE_APPROVAL_KEY);
    return projectConfig.globalSettings(raw ? JSON.parse(raw) : null);
  } catch {
    // Unreadable or nonsense: the default is the strict one, so falling back
    // to it can only ask more often.
    return projectConfig.globalSettings(null);
  }
}

export default function CodeScreen({ localRoot }: { localRoot: string }) {
  const [request, setRequest] = useState('');
  useEffect(() => {
    try {
      const handed = sessionStorage.getItem(CODE_HANDOFF_KEY);
      if (handed) { sessionStorage.removeItem(CODE_HANDOFF_KEY); setRequest(handed); }
    } catch { /* nothing handed over */ }
  }, []);
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
  // Opt-in Docker sandbox for run_command (docker-sandbox.js); ParallelScreen reads the same setting.
  const [docker, setDocker] = useState(() => dockerSandbox.settings());
  const updateDocker = (next: { enabled: boolean; image: string }) => {
    setDocker(next);
    dockerSandbox.saveSettings(next);
  };

  // The opened folder's own .freeai4u.json, re-read whenever the folder changes.
  // Absent or unreadable leaves `configRef` null, which is exactly today's
  // behaviour: the agent asks before every mutation.
  const configRef = useRef<EffectiveConfig | null>(null);
  const [overrides, setOverrides] = useState<string[]>([]);
  const [configProblems, setConfigProblems] = useState<string[]>([]);
  useEffect(() => {
    configRef.current = null;
    setOverrides([]);
    setConfigProblems([]);
    if (!localRoot || !hasShell()) return;
    let live = true;
    const mine = myApprovalSettings();
    projectConfig.read((path) => readLocalFile(localRoot, path), mine)
      .then((loaded) => {
        if (!live) return;
        configRef.current = loaded.effective;
        setConfigProblems(loaded.problems);
        setOverrides(loaded.present ? projectConfig.describe(loaded.effective, mine) : []);
        // A model is a preference, not a permission, so the project's choice
        // stands; everything else was already narrowed by the merge.
        if (loaded.effective.model) {
          setProvider(loaded.effective.model.provider);
          setModel(loaded.effective.model.model);
        }
      })
      .catch(() => { /* no readable file: the folder has no say, which is the default */ });
    return () => { live = false; };
  }, [localRoot]);

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
        // docker-sandbox.run is a straight call when the Docker setting is off.
        // A command the host shell would rewrite goes through a script file in .neuraos.
        const files = { write: (p: string, c: string) => writeLocalFile(root, p, c) };
        return dockerSandbox.run({ root, command, cwd, files }, (line, at, timeoutMs) =>
          runLocal({ root, runId: 'agent-' + Date.now(), command: line, cwd: at, timeoutMs: timeoutMs ?? 120_000 }));
      },
      onEvent: (event: any) => {
        // 'auto' is a mutation the folder's settings let through without an
        // approval card; it still gets a row, so nothing happens unseen.
        if (event.type === 'step' || event.type === 'auto') {
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
    session.config = configRef.current;
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

        <div className="code-docker" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <label className="toggle">
            <input
              type="checkbox"
              checked={docker.enabled}
              onChange={(e) => updateDocker({ ...docker, enabled: e.target.checked })}
            />
            Run agent commands in Docker
          </label>
          {docker.enabled && (
            <input
              value={docker.image}
              onChange={(e) => updateDocker({ ...docker, image: e.target.value })}
              placeholder={dockerSandbox.DEFAULT_IMAGE}
              spellCheck={false}
              aria-label="Docker image"
              style={{ maxWidth: 220 }}
            />
          )}
          {docker.enabled && (
            <span className="settings-hint">
              Commands run in a throwaway container with this folder mounted read-write at /work. The rest of
              your disk is out of reach; the project's own files are not protected. Needs Docker Desktop running.
            </span>
          )}
        </div>

        {(overrides.length > 0 || configProblems.length > 0) && (
          <div className="code-project-config" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {overrides.length > 0 && (
              <span className="settings-hint">
                This folder's {projectConfig.FILENAME} sets {overrides.join('; ')}.
              </span>
            )}
            {/* Quiet, never fatal, never silent: each line names a field that was
                ignored, and an ignored field means your own setting applies. */}
            {configProblems.map((problem, i) => (
              <span key={i} className="settings-hint">{problem}</span>
            ))}
          </div>
        )}

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
            {approval.tool === 'run_command' && docker.enabled && (
              <div className="approval-cwd">runs in Docker ({docker.image}), this folder mounted at /work</div>
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
