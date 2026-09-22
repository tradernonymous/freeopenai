import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import SelectPill from '../components/SelectPill';
import { pushToast } from '../components/Toasts';
import { saveFile } from '../files/save';
import { hasShell, notifyUser } from '../bridge';
import { collectReply, type Target } from '../stream-any';
// recipes.js first: evals.js reads its scheduling rule (nextRun) off the global.
import '../recipes.js';
import '../evals.js';
import '../saved-models.js';
import '../hf-auth.js';
import '../hf-inference.js';

const evals: typeof import('../evals.js') = (globalThis as any).FreeAI4UEvals;
const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;
const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;
const hfInference: typeof import('../hf-inference.js') = (globalThis as any).FreeAI4UHfInference;

type EvalResult = import('../evals.js').EvalResult;
type EvalTask = import('../evals.js').EvalTask;
type EvalRun = import('../evals.js').EvalRun;
type EvalSchedule = import('../evals.js').EvalSchedule;
type EvalTarget = import('../evals.js').EvalTarget;

// Evals (roadmap 6.6), under Library: the same built-in tasks against the
// models you pick -- cloud and local side by side -- scored by code, with pass
// rate and latency. It answers "which of my models can I trust with JSON and
// tool arguments" with numbers.
//
// Every finished run is kept (evals.js history), each model is compared with
// its previous run, and a schedule re-runs the suite while the app is open --
// so a model that quietly got worse (a provider swapped a quant, a local
// model was re-pulled) is noticed, with a notification.

const TIMEOUT_MS = 120000;

// ---- one suite at a time, shared by the screen and the scheduler ----------------

let busyKind: '' | 'manual' | 'schedule' = '';
let busyStep = '';
let activeAbort: AbortController | null = null;
const busyListeners = new Set<() => void>();

function setBusy(kind: typeof busyKind, step = '') {
  busyKind = kind;
  busyStep = step;
  busyListeners.forEach((f) => f());
}

/** '' when idle, else who is running the suite. */
export function suiteRunning(): '' | 'manual' | 'schedule' {
  return busyKind;
}

/** Each task against each target, in turn, with TIMEOUT_MS per task. Stops early when `signal` aborts. */
export async function runSuite(
  targets: Target[],
  tasks: EvalTask[],
  signal: AbortSignal,
  onRow?: (row: EvalResult) => void,
): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const target of targets) {
    for (const task of tasks) {
      if (signal.aborted) return out;
      setBusy(busyKind, `${target.label} — ${task.title}`);
      const timer = new AbortController();
      const onAbort = () => timer.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const clock = setTimeout(() => timer.abort(), TIMEOUT_MS);
      let row: EvalResult;
      try {
        const reply = await collectReply(target, [{ role: 'user', content: task.prompt }], timer.signal);
        const verdict = evals.score(task, reply.text);
        row = { target, taskId: task.id, pass: verdict.pass, note: verdict.note, ms: reply.ms, chars: reply.text.length };
      } catch (e) {
        const message = (e as Error).name === 'AbortError' ? 'timed out or stopped' : ((e as Error).message || String(e)).split('\n')[0];
        row = { target, taskId: task.id, pass: false, error: message, ms: 0, chars: 0 };
      } finally {
        clearTimeout(clock);
        signal.removeEventListener('abort', onAbort);
      }
      out.push(row);
      onRow?.(row);
    }
  }
  return out;
}

/** Store a finished run and say which models got worse than their previous run. */
function recordRun(run: EvalRun): string[] {
  const stored = evals.appendRun(run);
  const comparison = evals.compareToHistory(stored, run);
  const unreachable = comparison.filter((c) => c.unreachable).map((c) => c.label);
  if (unreachable.length) pushToast('info', `Evals could not reach ${unreachable.join(', ')} (every task errored) — not counted as worse.`);
  return evals.regressions(comparison).map(evals.regressionMessage);
}

/**
 * One scheduled run: every task, the schedule's models (or the last run's),
 * sequentially. Local models are skipped outside the desktop shell.
 */
