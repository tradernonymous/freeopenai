import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import SelectPill from './SelectPill';
import { pushToast } from './Toasts';
import { localModelStop, ollamaEject } from '../bridge';
import { applySettings, detectLimits, ensureUnsloth, forgetSettings, machineSpec, settingsFor, VRAM_KEY } from '../run-model';
import '../saved-models.js';
import '../run-settings.js';
import '../local-models.js';

const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;
const runSettings: typeof import('../run-settings.js') = (globalThis as any).FreeAI4URunSettings;
const localModels: typeof import('../local-models.js') = (globalThis as any).FreeAI4ULocalModels;

type RunValues = import('../run-settings.js').RunValues;

// Run settings, as a drawer on the right of Chat.
//
// The rules are in src/run-settings.js; this is the form. Two things it is
// careful to say out loud, because they are what surprises people:
//
//   * context length and GPU layers are LOAD-TIME for llama-server, so a change
//     there shows "Reload model" -- and only there; Ollama takes them per
//     message, so the button does not exist for it;
//   * the memory line is an estimate, and the GPU verdict only appears once the
//     person has said how much VRAM the card has (a webview cannot measure it).


function readVram(): number {
  try {
    const n = Number(localStorage.getItem(VRAM_KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

interface Props {
  open: boolean;
  onClose: () => void;
  provider: string;
  model: string;
}

export default function RunSettings({ open, onClose, provider, model }: Props) {
  const entry = useMemo(() => (open ? savedModels.find(provider, model) : null), [open, provider, model]);
  const [values, setValues] = useState<RunValues>(runSettings.DEFAULTS);
  const [loaded, setLoaded] = useState<RunValues>(runSettings.DEFAULTS);
  const [remember, setRemember] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [vram, setVram] = useState<number>(readVram);
  const [presetName, setPresetName] = useState('');
  const [presets, setPresets] = useState<Record<string, RunValues>>({});
  const [busy, setBusy] = useState('');
  // What this model says about itself (trained context, KV cost per token).
  const [limits, setLimits] = useState<import('../run-settings.js').ModelLimits | null>(null);

  useEffect(() => {
    if (!entry) return;
    const current = settingsFor(entry);
    setValues(current);
    setLoaded(current);
    setPresets(runSettings.presets());
    setLimits(runSettings.limitsFor(entry.id));
  }, [entry]);

  if (!open) return null;

  const patch = (next: Partial<RunValues>) => setValues((v) => runSettings.clean({ ...v, ...next }));
  const machine = localModels.machine();
  // The context that will really be used, and what the model allows.
  const spec = { ...machineSpec(), vramGb: vram };
  const usedCtx = runSettings.effectiveCtx(values, limits, { bytes: entry?.bytes || 0, gpuLayers: values.gpuLayers }, spec);
  const steps = runSettings.ctxSteps(limits);
  const report = runSettings.estimate(
    { bytes: entry?.bytes || 0, ctx: usedCtx, gpuLayers: values.gpuLayers, kvBytesPerToken: limits?.kvBytesPerToken },
    { ramGb: machine.ramGb, vramGb: vram },
  );
  const isFile = entry?.kind === 'unsloth';
  const reloadNeeded = isFile && runSettings.needsReload(loaded, values);
  const ctxIndex = values.ctx > 0 ? Math.max(1, steps.findIndex((step) => step >= values.ctx)) : 0;
  const readLimits = () => {
    if (!entry) return;
    setBusy('limits');
    const ask = entry.kind === 'ollama'
      ? detectLimits(entry)
      : ensureUnsloth(entry).then((status) => detectLimits(entry, status));
    ask
      .then((found) => {
        setLimits(runSettings.limitsFor(entry.id));
        pushToast(found?.trainCtx ? 'ok' : 'warn', found?.trainCtx
          ? `${entry.name} was trained for ${found.trainCtx.toLocaleString()} tokens.`
          : 'The model did not report its context length; Auto stays conservative.');
      })
      .catch((e: unknown) => pushToast('error', ((e as Error).message || String(e)).split('\n')[0]))
      .finally(() => setBusy(''));
  };

  const save = () => {
    if (!entry) return;
    applySettings(entry, values, remember);
    pushToast('ok', remember ? `Settings saved for ${entry.name}.` : 'Settings applied for this session.');
  };

  const reload = () => {
    if (!entry) return;
    applySettings(entry, values, remember);
    setBusy('reload');
    ensureUnsloth(entry, true)
      .then(() => { setLoaded(values); pushToast('ok', `${entry.name} reloaded.`); })
      .catch((e: unknown) => pushToast('error', ((e as Error).message || String(e)).split('\n')[0]))
      .finally(() => setBusy(''));
  };

  const eject = () => {
    if (!entry) return;
    setBusy('eject');
    const job = entry.kind === 'ollama' ? ollamaEject(entry.base, entry.name) : localModelStop().then(() => undefined);
    job
      .then(() => pushToast('info', `${entry.name} unloaded.`))
      .catch((e: unknown) => pushToast('error', ((e as Error).message || String(e)).split('\n')[0]))
      .finally(() => setBusy(''));
  };

  const resetAll = () => {
    if (!entry) return;
    forgetSettings(entry);
    setValues(runSettings.DEFAULTS);
    pushToast('info', 'Back to the defaults.');
  };

  const storeVram = (text: string) => {
    const n = Math.max(0, Number(text) || 0);
    setVram(n);
    try { localStorage.setItem(VRAM_KEY, String(n)); } catch { /* best effort */ }
  };

  const number = (label: string, key: keyof RunValues, step: number, hint?: string) => (
    <label className="run-field" title={hint}>
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={values[key] as number}
        onChange={(e) => patch({ [key]: Number(e.target.value) } as Partial<RunValues>)}
      />
    </label>
  );

  return (
    <aside className="run-drawer" aria-label="Run settings">
      <header className="run-drawer-head">
        <strong>Run settings</strong>
        <button onClick={onClose} aria-label="Close run settings"><Icon name="close" size={14} /></button>
      </header>

      {!entry ? (
        <p className="settings-hint">
          Run settings are for models on this machine. Pick one under <strong>Ollama Local</strong> or
          {' '}<strong>Unsloth Local</strong> (add them in Settings → Local models).
        </p>
      ) : (
        <>
          <section className="run-section">
            <div className="run-label">Model</div>
            <div className="mono run-model-name">{entry.name}</div>
            <div className="settings-hint">
              {savedModels.PROVIDERS[entry.kind].label}{entry.detail ? ` · ${entry.detail}` : ''}
            </div>
          </section>

          <section className="run-section">
            <div className="run-label">Estimated memory</div>
            <div className="run-meter"><span>GPU</span><span className="mono">{report.gpuGb.toFixed(2)} GB</span></div>
            <div className="run-meter"><span>Total</span><span className="mono">{report.totalGb.toFixed(2)} GB</span></div>
            <label className="run-field" title="A window cannot measure VRAM; type what your card has to get a GPU verdict">
              <span>Your GPU memory (GB)</span>
              <input type="number" min={0} step={1} value={vram || ''} placeholder="e.g. 4" onChange={(e) => storeVram(e.target.value)} />
            </label>
            {!entry.bytes && <div className="settings-hint">The size of this model is not known, so the estimate counts the cache only.</div>}
            {report.warnings.map((w) => <div key={w} className="run-warning">{w}</div>)}
          </section>

          <section className="run-section">
            <div className="run-meter">
              <span className="run-label">Context length</span>
              <span className="mono">
                {values.ctx > 0 ? usedCtx.toLocaleString() : `Auto · ${usedCtx.toLocaleString()}`}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={steps.length - 1}
              step={1}
              value={Math.min(ctxIndex, steps.length - 1)}
              onChange={(e) => patch({ ctx: steps[Number(e.target.value)] })}
              aria-label="Context length"
            />
            <div className="run-meter settings-hint">
              <span>Auto</span>
              <span>{(steps[steps.length - 1] || 0).toLocaleString()}</span>
            </div>
            <div className="settings-hint">
              {limits?.trainCtx
                ? `This model was trained for ${limits.trainCtx.toLocaleString()} tokens`
                : 'The model has not reported its maximum yet'}
              {limits?.kvBytesPerToken ? ` · about ${Math.round(limits.kvBytesPerToken / 1024)} KB of cache per token` : ''}
              {'. '}Auto picks the largest size that fits this PC{spec.vramGb ? ' and GPU' : ''}, up to {runSettings.AUTO_CAP.toLocaleString()}.
              {' '}
              <button className="linkish" onClick={readLimits} disabled={busy === 'limits'}>
                {busy === 'limits' ? 'Reading…' : limits?.trainCtx ? 'Read again' : 'Read from model'}
              </button>
            </div>
            {values.ctx > 0 && limits?.trainCtx && values.ctx > limits.trainCtx && (
              <div className="run-warning">More than the model was trained for: {limits.trainCtx.toLocaleString()} is used.</div>
            )}
          </section>

          <section className="run-section">
            <label className="toggle">
              <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
              Advanced settings
            </label>
            {advanced && (
              <div className="run-grid">
                {number('GPU layers', 'gpuLayers', 1, '-1 puts every layer on the GPU, 0 keeps the model on the CPU')}
                {number('Threads', 'threads', 1, '0 uses this machine’s cores')}
              </div>
            )}
          </section>

          <section className="run-section">
            <div className="run-label">Sampling</div>
            <div className="run-grid">
              {number('Temperature', 'temperature', 0.05)}
              {number('Top-p', 'topP', 0.01)}
              {number('Top-k', 'topK', 1)}
              {number('Min-p', 'minP', 0.01)}
              {number('Repeat penalty', 'repeatPenalty', 0.01)}
            </div>
          </section>

          <section className="run-section">
            <div className="run-label">System prompt</div>
            <textarea
              rows={4}
              value={values.system}
              onChange={(e) => patch({ system: e.target.value })}
              placeholder="Optional. Sent before every conversation with this model."
            />
          </section>

          <section className="run-section">
            <label className="toggle">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember for this model
            </label>
            <div className="run-actions">
              <button onClick={resetAll}>Reset</button>
              <button onClick={eject} disabled={!!busy}>{busy === 'eject' ? 'Unloading…' : 'Eject model'}</button>
              {isFile ? (
                <button className="primary" onClick={reload} disabled={!!busy}>
                  {busy === 'reload' ? 'Reloading…' : 'Reload model'}
                </button>
              ) : (
                <button className="primary" onClick={save}>Apply</button>
              )}
            </div>
            {isFile && !reloadNeeded && <button className="run-apply" onClick={save}>Apply without reloading</button>}
            {reloadNeeded && (
              <div className="run-warning">Context, GPU layers and threads are set when the model loads: reload to apply them.</div>
            )}
          </section>

          <section className="run-section">
            <div className="run-label">Preset</div>
            <SelectPill
              label="Preset"
              title={Object.keys(presets).length ? 'Apply a saved preset' : 'No presets yet: name one below and Save'}
              value={presets[presetName] ? presetName : ''}
              options={Object.keys(presets).map((name) => ({ value: name, label: name }))}
              onPick={(name) => { const p = presets[name]; if (p) { setValues(p); setPresetName(name); } }}
            />
            <div className="run-actions">
              <input
                type="text"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Preset name"
                aria-label="Preset name"
              />
              <button
                className="primary"
                disabled={!presetName.trim()}
                onClick={() => { runSettings.savePreset(presetName, values); setPresets(runSettings.presets()); pushToast('ok', `Preset “${presetName.trim()}” saved.`); }}
              >
                Save
              </button>
              <button
                disabled={!presets[presetName.trim()]}
                onClick={() => { runSettings.deletePreset(presetName.trim()); setPresets(runSettings.presets()); setPresetName(''); }}
              >
                Delete
              </button>
            </div>
          </section>

          <section className="run-section">
            <div className="run-label">Tools</div>
            <p className="settings-hint">
              Tools are offered to this model like any other (the server starts with --jinja). Switch them on or off,
              and connect GitHub or MCP servers, in Settings → Connectors. Small or 1-bit models often ignore tools.
            </p>
          </section>
        </>
      )}
    </aside>
  );
}
