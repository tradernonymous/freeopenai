import { useState } from 'react';
import { pushToast } from './Toasts';
import SelectPill from './SelectPill';
import { call, hasShell, openUrl } from '../bridge';

type SdFacts = import('../images.js').SdFacts;
type SdStatus = {
  state: 'stopped' | 'starting' | 'ready' | string;
  binary: string;
  model: string;
  port: number;
  pid: number;
  uptime_ms: number;
  base_url: string;
  detail: string;
};

// "On this PC", on the Images screen: which sd-server draws, with which
// weights, and whether it is running right now.
//
// It lives here rather than in Settings for the same reason the Puter strip
// does: the thing it configures is one button away, and someone who picked
// "This PC" and cannot draw should not have to go looking for why.
//
// Nothing here downloads anything. Both halves -- the binary and the model --
// are files the user already has and chooses through the native picker; the
// two links open the pages to get them from in the system browser.

function sizeOf(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export interface LocalImagesCardProps {
  facts: SdFacts | null;
  status: SdStatus | null;
  /** Re-read the shell's facts and status after something changed. */
  onRefresh: () => Promise<void>;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  /** True while the screen is drawing: starting or stopping now would lie. */
  drawing: boolean;
}

export default function LocalImagesCard({ facts, status, onRefresh, onStart, onStop, drawing }: LocalImagesCardProps) {
  const shell = hasShell();
  const [busy, setBusy] = useState('');

  const guard = async (what: string, run: () => Promise<void>) => {
    setBusy(what);
    try {
      await run();
    } catch (e) {
      pushToast('error', ((e as Error).message || String(e)).split('\n')[0]);
    } finally {
      setBusy('');
    }
  };

  const pickBinary = () => guard('binary', async () => {
    const path = await call<string | null>('sd_pick_binary');
    if (path) pushToast('ok', `Local images will use ${path}.`);
    await onRefresh();
  });

  const pickModel = () => guard('model', async () => {
    const path = await call<string | null>('sd_pick_model');
    if (path) pushToast('ok', `Local images will draw with ${path}.`);
    await onRefresh();
  });

  const chooseModel = (path: string) => guard('model', async () => {
    if (!path) return;
    await call('sd_use_model', { path });
    await onRefresh();
  });

  const open = (url: string) => { openUrl(url).catch(() => window.open(url, '_blank', 'noopener')); };

  const models = facts?.models || [];
  const running = status?.state === 'ready' || status?.state === 'starting';

  if (!shell) {
    return (
      <details className="providers-note local-images-card">
        <summary>On this PC</summary>
        <div className="providers-note-body">
          <p className="settings-hint">Drawing on this PC needs the desktop app.</p>
        </div>
      </details>
    );
  }

  return (
    <details className="providers-note local-images-card" open={!facts?.found || !facts?.model}>
      <summary>
        On this PC {status?.state === 'ready' ? '· running' : facts?.found && facts?.model ? '· ready to start' : '· not set up'}
      </summary>
      <div className="providers-note-body">
        <p className="settings-hint">
          stable-diffusion.cpp draws here: no account, no network. You supply the <span className="mono">sd-server</span>{' '}
          build and the model file; the app starts it on 127.0.0.1 when you draw and stops it when you quit.
        </p>

        <div className="dictation-row">
          <span className={`chip${facts?.found ? ' ok' : ''}`}>{facts?.found ? 'Found' : 'Not set up'}</span>
          <span className="mono dictation-path" title={facts?.binary || ''}>
            {facts?.found ? facts.binary : `Choose ${facts?.expected_name || 'sd-server'} from a stable-diffusion.cpp build.`}
          </span>
          <button onClick={pickBinary} disabled={!!busy || drawing}>
            {facts?.found ? 'Change…' : 'Choose sd-server…'}
          </button>
        </div>

        <div className="dictation-field">
          <span>Model</span>
          <SelectPill
            label="Model"
            title="The weights sd-server loads"
            value={facts?.model || ''}
            disabled={!models.length || !!busy || drawing}
            options={models.length
              ? models.map((m) => ({ value: m.path, label: m.name, note: sizeOf(m.bytes) }))
              : [{ value: '', label: 'No model file found' }]}
            onPick={chooseModel}
          />
          <button onClick={pickModel} disabled={!!busy || drawing}>Choose file…</button>
        </div>
        <p className="settings-hint">
          Put weights (.safetensors, .ckpt or .gguf) in{' '}
          <span className="mono">{facts?.models_dir || '<app data>/sd-models'}</span> or beside sd-server, or pick any file.
        </p>

        <div className="dictation-row">
          <span className={`chip${status?.state === 'ready' ? ' ok' : ''}`}>
            {status?.state === 'ready'
              ? `Running on ${status.base_url}`
              : status?.state === 'starting'
                ? 'Loading the model…'
                : 'Stopped'}
          </span>
          <button onClick={() => guard('start', onStart)} disabled={!!busy || drawing || running || !facts?.found || !facts?.model}>
            Start
          </button>
          <button onClick={() => guard('stop', onStop)} disabled={!!busy || drawing || !running}>Stop</button>
          <button onClick={() => guard('refresh', onRefresh)} disabled={!!busy}>Look again</button>
        </div>
        {status?.detail && status.state !== 'ready' && <div className="chip-note">{status.detail}</div>}

        <div className="dictation-links">
          <button className="link-button" onClick={() => open(facts?.releases_url || '')}>stable-diffusion.cpp releases</button>
          <button className="link-button" onClick={() => open(facts?.models_url || '')}>model downloads</button>
        </div>
      </div>
    </details>
  );
}
