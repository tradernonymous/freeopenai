import { useEffect, useRef, useState } from 'react';
import { pushToast } from './Toasts';
import SelectPill from './SelectPill';
import {
  call,
  hasShell,
  localModelDelete,
  localModelDownload,
  localModelDownloadCancel,
  onLocalDownload,
  openUrl,
  type LocalDownloadProgress,
} from '../bridge';
import { machineSpec } from '../run-model';
// UMD modules: loaded for their side effect, read off globalThis.
import '../local-models.js';
import '../hf-models.js';
import '../hf-auth.js';

const localModels: typeof import('../local-models.js') = (globalThis as any).FreeAI4ULocalModels;
const hfModels: typeof import('../hf-models.js') = (globalThis as any).FreeAI4UHfModels;
const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;

type HubOfferRow = import('../hf-models.js').HubOfferRow;
type Progress = LocalDownloadProgress & { part?: number; parts?: number };

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
// The binary is always the user's own, chosen through the native picker. The
// weights can be too, or they come from Hugging Face through "Add from
// Hugging Face" below, which lands them in sd-models where sd_find looks.

function sizeOf(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function progressLabel(p: Progress): string {
  const part = (p.parts || 0) > 1 ? ` · file ${p.part} of ${p.parts}` : '';
  if (p.error) return `Stopped: ${p.error}`;
  if (p.cancelled) return 'Cancelled. The partial files were removed.';
  if (p.done) return `${sizeOf(p.total || p.received)}, done`;
  if (!p.total) return `${sizeOf(p.received)} so far${part}`;
  return `${sizeOf(p.received)} of ${sizeOf(p.total)} · ${Math.floor((p.received / p.total) * 100)}%${part}`;
}

export interface HubDownloaderProps {
  kind: 'image' | 'voice';
  placeholder: string;
  /** A finished download: `path` is the first file (the model of a set). */
  onDownloaded: (path: string, row: HubOfferRow) => Promise<void> | void;
  disabled?: boolean;
}

/**
 * "Add from Hugging Face" for the Images and Dictation cards: the Local
 * models card's pattern (paste, look up, pick, download with progress) for
 * sd-server and whisper.cpp weights. Which files a repo offers, and whether
 * they fit this PC, are rules in hf-models.js; the formats and the folder
 * are enforced again by the shell (models.rs Kind).
 *
 * A component set is fetched file by file through the shell's one-file
 * download, with one bar across the set. Cancel is a real cancel here, not
 * the Local models card's pause: the shell drops the file in flight, and
 * this takes back every file of the set that this run fetched, because half
 * a set is only disk used.
 */
export function HubDownloader({ kind, placeholder, onDownloaded, disabled }: HubDownloaderProps) {
  const [query, setQuery] = useState('');
  const [looking, setLooking] = useState(false);
  const [offer, setOffer] = useState<{ repo: string; rows: HubOfferRow[]; gated: boolean; license: string } | null>(null);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [active, setActive] = useState('');
  const setRef = useRef<import('../local-models.js').SplitDownloadState | null>(null);
  const stopRef = useRef(false);
  const spec = machineSpec();

  useEffect(() => {
    if (!hasShell()) return;
    let stop = () => {};
    onLocalDownload((event) => {
      setProgress(setRef.current ? localModels.setProgress(setRef.current, event) : event);
    }, kind).then((unsubscribe) => { stop = unsubscribe; });
    return () => stop();
  }, [kind]);

  const lookUp = (text: string) => {
    const ref = localModels.parseHfRef(text);
    if (!ref) {
      setNote('Paste a Hugging Face repo (owner/name), a model page link, or a file link.');
      setOffer(null);
      return;
    }
    setLooking(true);
    setNote('');
    hfModels.getModel(ref.repo, { authHeaders: hfAuth.authHeaders() })
      .then((card) => {
        const found = kind === 'image' ? hfModels.imageOffer(card) : hfModels.voiceOffer(card);
        let rows = found.rows;
        let message = found.message;
        // A pasted file link narrows to its row, or says why it is not one.
        const wanted = hfModels.pastedFile(text);
        if (wanted) {
          const hit = rows.filter((r) => r.files.some((f) => f.name === wanted));
          if (hit.length) rows = hit;
          else message = hfModels.kindRefusal(kind, wanted) || message;
        }
        setNote(message);
        setOffer({ repo: ref.repo, rows, gated: hfModels.isGated(card), license: hfModels.licenseShort(card) });
      })
      .catch((e: unknown) => {
        setNote((e as Error).message || String(e));
        setOffer(null);
      })
      .finally(() => setLooking(false));
  };

  /** Take back what this run fetched. Files that were already here stay. */
  const discard = async (fetched: string[], set: string) => {
    for (const name of fetched) {
      await localModelDelete(name, { kind, ...(set ? { set } : {}) }).catch(() => { /* best effort */ });
    }
  };

  const download = async (repo: string, row: HubOfferRow) => {
    stopRef.current = false;
    setActive(row.key);
    const token = hfAuth.accessToken()?.access_token;
    const total = row.files.every((f) => f.size > 0) ? row.size : 0;
    setProgress({ repo, file: row.label, received: 0, total, done: false, cancelled: false, error: '', path: '' });
    const fetched: string[] = [];
    let firstPath = '';
    let before = 0;
    try {
      for (let i = 0; i < row.files.length; i++) {
        const file = row.files[i];
        // A cancel between two files: the shell had nothing in flight.
        if (stopRef.current) {
          await discard(fetched, row.set);
          setProgress((p) => (p ? { ...p, cancelled: true } : p));
          return;
        }
        setRef.current = row.files.length > 1
          ? { file: row.label, index: i, count: row.files.length, before, total }
          : null;
        const result = await localModelDownload({
          repo,
          file: file.name,
          kind,
          ...(row.set ? { set: row.set } : {}),
          ...(token ? { token } : {}),
        });
        if (result.cancelled) {
          await discard(fetched, row.set);
          pushToast('info', 'Download cancelled. Its partial files were removed.');
          return;
        }
        if (!result.already) fetched.push(file.name);
        if (i === 0) firstPath = result.path;
        before += result.bytes;
      }
      await onDownloaded(firstPath, row);
    } catch (e) {
      const message = ((e as Error).message || String(e)).split('\n')[0];
      setProgress((p) => (p ? { ...p, error: message } : p));
      pushToast('error', message);
    } finally {
      setActive('');
    }
  };

  const cancel = () => {
    stopRef.current = true;
    localModelDownloadCancel().catch(() => { /* the event says what happened */ });
  };

  if (!hasShell()) return null;
  const downloading = !!active;

  return (
    <>
      <h3 className="local-heading">Add from Hugging Face</h3>
      <form className="local-add" onSubmit={(e) => { e.preventDefault(); lookUp(query); }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          aria-label="Hugging Face repository or link"
        />
        <button type="submit" disabled={looking || !query.trim()}>{looking ? 'Looking…' : 'Look up'}</button>
      </form>
      {note && <div className="chip-note">{note}</div>}
      {offer && offer.rows.length > 0 && (
        <div className="local-hub">
          <div className="local-hub-head">
            <span className="mono">{offer.repo}</span>
            {offer.license && <span className="settings-hint">{offer.license}</span>}
            {offer.gated && <span className="chip chip-warn">gated: sign in to Hugging Face in Library first</span>}
          </div>
          <div className="local-catalogue">
            {offer.rows.map((row) => {
              const fit = hfModels.fitNote(row.size, kind, spec);
              return (
                <div key={row.key} className={`local-row ${fit.fitsRam ? '' : 'cannot'}`}>
                  <div className="local-row-main">
                    <span className="local-row-name">
                      <span className="mono">{row.label}</span>
                      {row.files.length > 1 && <span className="chip">{row.files.length} files</span>}
                      {row.set && <span className="chip chip-warn">Start here loads single files only</span>}
                    </span>
                    <span className="local-row-note">{row.note} · {fit.text}</span>
                  </div>
                  <span className="local-row-size" title="The download, and what running it needs">
                    {row.size ? sizeOf(row.size) : 'size unknown'} · needs ~{fit.neededGb.toFixed(1)} GB
                  </span>
                  <button
                    onClick={() => download(offer.repo, row)}
                    disabled={downloading || !!disabled}
                    title={row.files.length > 1 ? `Download all ${row.files.length} files as one set` : 'Download to this PC'}
                  >
                    {active === row.key ? 'Downloading…' : 'Download'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {progress && (
        <div className={`local-download ${progress.error ? 'is-error' : ''}`} role="status">
          <div className="local-download-head">
            <span className="mono">{progress.file.split('/').pop()}</span>
            <span className="settings-hint">{progressLabel(progress)}</span>
            {downloading && <button onClick={cancel}>Cancel</button>}
            {!downloading && <button onClick={() => setProgress(null)}>Hide</button>}
          </div>
          <div className="local-download-bar" aria-hidden="true">
            <div
              className="local-download-fill"
              style={{ width: `${progress.total ? Math.min(100, (progress.received / progress.total) * 100) : 5}%` }}
            />
          </div>
        </div>
      )}
    </>
  );
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

  // A single file lands in sd-models, where sd_find lists it, and becomes the
  // model straight away. A set lands in a folder of its own: Start here
  // passes sd-server one file (-m), and a set needs each part named with its
  // own flag, so it is not put in a list it cannot be started from.
  const downloaded = async (path: string, row: import('../hf-models.js').HubOfferRow) => {
    if (row.set) {
      pushToast('info', `${row.label} and its ${row.files.length - 1} other files are in sd-models/${row.set}. `
        + 'Start here loads one file, so run this set from sd-server with --diffusion-model, --vae and its encoder flags for now.', true);
      await onRefresh();
      return;
    }
    await call('sd_use_model', { path });
    pushToast('ok', `${row.label} downloaded. Local images will draw with it.`);
    await onRefresh();
  };

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

        <HubDownloader
          kind="image"
          placeholder="Comfy-Org/stable-diffusion-v1-5-archive, a model page link, or a .safetensors or .gguf link"
          disabled={drawing}
          onDownloaded={downloaded}
        />

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
