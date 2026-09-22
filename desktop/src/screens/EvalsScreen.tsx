import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import SelectPill from '../components/SelectPill';
import { pushToast } from '../components/Toasts';
import { saveFile } from '../files/save';
import { collectReply, type Target } from '../stream-any';
import '../evals.js';
import '../saved-models.js';
import '../hf-auth.js';
import '../hf-inference.js';

const evals: typeof import('../evals.js') = (globalThis as any).FreeAI4UEvals;
const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;
const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;
const hfInference: typeof import('../hf-inference.js') = (globalThis as any).FreeAI4UHfInference;

type EvalResult = import('../evals.js').EvalResult;

// Evals (roadmap 6.6), under Library: the same built-in tasks against the
// models you pick -- cloud and local side by side -- scored by code, with pass
// rate and latency. It answers "which of my models can I trust with JSON and
// tool arguments" with numbers.

const TIMEOUT_MS = 120000;

export default function EvalsScreen() {
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [provider, setProvider] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [taskIds, setTaskIds] = useState<string[]>(() => evals.TASKS.map((t) => t.id));
  const [results, setResults] = useState<EvalResult[]>([]);
  const [running, setRunning] = useState('');
  const abort = useRef<AbortController | null>(null);

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
    const controller = new AbortController();
    abort.current = controller;
    setResults([]);
    try {
      for (const target of targets) {
        for (const task of tasks) {
          if (controller.signal.aborted) return;
          setRunning(`${target.label} — ${task.title}`);
          const timer = new AbortController();
          const onAbort = () => timer.abort();
          controller.signal.addEventListener('abort', onAbort, { once: true });
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
            controller.signal.removeEventListener('abort', onAbort);
          }
          setResults((prev) => [...prev, row]);
        }
      }
    } finally {
      setRunning('');
      abort.current = null;
    }
  };

  const exportCsv = () => {
    saveFile({ name: 'neuraos-evals.csv', bytes: new TextEncoder().encode(evals.toCsv(results)), mime: 'text/csv' })
      .then((m) => pushToast('ok', m))
      .catch((e: unknown) => pushToast('error', String((e as Error).message || e)));
  };

  const summary = evals.summarize(results);
  const cell = (label: string, taskId: string) => results.find((r) => r.target.label === label && r.taskId === taskId);

  return (
    <div className="screen evals">
      <header className="screen-header">
        <h1>Evals</h1>
        <div className="header-actions">
          {running
            ? <button className="stop-btn" onClick={() => abort.current?.abort()}>Stop</button>
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

        {running && <div className="settings-hint evals-running">Running: {running}</div>}

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
      </div>
    </div>
  );
}