export async function runScheduledEvals(schedule: EvalSchedule, startedAt = Date.now()): Promise<EvalRun | null> {
  if (busyKind) return null;
  const history = evals.readHistory();
  const last = history[history.length - 1];
  const wanted: EvalTarget[] = schedule.targets.length ? schedule.targets : (last ? last.targets.filter((t) => t.provider && t.model) : []);
  const skipped = hasShell() ? [] : wanted.filter((t) => savedModels.isSavedProvider(t.provider));
  const targets = wanted.filter((t) => !skipped.includes(t));
  if (skipped.length) pushToast('info', `Scheduled evals skipped ${skipped.map((t) => t.label).join(', ')}: local models need the desktop app.`);
  if (!targets.length) return null;
  const controller = new AbortController();
  activeAbort = controller;
  setBusy('schedule');
  try {
    const rows = await runSuite(targets, evals.TASKS, controller.signal);
    if (controller.signal.aborted) return null;
    const run = evals.makeRun(rows, { at: startedAt, trigger: 'schedule', targets });
    const worse = recordRun(run);
    if (worse.length) {
      const body = worse.join('\n');
      notifyUser('A model got worse', body);
      pushToast('warn', `A model got worse — ${worse.join('; ')}`, true);
    }
    return run;
  } finally {
    activeAbort = null;
    setBusy('');
  }
}

