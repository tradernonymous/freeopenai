import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';
import { escapeHtml } from '../markdown';
import Icon from '../components/Icon';

interface Step {
  id: string | number;
  title: string;
  phase: string;
  text?: string;
  exitCode?: number;
}

interface Pending {
  requestId: string;
  kind: string;
  tool?: string;
  summary?: string;
  preview?: string;
  question?: boolean;
}

interface BuildSession {
  id: string;
  status: string;
  steps: Step[];
  pending?: Pending | null;
  repo?: string | null;
  branch?: string | null;
  summary?: string | null;
  error?: string | null;
  provider?: string | null;
  model?: string | null;
  lastSeq: number;
  startedAt: number;
  updatedAt: number;
}

const STATUS_CLASS: Record<string, string> = {
  running: 'running',
  done: 'done',
  failed: 'error',
  cancelled: 'error',
  expired: 'error',
};

/** A diff preview is untrusted text; render lines with +/-/@@ classes. */
function diffHtml(preview: string): string {
  const lines = String(preview || '').split('\n');
  const html = lines.map((line) => {
    const safe = escapeHtml(line) || '&nbsp;';
    if (line.startsWith('+++') || line.startsWith('---')) return `<span class="diff-hunk">${safe}</span>`;
    if (line.startsWith('@@')) return `<span class="diff-hunk">${safe}</span>`;
    if (line.startsWith('+')) return `<span class="diff-add">${safe}</span>`;
    if (line.startsWith('-')) return `<span class="diff-del">${safe}</span>
    `.replace('\n', '');
    return `<span class="diff-ctx">${safe}</span>`;
  });
  return html.join('\n');
}

