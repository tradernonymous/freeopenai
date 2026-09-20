import { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';
import { pushToast } from './Toasts';
import {
  hasShell,
  localModelStart,
  localModelStatus,
  localModelStop,
  localOpenReleases,
  localServerFind,
  localServerPick,
  type LocalModelStatus,
  type LocalServerFacts,
} from '../bridge';
// UMD module: loaded for its side effect, read off globalThis.
import '../local-models.js';

const localModels: typeof import('../local-models.js') = (globalThis as any).FreeAI4ULocalModels;

// Local models, in Settings.
//
// The card owns three facts and nothing else: where the binary is, what the
// server is doing, and whether a model is too big for this machine. Everything
// else (which quant, how much memory, what the state means) is a rule in
// src/local-models.js, where node:test can check it.

const MEMORY_POLL_MS = 15000;

export default function LocalModelsCard() {
  const [server, setServer] = useState<LocalServerFacts | null>(null);
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [gpu, setGpu] = useState(false);
  const facts = localModels.machine();

  const refresh = useCallback(() => {
    if (!hasShell()) return;
    localServerFind().then(setServer).catch(() => setServer(null));
    localModelStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      localModelStatus().then(setStatus).catch(() => { /* the card reports the failure it can see */ });
    }, MEMORY_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const chooseBinary = () => {
    if (!hasShell()) {
      pushToast('warn', 'Choosing the file needs the installed desktop app.');
      return;
    }
    setBusy('binary');
    localServerPick()
      .then((chosen) => {
        if (!chosen) return;
        pushToast('ok', 'llama-server is ready.');
        setError('');
      })
      .catch((e: unknown) => setError((e as Error).message || String(e)))
      .finally(() => {
        setBusy('');
        refresh();
      });
  };

  const start = (entry: any, tight: boolean) => {
    setBusy(entry.id);
    setError('');
    localModelStart({
      repo: entry.id,
      quant: localModels.quantFor(entry),
      ctx: localModels.contextFor(entry),
      threads: facts.cores,
      ...(gpu ? { gpuLayers: -1 } : {}),
    })
      .then((next) => {
        setStatus(next);
        pushToast('ok', localModels.statusLine(next));
      })
      .catch((e: unknown) => {
        const message = (e as Error).message || String(e);
        setError(message);
        pushToast('error', message.split('\n')[0]);
      })
      .finally(() => setBusy(''));
    if (tight) pushToast('warn', 'That model will use most of this machine’s memory. Close what you can.');
  };

  const stop = () => {
    setBusy('stop');
    localModelStop()
      .then(() => {
        setStatus(null);
        pushToast('info', 'Local model stopped.');
      })
      .catch((e: unknown) => setError((e as Error).message || String(e)))
      .finally(() => {
        setBusy('');
        refresh();
      });
  };

  const running = localModels.stateOf(status);
  const line = status ? localModels.statusLine(status) : '';

  if (!hasShell()) {
    return (
      <section className="settings-section">
        <h2>Local models</h2>
        <div className="settings-card">
          <p className="settings-hint">Running a model on this machine needs the installed desktop app.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h2>Local models</h2>
      <div className="settings-card">
        <div className="local-status-row">
          <span className={`chip ${running === 'ready' ? 'chip-ok' : running === 'error' ? 'chip-warn' : ''}`}>
            <Icon name={running === 'ready' ? 'check' : running === 'stopped' ? 'stop' : 'activity'} size={12} />
            {line || 'No local model running'}
          </span>
          {running === 'ready' || running === 'starting' ? (
            <button onClick={stop} disabled={!!busy}>Stop</button>
          ) : null}
          <button onClick={refresh} disabled={!!busy} title="Re-check the binary and the server">
            <Icon name="refresh" size={13} />
          </button>
        </div>

        {!server?.found && (
          <div className="local-missing">
            <p className="settings-hint">
              {server?.expected_name || 'llama-server'} is not here yet. Download the release for Windows, unzip it,
              then choose the file — the app copies it to its own folder and runs it from there.
            </p>
            <div className="local-status-row">
              <button onClick={() => localOpenReleases().catch(() => pushToast('warn', 'Could not open the browser.'))}>
                Open the llama.cpp releases
              </button>
              <button onClick={chooseBinary} disabled={busy === 'binary'}>
                {busy === 'binary' ? 'Opening…' : 'I have the file…'}
              </button>
            </div>
            <p className="settings-hint">
              Checked <span className="mono">{server?.dir || 'the app data folder'}</span> and your PATH.
            </p>
          </div>
        )}

        <div className="local-options">
          <label className="toggle">
            <input type="checkbox" checked={gpu} onChange={(e) => setGpu(e.target.checked)} />
            Offload to a GPU if one is available
          </label>
          <span className="settings-hint">
            About {facts.ramGb} GB of memory reported{facts.ramKnown ? '' : ' (estimated)'} · {facts.cores} threads
          </span>
        </div>

        <div className="local-catalogue">
          {localModels.CATALOGUE.map((entry: any) => {
            const report = localModels.fit(entry, facts);
            const isThis = status?.repo === entry.id && running !== 'stopped';
            return (
              <div key={entry.id} className={`local-row ${report.fits ? '' : 'cannot'}`}>
                <div className="local-row-main">
                  <span className="local-row-name">
                    {entry.label} <span className="mono">{entry.quant}</span>
                  </span>
                  <span className="local-row-note">{entry.note}</span>
                </div>
                <span className="local-row-size" title="Weights plus the cache for the context it asks for">
                  {entry.sizeGb} GB · needs ~{report.neededGb.toFixed(1)} GB
                </span>
                <button
                  onClick={() => start(entry, report.tight)}
                  disabled={!report.fits || !!busy || isThis}
                  title={report.fits ? 'Run this model here' : report.reason}
                >
                  {isThis ? 'Running' : busy === entry.id ? 'Starting…' : 'Start'}
                </button>
              </div>
            );
          })}
        </div>

        {error && <div className="failure-card">
          <div className="failure-head"><strong>That did not work</strong></div>
          <div className="failure-upstream">{error.split('\n').slice(0, 6).join('\n')}</div>
          <div className="failure-advice">{localModels.startAdvice(error)}</div>
        </div>}

        <p className="settings-hint">
          A local model answers in the Chat screen as <strong>Local</strong>. Your conversation never
          leaves this machine, and the engine’s free models stay available in the list beside it.
        </p>
      </div>
    </section>
  );
}