/** While the app runs: once a minute, run the eval suite if its schedule is due (evals.js nextEvalRun). */
export function useEvalScheduler() {
  useEffect(() => {
    const tick = () => {
      if (busyKind) return; // a run is in progress; the next tick picks it up
      const schedule = evals.readSchedule();
      const now = Date.now();
      const next = evals.nextEvalRun(schedule, schedule.lastRunAt, now);
      if (next == null || next > now) return;
      // Stamped before the replies, so a slow suite is not started twice.
      evals.writeSchedule({ ...schedule, lastRunAt: now });
      runScheduledEvals(schedule, now).catch((e: unknown) => pushToast('error', `Scheduled evals failed: ${String((e as Error)?.message || e)}`));
    };
    const first = setTimeout(tick, 5000);
    const timer = setInterval(tick, 60000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, []);
}

// ---- small pieces ------------------------------------------------------------------

function Sparkline({ values }: { values: number[] }) {
  const w = 96;
  const h = 24;
  const pad = 3;
  const pts = values.map((v, i) => {
    const x = values.length > 1 ? pad + (i * (w - pad * 2)) / (values.length - 1) : w / 2;
    const y = pad + (1 - v) * (h - pad * 2);
    return [x, y] as const;
  });
  const lastPt = pts[pts.length - 1];
  return (
    <svg className="evals-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Pass rate over the last ${values.length} runs`}>
      <line x1={pad} x2={w - pad} y1={pad} y2={pad} className="evals-spark-top" />
      {pts.length > 1 && <polyline points={pts.map((p) => p.join(',')).join(' ')} />}
      {lastPt && <circle cx={lastPt[0]} cy={lastPt[1]} r={2.5} />}
    </svg>
  );
}

const ARROW = { up: '↑', down: '↓', flat: '→' } as const;
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

function RunGrid({ run }: { run: EvalRun }) {
  const taskIds = evals.TASKS.map((t) => t.id).filter((id) => run.rows.some((r) => r.taskId === id));
  return (
    <table className="evals-table">
      <thead>
        <tr><th>Model</th><th>Pass</th><th>Avg time</th>{taskIds.map((id) => <th key={id} title={evals.byId(id)?.prompt}>{evals.byId(id)?.title || id}</th>)}</tr>
      </thead>
      <tbody>
        {run.summary.map((s) => (
          <tr key={s.key}>
            <td className="mono">{s.label}</td>
            <td><strong>{s.passed}/{s.total}</strong> ({pct(s.rate)})</td>
            <td>{(s.avgMs / 1000).toFixed(1)}s</td>
            {taskIds.map((id) => {
              const r = run.rows.find((x) => x.targetKey === s.key && x.taskId === id);
              return (
                <td key={id} className={r ? (r.pass ? 'is-pass' : 'is-fail') : ''} title={r ? (r.note || 'passed') : 'not run'}>
                  {r ? (r.pass ? 'pass' : r.error ? 'error' : 'fail') : '—'}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- the screen ----------------------------------------------------------------------

export default function EvalsScreen() {
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [provider, setProvider] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [taskIds, setTaskIds] = useState<string[]>(() => evals.TASKS.map((t) => t.id));
  const [results, setResults] = useState<EvalResult[]>([]);
  const [busy, setBusyView] = useState<{ kind: string; step: string }>({ kind: busyKind, step: busyStep });
  const [history, setHistory] = useState<EvalRun[]>(() => evals.readHistory());
  const [schedule, setSchedule] = useState<EvalSchedule>(() => evals.readSchedule());
  const [selectedRun, setSelectedRun] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [hoursText, setHoursText] = useState(() => String(evals.readSchedule().everyHours || 24));
  const [mode, setMode] = useState<'hours' | 'daily'>(() => (evals.readSchedule().dailyAt && !evals.readSchedule().everyHours ? 'daily' : 'hours'));
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onBusy = () => setBusyView({ kind: busyKind, step: busyStep });
    busyListeners.add(onBusy);
    const onHistory = () => { setHistory(evals.readHistory()); setSchedule(evals.readSchedule()); };
    window.addEventListener(evals.HISTORY_EVENT, onHistory);
    return () => {
      busyListeners.delete(onBusy);
      window.removeEventListener(evals.HISTORY_EVENT, onHistory);
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  useEffect(() => {
    const mine = savedModels.providerRows().map((p) => ({ id: p.id, label: p.label }));
    const hf = { id: 'hf', label: 'Hugging Face' };
    api.providers()
      .then((rows: any) => {
        const chat = (Array.isArray(rows) ? rows : []).filter((p: any) => p.kind !== 'image' && p.configured).map((p: any) => ({ id: p.id, label: p.label }));
        setProviders([...mine, hf, ...chat]);
      })
      .catch(() => setProviders([...mine, hf]));
  }, []);

  useEffect(() => {
    if (!provider) { setModels([]); return; }
    if (savedModels.isSavedProvider(provider)) { const ids = savedModels.modelsFor(provider).map((m) => m.id); setModels(ids); setModel(ids[0] || ''); return; }
    if (provider === 'hf') { const ids = hfInference.models(hfAuth.accessToken()?.access_token || null).map((m: any) => m.id); setModels(ids); setModel(ids[0] || ''); return; }
    api.models(provider)
      .then((rows: any) => { const ids = (Array.isArray(rows) ? rows : []).map((r: any) => String(r.id || r)); setModels(ids); setModel(ids[0] || ''); })
      .catch(() => setModels([]));
  }, [provider]);

  const addTarget = () => {
    if (!provider || !model) return;
    const label = `${providers.find((p) => p.id === provider)?.label || provider} · ${model}`;
    setTargets((prev) => (prev.some((t) => t.label === label) ? prev : [...prev, { provider, model, label }]));
  };

  const run = async () => {
    const tasks = evals.TASKS.filter((t) => taskIds.includes(t.id));
    if (!targets.length || !tasks.length) return;
    if (busyKind) { pushToast('info', 'A scheduled eval run is in progress — wait for it, or stop it.'); return; }
    const controller = new AbortController();
    activeAbort = controller;
    setBusy('manual');
    setResults([]);
    try {
      const rows = await runSuite(targets, tasks, controller.signal, (row) => setResults((prev) => [...prev, row]));
      // A stopped run is not a result; a finished one is kept.
      if (!controller.signal.aborted && rows.length) {
        const record = evals.makeRun(rows, { trigger: 'manual', targets });
        const worse = recordRun(record);
        setHistory(evals.readHistory());
        if (worse.length) pushToast('warn', `Worse than last time — ${worse.join('; ')}`);
      }
    } finally {
      activeAbort = null;
      setBusy('');
    }
  };

  const exportCsv = () => {
    saveFile({ name: 'neuraos-evals.csv', bytes: new TextEncoder().encode(evals.toCsv(results)), mime: 'text/csv' })
      .then((m) => pushToast('ok', m))
      .catch((e: unknown) => pushToast('error', String((e as Error).message || e)));
  };

  const exportHistory = () => {
    saveFile({ name: 'neuraos-evals-history.json', bytes: new TextEncoder().encode(evals.exportHistory(history)), mime: 'application/json' })
      .then((m) => pushToast('ok', m))
      .catch((e: unknown) => pushToast('error', String((e as Error).message || e)));
  };

  const clearHistory = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      clearTimer.current = setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    evals.clearHistory();
    setHistory([]);
    setSelectedRun('');
    setConfirmClear(false);
    pushToast('info', 'Eval history cleared.');
  };

  // ---- schedule ----
  const lastRun = history[history.length - 1];
  const effectiveTargets: EvalTarget[] = schedule.targets.length ? schedule.targets : (lastRun ? lastRun.targets : []);
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: EvalTarget[] = [];
    for (const t of [...schedule.targets, ...(lastRun ? lastRun.targets : []), ...targets]) {
      const key = evals.targetKey(t);
      if (!key || seen.has(key) || !t.provider || !t.model) continue;
      seen.add(key);
      out.push({ provider: t.provider, model: t.model, label: t.label });
    }
    return out;
  }, [schedule.targets, lastRun, targets]);

  const saveSchedule = (patch: Partial<EvalSchedule>) => {
    const saved = evals.writeSchedule({ ...schedule, ...patch });
    if (saved) setSchedule(saved);
  };

  const toggleSchedule = (on: boolean) => {
    const patch: Partial<EvalSchedule> = { enabled: on };
    if (on) {
      // A schedule switched on starts counting now, not from "never run".
      patch.lastRunAt = Date.now();
      if (!schedule.everyHours && !schedule.dailyAt) patch.everyHours = Number(hoursText) || 24;
      if (!schedule.targets.length) patch.targets = effectiveTargets.length ? effectiveTargets : targets;
      if (!(patch.targets || schedule.targets).length) pushToast('info', 'Pick the models to re-run below (or run the suite once).');
    }
    saveSchedule(patch);
  };

  const pickMode = (m: string) => {
    const next = m === 'daily' ? 'daily' : 'hours';
    setMode(next);
    if (next === 'daily') saveSchedule({ everyHours: undefined, dailyAt: schedule.dailyAt || '08:00' });
    else saveSchedule({ dailyAt: undefined, everyHours: Number(hoursText) || 24 });
  };

  const setHours = (text: string) => {
    setHoursText(text);
    const n = Number(text);
    if (Number.isInteger(n) && n >= 1 && n <= 168) saveSchedule({ everyHours: n, dailyAt: undefined });
  };

  const toggleScheduleTarget = (t: EvalTarget, on: boolean) => {
    const key = evals.targetKey(t);
    const rest = effectiveTargets.filter((x) => evals.targetKey(x) !== key);
    saveSchedule({ targets: on ? [...rest, t] : rest });
  };

  const nextAt = evals.nextEvalRun(schedule, schedule.lastRunAt, Date.now());

  // ---- history views ----
  const trendRows = useMemo(() => {
    const byKey = new Map<string, string>();
    for (let i = history.length - 1; i >= 0; i -= 1) {
      for (const s of history[i].summary) if (!byKey.has(s.key)) byKey.set(s.key, s.label);
    }
    return [...byKey.entries()].slice(0, 12).map(([key, label]) => {
      const points = evals.series(history, key);
      return { key, label, points, trend: evals.trend(points), latest: points[points.length - 1] };
    });
  }, [history]);

  const selected = history.find((r) => r.id === selectedRun) || null;
  const comparison = selected ? evals.compareToHistory(history, selected) : [];
  const worseKeys = new Set(evals.regressions(comparison).map((r) => r.key));

  const summary = evals.summarize(results);
  const cell = (label: string, taskId: string) => results.find((r) => r.target.label === label && r.taskId === taskId);
  const running = busy.kind ? busy.step || 'starting…' : '';

  return (
    <div className="screen evals">
      <header className="screen-header">
        <h1>Evals</h1>
        <div className="header-actions">
          {running
            ? <button className="stop-btn" onClick={() => activeAbort?.abort()}>Stop</button>
            : <button className="primary" onClick={run} disabled={!targets.length || !taskIds.length}>Run {taskIds.length} task{taskIds.length === 1 ? '' : 's'} × {targets.length} model{targets.length === 1 ? '' : 's'}</button>}
          <button onClick={exportCsv} disabled={!results.length}>Export CSV</button>
        </div>
      </header>
      <div className="evals-body">
        <section className="settings-card">
          <h3 className="local-heading">Models</h3>
          <div className="evals-pick">
            <SelectPill label="Service" title="Where the model runs" value={provider} options={providers.map((p) => ({ value: p.id, label: p.label }))} onPick={setProvider} />
            <SelectPill label="Model" title="Which model" value={model} mono filterable options={models.map((m) => ({ value: m, label: m }))} onPick={setModel} />
            <button onClick={addTarget} disabled={!provider || !model}>Add</button>
          </div>
          {targets.map((t) => (
            <div key={t.label} className="local-row">
              <span className="mono">{t.label}</span>
              <button className="linkish" onClick={() => setTargets((prev) => prev.filter((x) => x.label !== t.label))} disabled={!!running}>Remove</button>
            </div>
          ))}
          {!targets.length && <p className="settings-hint">Add two or more — a local model next to a cloud one is the comparison that matters.</p>}
          <h3 className="local-heading">Tasks</h3>
          <div className="evals-tasks">
            {evals.TASKS.map((t) => (
              <label key={t.id} className="toggle" title={t.prompt}>
                <input type="checkbox" checked={taskIds.includes(t.id)} onChange={(e) => setTaskIds((prev) => (e.target.checked ? [...prev, t.id] : prev.filter((x) => x !== t.id)))} />
                {t.title} <span className="chip">{t.skill}</span>
              </label>
            ))}
          </div>
          <p className="settings-hint">Every task is scored by code (a number, a JSON shape, an exact list), so two runs agree and no judge model is needed.</p>
        </section>

        {running && <div className="settings-hint evals-running">{busy.kind === 'schedule' ? 'Scheduled run: ' : 'Running: '}{running}</div>}

        {summary.length > 0 && (
          <section className="settings-card">
            <h3 className="local-heading">Results</h3>
            <table className="evals-table">
              <thead>
                <tr><th>Model</th><th>Pass</th><th>Avg time</th>{evals.TASKS.filter((t) => taskIds.includes(t.id)).map((t) => <th key={t.id} title={t.prompt}>{t.title}</th>)}</tr>
              </thead>
              <tbody>
                {summary.map((row) => (
                  <tr key={row.target.label}>
                    <td className="mono">{row.target.label}</td>
                    <td><strong>{row.passed}/{row.total}</strong> ({Math.round(row.rate * 100)}%)</td>
                    <td>{(row.avgMs / 1000).toFixed(1)}s</td>
                    {evals.TASKS.filter((t) => taskIds.includes(t.id)).map((t) => {
                      const r = cell(row.target.label, t.id);
                      return (
                        <td key={t.id} className={r ? (r.pass ? 'is-pass' : 'is-fail') : ''} title={r ? (r.error || r.note || 'passed') : 'not run yet'}>
                          {r ? (r.pass ? 'pass' : r.error ? 'error' : 'fail') : '…'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="settings-card evals-schedule">
          <h3 className="local-heading">Schedule</h3>
          <label className="toggle">
            <input type="checkbox" checked={schedule.enabled} onChange={(e) => toggleSchedule(e.target.checked)} />
            Re-run every task on a schedule while NeuraOS is open, and tell me when a model gets worse
          </label>
          <div className="evals-schedule-row">
            <SelectPill
              label="Repeat"
              title="How often the suite runs"
              value={mode}
              options={[{ value: 'hours', label: 'Every N hours' }, { value: 'daily', label: 'Daily at a time' }]}
              onPick={pickMode}
            />
            {mode === 'hours' ? (
              <label className="evals-schedule-field">Every <input type="number" min={1} max={168} value={hoursText} onChange={(e) => setHours(e.target.value)} aria-label="Hours between runs" /> hours</label>
            ) : (
              <label className="evals-schedule-field">At <input type="time" value={schedule.dailyAt || '08:00'} onChange={(e) => e.target.value && saveSchedule({ dailyAt: e.target.value, everyHours: undefined })} aria-label="Daily run time" /></label>
            )}
          </div>
          <div className="evals-schedule-models">
            {candidates.map((t) => (
              <label key={evals.targetKey(t)} className="toggle">
                <input
                  type="checkbox"
                  checked={effectiveTargets.some((x) => evals.targetKey(x) === evals.targetKey(t))}
                  onChange={(e) => toggleScheduleTarget(t, e.target.checked)}
                />
                <span className="mono">{t.label}</span>
                {!hasShell() && savedModels.isSavedProvider(t.provider) && <span className="chip">skipped outside the desktop app</span>}
              </label>
            ))}
            {!candidates.length && <p className="settings-hint">Run the suite once, or add models above, to choose what the schedule re-runs.</p>}
          </div>
          <p className="settings-hint">
            {schedule.enabled && nextAt != null ? `Next run ${new Date(nextAt).toLocaleString()}.` : 'Off.'}
            {' '}A drop of one task or more, or replies twice as slow, counts as worse. Runs one model at a time, and waits if a run is already going.
          </p>
        </section>

        {history.length > 0 && (
          <section className="settings-card evals-history">
            <div className="evals-history-head">
              <h3 className="local-heading">History</h3>
              <span className="settings-hint">{history.length} run{history.length === 1 ? '' : 's'} kept (up to {evals.HISTORY_CAP})</span>
              <button onClick={exportHistory}>Export JSON</button>
              <button onClick={clearHistory} className={confirmClear ? 'danger' : ''}>{confirmClear ? 'Click again to clear' : 'Clear history'}</button>
            </div>
            <div className="evals-trends">
              {trendRows.map((m) => (
                <div key={m.key} className="evals-trend">
                  <span className="mono evals-trend-label" title={m.label}>{m.label}</span>
                  <Sparkline values={m.points.slice(-20).map((p) => p.rate)} />
                  <span className={`evals-arrow is-${m.trend}`} title={`Trend: ${m.trend}`} aria-label={`Trend ${m.trend}`}>{ARROW[m.trend]}</span>
                  <span className="evals-trend-last">{m.latest ? `${m.latest.passed}/${m.latest.total}` : '—'}</span>
                </div>
              ))}
            </div>
            <ul className="evals-runs">
              {[...history].reverse().map((r) => (
                <li key={r.id}>
                  <button className={`evals-run ${r.id === selectedRun ? 'active' : ''}`} aria-pressed={r.id === selectedRun} onClick={() => setSelectedRun(r.id === selectedRun ? '' : r.id)}>
                    <span className="evals-run-when">{new Date(r.at).toLocaleString()}</span>
                    {r.trigger === 'schedule' && <span className="chip">scheduled</span>}
                    <span className="evals-run-models">
                      {r.summary.map((s) => <span key={s.key} className="evals-run-model"><span className="mono">{s.label}</span> {s.passed}/{s.total}</span>)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {selected && (
          <section className="settings-card">
            <h3 className="local-heading">Run of {new Date(selected.at).toLocaleString()}</h3>
            <table className="evals-table evals-compare">
              <thead>
                <tr><th>Model</th><th>Previous</th><th>This run</th><th>Change</th><th>New failures</th><th>Speed</th></tr>
              </thead>
              <tbody>
                {comparison.map((c) => (
                  <tr key={c.key} className={worseKeys.has(c.key) ? 'is-regression' : ''}>
                    <td className="mono">{c.label}</td>
                    <td>{c.before == null ? 'first run' : `${c.beforePassed}/${c.total}`}</td>
                    <td>{c.afterPassed}/{c.total}{c.unreachable ? ' (unreachable)' : ''}</td>
                    <td className={c.delta == null || c.delta === 0 ? '' : c.delta < 0 ? 'is-fail' : 'is-pass'}>{c.delta == null ? '—' : `${c.delta > 0 ? '+' : ''}${Math.round(c.delta * 100)} pts`}</td>
                    <td>{c.newlyFailing.length ? c.newlyFailing.map((id) => evals.byId(id)?.title || id).join(', ') : '—'}</td>
                    <td>{c.slower == null ? '—' : `${c.slower.toFixed(1)}×`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <RunGrid run={selected} />
          </section>
        )}
      </div>
    </div>
  );
}