export default function BuildScreen() {
  const [sessions, setSessions] = useState<BuildSession[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [plan, setPlan] = useState(''); // composer draft
  const [repo, setRepo] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [gateReason, setGateReason] = useState('');

  const listRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | (Window & typeof globalThis) | null>(null);

  const active = sessions.find((s) => s.id === activeId) || null;

  const upsert = useCallback((view: BuildSession) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === view.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = { ...next[idx], ...view };
        return next;
      }
      return [view, ...prev];
    });
    if (view.status === 'running' || view.pending) setActiveId(view.id);
    return undefined;
  }, []);

  // initial list + engine gate state
  const refresh = useCallback(async () => {
    try {
      const data: any = await api.buildList();
      setEnabled(!!data.enabled);
      setGateReason(data.reason || '');
      const rows: BuildSession[] = Array.isArray(data.sessions) ? data.sessions : [];
      setSessions(rows);
      if (!activeId && rows.length) setActiveId(rows[0].id);
    } catch (err) {
      setEnabled(false);
      setGateReason((err as Error).message);
    }
  }, [activeId]);

  useEffect(() => { refresh(); }, [refresh]);

  // live events for the active session
  useEffect(() => {
    if (!activeId || !enabled) return undefined;
    const source = new EventSource(api.buildEvents(activeId), { withCredentials: true });
    esRef.current = source as any;
    const apply = (data: any) => upsert({ ...data, id: activeId } as BuildSession);
    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        // SSE events carry their own seq; the view carries the steps. The
        // events endpoint replays `after` server-side, so each frame is the
        // event itself -- apply the known shapes and refetch the view on
        // terminal events to get the authoritative steps array.
        if (event.type === 'status' || event.type === 'message') apply(event);
        if (event.type === 'step') {
          setSessions((prev) => prev.map((s) => {
            if (s.id !== activeId) return s;
            const steps = s.steps.slice();
            const idx = steps.findIndex((x) => String(x.id) === String(event.id));
            if (idx >= 0) steps[idx] = { ...steps[idx], ...event };
            else steps.push(event as Step);
            return { ...s, steps, updatedAt: event.ts || Date.now() };
          }));
        }
        if (event.type === 'diff') {
          setSessions(prev => prev.map((s) => (s.id === activeId
            ? { ...s, pending: { requestId: event.requestId, kind: 'diff', tool: event.tool, summary: event.summary, preview: event.diff, question: false } }
            : s)));
        }
        if (event.type === 'approval' || event.type === 'question') {
          setSessions((prev) => prev.map((s) => (s.id === activeId
            ? { ...s, pending: event, updatedAt: event.ts || Date.now() }
            : s)));
        }
        if (event.type === 'done' || event.type === 'failed') {
          api.buildGet(activeId).then((v: any) => upsert(v)).catch(() => {});
        }
      } catch { /* a frame that is not JSON says nothing */ }
    };
    source.onerror = () => { /* EventSource retries on its own; terminal states close the stream server-side */ };
    return () => { source.close(); esRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, enabled]);

  const start = async () => {
    const text = plan.trim();
    if (!text || starting) return;
    setStarting(true);
    setError('');
    try {
      const view: any = await api.buildRun({ plan: text, repo: repo.trim() || undefined });
      upsert(view);
      setActiveId(view.id);
      setPlan('');
      setRepo('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const decide = async (decision: 'approve' | 'reject') => {
    if (!active?.pending) return;
    try {
      const res: any = await api.buildInput(active.id, {
        requestId: active.pending.requestId,
        decision,
        ...(answer.trim() ? { text: answer.trim() } : {}),
      });
      if (res?.session) upsert(res.session);
      setAnswer('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const cancel = async () => {
    if (!active) return;
    try {
      const res: any = await api.buildCancel(active.id);
      if (res?.session) upsert(res.session);
    } catch (err) {
      setError((((err as Error).message) || '') + '');
    }
  };

  // keep the live log pinned to the newest event
  useEffect(() => {
    if (activeId && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [active?.steps.length, activeId]);

  if (!enabled) {
    return (
      <div className="screen build">
        <div className="empty-state">
          <div className="empty-icon"><Icon name="build" size={28} /></div>
          <h2>Builds are not enabled on this server</h2>
          <p>{gateReason || 'Set WORKSPACE_RUN=1 (and a login) on the FreeAI4U server to run builds.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen build">
      <header className="screen-header">
        <h1>Builds</h1>
        <div className="header-actions">
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo (optional)" style={{ width: 180 }} />
          <button className="primary" onClick={start} disabled={starting || !plan.trim()}>
            {starting ? 'Starting…' : 'New build'}
          </button>
        </div>
      </header>

      <div className="build-layout">
        <aside className="build-sidebar">
          <div className="panel">
            <h3>Plan</h3>
            <textarea value={plan} onChange={(e) => setPlan(e.target.value)}
              placeholder="Describe what to build or change. Every edit lands here for approval before it is applied." rows={5} />
          </div>
          <div className="panel">
            <h3>Sessions</h3>
            <div className="session-list">
              {sessions.map((s) => (
                <button key={s.id} className={`session-item ${activeId === s.id ? 'active' : ''}`} onClick={() => setActiveId(s.id)}>
                  <div className="session-title">{s.id}</div>
                  <div className="session-status">{s.status}{s.pending ? ' · awaiting you' : ''}</div>
                  <div className="session-date">{new Date(s.startedAt || Date.now()).toLocaleString()}</div>
                </button>
              ))}
              {sessions.length === 0 && <div className="empty">No builds yet — write a plan and start one.</div>}
            </div>
          </div>
        </aside>

        <main className="build-main">
          {active ? (
            <div className="build-detail">
              <div className="build-header">
                <div>
                  <div className="build-id">{active.id}</div>
                  <div className="build-status">
                    {active.status}
                    {active.provider ? ` · ${active.provider}/${active.model || ''}` : ''}
                    {active.repo ? ` · ${active.repo}` : ''}
                  </div>
                </div>
                <button onClick={cancel} disabled={!['running', 'waiting_approval', 'waiting_input'].includes(active.status)}>
                  Cancel
                </button>
              </div>

              {active.pending && (
                <div className={`approval-card ${active.pending.kind === 'question' ? 'question' : ''}`}>
                  <div className="approval-title">
                    {active.pending.kind === 'question' ? 'The build has a question' : `Approval needed: ${active.pending.tool || active.pending.kind}`}
                  </div>
                  {active.pending.summary && <div className="approval-summary">{active.pending.summary}</div>}
                  {active.pending.preview && (
                    <pre className="diff-view" dangerouslySetInnerHTML={{ __html: diffHtml(active.pending.preview) }} />
                  )}
                  {active.pending.kind === 'question' && (
                    <input value={answer} onChange={(e) => setAnswer(e.target.value)}
                      placeholder="Type your answer…" className="approval-input" />
                  )}
                  <div className="approval-actions">
                    <button className="primary" onClick={() => decide('approve')}>Approve</button>
                    <button className="danger" onClick={() => decide('reject')}>Reject</button>
                  </div>
                </div>
              )}

              <div className="build-steps" ref={listRef}>
                {active.steps.map((step, i) => (
                  <div key={`${step.id}-${i}`} className={`step ${STATUS_CLASS[step.phase] || ''}`}>
                    <div className="step-indicator" />
                    <div className="step-body">
                      <div className="step-title">{step.title}</div>
                      {step.text && <pre className="step-detail">{step.text}</pre>}
                      {typeof step.exitCode === 'number' && (
                        <div className={`step-exit ${step.exitCode === 0 ? 'ok' : 'bad'}`}>exit {step.exitCode}</div>
                      )}
                    </div>
                  </div>
                ))}
                {(!active.steps || active.steps.length === 0) && (
                  <div className="empty">Waiting for the build to report its first step…</div>
                )}
              </div>

              {active.error && <div className="stream-error">{active.error}</div>}
              {active.summary && (
                <div className="build-summary">
                  <strong>Summary.</strong> {active.summary}
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon"><Icon name="build" size={28} /></div>
              <h2>No build selected</h2>
              <p>Write a plan on the left and start one. Approvals appear here the moment the build needs you.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
