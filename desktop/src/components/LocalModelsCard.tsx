import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { pushToast } from './Toasts';
import {
  hasShell,
  localModelDelete,
  localModelDownload,
  localModelDownloadCancel,
  localModelStart,
  localModelStatus,
  localModelStop,
  localModelsList,
  localOpenReleases,
  localServerFind,
  localServerPick,
  onLocalDownload,
  type LocalDownloadProgress,
  type LocalModelFile,
  type LocalModelStatus,
  type LocalServerFacts,
} from '../bridge';
// UMD modules: loaded for their side effect, read off globalThis.
import '../local-models.js';
import '../hf-models.js';
import '../hf-auth.js';
import '../saved-models.js';
import MyModels from './MyModels';

const localModels: typeof import('../local-models.js') = (globalThis as any).FreeAI4ULocalModels;
const hfModels: typeof import('../hf-models.js') = (globalThis as any).FreeAI4UHfModels;
const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;
const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;

// Local models, in Settings.
//
// The card owns a few facts and nothing else: where the binary is, what the
// server is doing, what is downloaded, what a download is doing, and whether a
// model is too big for this machine. Everything else (which quant to offer,
// what a pasted link means, how much memory, what the state means) is a rule
// in src/local-models.js, where node:test can check it.
//
// Four ways a model gets here, top to bottom on the card:
//   1. paste anything from Hugging Face (a repo, a page, a file link) and pick
//      a quant from what the repo actually has;
//   2. the catalogue: Unsloth's recommended quants, one click each;
//   3. what is already downloaded (or half-downloaded and resumable);
//   4. what another tool already put on this PC (Unsloth Studio, the Hugging
//      Face cache, LM Studio, a folder you choose) -- run from where it is.

const MEMORY_POLL_MS = 15000;
// While a model is loading, status is what the ring is drawn from, so it is
// read once a second; the machine's memory facts are not worth that.
const LOADING_POLL_MS = 1000;
// Which repo a downloaded file came from, so a .part can be resumed and the
// chat can name the model. Not a secret; localStorage is fine.
const SOURCES_KEY = 'freeai4u.model_sources';
/** A neuraos://model link or an HF "Use this model" hand-off waits here. */
export const PENDING_MODEL_KEY = 'freeai4u.pending_model';
export const PENDING_MODEL_EVENT = 'freeai4u:pending-model';

const GB = 1024 * 1024 * 1024;

function readSources(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function rememberSource(file: string, repo: string) {
  try {
    const next = { ...readSources(), [file]: repo };
    localStorage.setItem(SOURCES_KEY, JSON.stringify(next));
  } catch { /* best effort */ }
}

// And where in the repo it lives (split sets usually sit in a quant folder),
// so a resume from the Downloaded list asks the Hub for the right path.
const SOURCE_PATHS_KEY = 'freeai4u.model_source_paths';

function readSourcePaths(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SOURCE_PATHS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function rememberSourcePath(file: string, hubPath: string) {
  try {
    const next = { ...readSourcePaths(), [file]: hubPath };
    localStorage.setItem(SOURCE_PATHS_KEY, JSON.stringify(next));
  } catch { /* best effort */ }
}

const baseName = (name: string) => name.split('/').pop() || name;

/** A repo file, or a whole split set folded into one row (name = part 1). */
interface HubFile {
  name: string;
  size: number;
  quant: string;
  url: string;
  parts: string[];
  partSizes: number[];
  complete: boolean;
}

export default function LocalModelsCard() {
  const [server, setServer] = useState<LocalServerFacts | null>(null);
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [gpu, setGpu] = useState(false);
  const facts = localModels.machine();

  // The models folder and its files.
  const [downloaded, setDownloaded] = useState<LocalModelFile[]>([]);
  const [modelsDir, setModelsDir] = useState('');
  // One download at a time (the shell enforces it too).
  const [progress, setProgress] = useState<LocalDownloadProgress | null>(null);
  // A split set is fetched one part at a time; while it is, this says which
  // part is in flight so each part's events read as progress through the set.
  const splitRef = useRef<import('../local-models.js').SplitDownloadState | null>(null);
  // Pause stops the whole set, not just the part in flight.
  const pausedRef = useRef(false);

  // "Add from Hugging Face".
  const [query, setQuery] = useState('');
  const [looking, setLooking] = useState(false);
  const [hub, setHub] = useState<{ repo: string; files: HubFile[]; gated: boolean; license: string } | null>(null);
  const [hubError, setHubError] = useState('');


  const refresh = useCallback(() => {
    if (!hasShell()) return;
    localServerFind().then(setServer).catch(() => setServer(null));
    localModelStatus().then(setStatus).catch(() => setStatus(null));
    localModelsList()
      .then((list) => { setDownloaded(list.files); setModelsDir(list.dir); })
      .catch(() => setDownloaded([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Download progress arrives as shell events; a finished download refreshes
  // the list so the file's Start button appears without a click.
  useEffect(() => {
    if (!hasShell()) return;
    let stop = () => {};
    onLocalDownload((event) => {
      const p = splitRef.current ? localModels.setProgress(splitRef.current, event) : event;
      setProgress(p);
      if (p.done || p.cancelled || p.error) refresh();
    }).then((unsubscribe) => { stop = unsubscribe; });
    return () => stop();
  }, [refresh]);

  const lookUp = useCallback((text: string) => {
    const ref = localModels.parseHfRef(text);
    if (!ref) {
      setHubError('Paste a Hugging Face repo (unsloth/gemma-4-E4B-it-GGUF), a model page link, or a file link.');
      setHub(null);
      return;
    }
    setLooking(true);
    setHubError('');
    hfModels.getModel(ref.repo, { authHeaders: hfAuth.authHeaders() })
      .then((card: any) => {
        // A split set is one row: part 1's name, every part's size summed.
        const files: HubFile[] = localModels.groupHubFiles(hfModels.ggufFiles(card).map((f: any) => ({
          name: f.name as string,
          size: f.size as number,
          quant: localModels.parseQuant(f.name),
          url: f.url as string,
        })));
        if (!files.length) {
          setHubError(`${ref.repo} has no GGUF files. Try the -GGUF repo of the same model (unsloth publishes one for most).`);
          setHub(null);
          return;
        }
        // A pasted file link names one file (any part of a set picks the set);
        // a pasted quant narrows to it.
        const wanted = ref.file ? files.filter((f) => f.parts.some((p) => p === ref.file || p.endsWith('/' + ref.file))) : [];
        const narrowed = !wanted.length && ref.quant ? files.filter((f) => f.quant === ref.quant) : [];
        setHub({
          repo: ref.repo,
          files: wanted.length ? wanted : narrowed.length ? narrowed : files,
          gated: hfModels.isGated(card),
          license: hfModels.licenseShort(card),
        });
      })
      .catch((e: unknown) => {
        setHubError((e as Error).message || String(e));
        setHub(null);
      })
      .finally(() => setLooking(false));
  }, []);

  // A neuraos:// link (or the app's own hand-off) names a model to look up.
  useEffect(() => {
    const take = () => {
      try {
        const raw = localStorage.getItem(PENDING_MODEL_KEY);
        if (!raw) return;
        localStorage.removeItem(PENDING_MODEL_KEY);
        const pending = JSON.parse(raw);
        if (!pending?.repo) return;
        const text = pending.file
          ? `https://huggingface.co/${pending.repo}/blob/main/${pending.file}`
          : pending.quant ? `${pending.repo}:${pending.quant}` : String(pending.repo);
        setQuery(text);
        lookUp(text);
      } catch { /* a bad hand-off is ignored, not fatal */ }
    };
    take();
    window.addEventListener(PENDING_MODEL_EVENT, take);
    return () => window.removeEventListener(PENDING_MODEL_EVENT, take);
  }, [lookUp]);

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

  /** Start a model: a file on disk when we have one, else llama.cpp's -hf. */
  const start = (entry: { id: string; context?: number; quant?: string }, tight: boolean, file?: string) => {
    setBusy(entry.id + (file || ''));
    setError('');
    localModelStart({
      repo: entry.id,
      quant: localModels.quantFor(entry),
      ...(file ? { file } : {}),
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

  /**
   * Download a file, or every part of a split set (`name` is any part; the
   * rest are worked out from it). Parts go one after another through the
   * shell's single-file download, so each keeps its own .part and resume;
   * `sizes` (from the repo listing) lets the bar measure the whole set.
   */
  const download = async (repo: string, name: string, sizes: number[] = []) => {
    if (!hasShell()) {
      pushToast('warn', 'Downloading needs the installed desktop app.');
      return;
    }
    const parts = localModels.splitParts(name);
    const label = baseName(parts[0]);
    for (const part of parts) {
      rememberSource(baseName(part), repo);
      rememberSourcePath(baseName(part), part);
    }
    setError('');
    pausedRef.current = false;
    const setTotal = sizes.length === parts.length && sizes.every((s) => s > 0) ? sizes.reduce((a, b) => a + b, 0) : 0;
    setProgress({ repo, file: parts[0], received: 0, total: setTotal, done: false, cancelled: false, error: '', path: '' });
    const token = hfAuth.accessToken()?.access_token;
    let firstPath = '';
    let bytes = 0;
    let already = true;
    try {
      for (let i = 0; i < parts.length; i++) {
        // A pause between two parts: the shell had nothing to cancel.
        if (pausedRef.current) {
          setProgress((p) => (p ? { ...p, cancelled: true } : p));
          pushToast('info', 'Download paused. Start it again to resume.');
          return;
        }
        splitRef.current = parts.length > 1
          ? { file: parts[0], index: i, count: parts.length, before: bytes, total: setTotal }
          : null;
        const file = parts[i];
        const result = await localModelDownload({ repo, file, ...(token ? { token } : {}) });
        if (result.cancelled) {
          pushToast('info', 'Download paused. Start it again to resume.');
          return;
        }
        if (i === 0) firstPath = result.path;
        bytes += result.bytes;
        already = already && !!result.already;
      }
      if (already) pushToast('info', parts.length > 1 ? 'Every part was already here.' : 'That file was already here.');
      else {
        // A finished download is one of the person's models: it goes
        // straight into the pickers under Unsloth Local. A split set is
        // saved as part 1; llama-server finds the rest beside it.
        savedModels.add({
          kind: 'unsloth',
          path: firstPath,
          bytes,
          detail: localModels.parseQuant(parts[0]),
          ...(parts.length > 1 ? { name: localModels.modelName(parts[0]) } : {}),
        });
        pushToast('ok', parts.length > 1
          ? `${localModels.modelName(parts[0])} (${parts.length} parts) downloaded and added to your models.`
          : `${label} downloaded and added to your models.`);
      }
    } catch (e: unknown) {
      const message = (e as Error).message || String(e);
      setError(message);
      setProgress((p) => (p ? { ...p, error: message } : p));
      pushToast('error', message.split('\n')[0]);
    } finally {
      // splitRef is left as it is: the last part's closing event can land
      // after the command returns, and must still read as the whole set.
      refresh();
    }
  };

  const cancelDownload = () => {
    pausedRef.current = true;
    localModelDownloadCancel().catch(() => { /* the event says what happened */ });
  };

  /** Delete a file, or every part of a split set, from the models folder. */
  const remove = async (file: string) => {
    setBusy('delete' + file);
    try {
      for (const part of localModels.splitParts(file)) await localModelDelete(part);
      pushToast('info', `${file} deleted.`);
    } catch (e: unknown) {
      setError((e as Error).message || String(e));
    } finally {
      setBusy('');
      refresh();
    }
  };

  const running = localModels.stateOf(status);
  const line = status ? localModels.statusLine(status) : '';
  // How far into the shell's own warm-up wait we are. Loading a 4B model takes
  // tens of seconds, and the shell gives up after three minutes; the ring is
  // that same deadline, so it tells the truth rather than pretending to know
  // how far the file read has got.
  const warm = localModels.warmup(status);

  // A loading model is polled once a second so the ring moves; an idle one is
  // not worth a request a second.
  useEffect(() => {
    const every = running === 'starting' ? LOADING_POLL_MS : MEMORY_POLL_MS;
    const timer = setInterval(() => {
      localModelStatus().then(setStatus).catch(() => { /* the card shows what it can see */ });
    }, every);
    return () => clearInterval(timer);
  }, [running]);

  const downloadedNames = useMemo(() => new Set(downloaded.filter((f) => !f.partial).map((f) => f.file)), [downloaded]);
  const partialNames = useMemo(() => new Set(downloaded.filter((f) => f.partial).map((f) => f.file)), [downloaded]);
  const sources = useMemo(() => readSources(), [downloaded]);
  const sourcePaths = useMemo(() => readSourcePaths(), [downloaded]);
  // The Downloaded list shows a split set as one model (size = every part).
  const downloadedSets = useMemo(() => localModels.groupLocalFiles(downloaded), [downloaded]);
  const defaultHubFile = useMemo(() => (hub ? localModels.pickDefaultFile(hub.files, facts) : null), [hub, facts.ramGb]);
  const downloading = !!progress && !progress.done && !progress.cancelled && !progress.error;
  const fitOf = (bytes: number, context = 16384) => localModels.fit({ sizeGb: bytes / GB, context }, facts);
  const isThisFile = (path: string) => !!status && running !== 'stopped' && !!status.file && (status.file === path || status.file.endsWith(path));

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
            {warm ? (
              <span
                className="warm-ring"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={warm.deadlineSeconds}
                aria-valuenow={warm.elapsedSeconds}
                aria-label="Waiting for the model to load"
                title={`The shell gives up after ${warm.deadlineSeconds}s`}
              >
                <svg viewBox="0 0 36 36" width="16" height="16" aria-hidden="true">
                  <circle className="warm-ring-track" cx="18" cy="18" r="15" />
                  <circle
                    className="warm-ring-fill"
                    cx="18"
                    cy="18"
                    r="15"
                    /* 2πr, so the dash is a real fraction of the circle. */
                    strokeDasharray={`${(warm.fraction * 94.2).toFixed(1)} 94.2`}
                  />
                </svg>
              </span>
            ) : (
              <Icon name={running === 'ready' ? 'check' : running === 'stopped' ? 'stop' : 'activity'} size={12} />
            )}
            {line || 'No local model running'}
            {warm && <span className="warm-ring-text">{warm.label}</span>}
          </span>
          {running === 'ready' || running === 'starting' ? (
            <button onClick={stop} disabled={!!busy}>Stop</button>
          ) : null}
          <button onClick={refresh} disabled={!!busy} title="Re-check the binary, the server and the models folder">
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

        <MyModels />

        {/* ---- 1. paste anything from Hugging Face ---------------------------- */}
        <h3 className="local-heading">Add from Hugging Face</h3>
        <form
          className="local-add"
          onSubmit={(e) => { e.preventDefault(); lookUp(query); }}
        >
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="unsloth/gemma-4-E4B-it-GGUF, a model page link, or a .gguf file link"
            spellCheck={false}
            aria-label="Hugging Face repository or link"
          />
          <button type="submit" disabled={looking || !query.trim()}>{looking ? 'Looking…' : 'Look up'}</button>
        </form>
        {hubError && <div className="chip-note">{hubError}</div>}
        {hub && (
          <div className="local-hub">
            <div className="local-hub-head">
              <span className="mono">{hub.repo}</span>
              {hub.license && <span className="settings-hint">{hub.license}</span>}
              {hub.gated && <span className="chip chip-warn">gated — sign in to Hugging Face in Library first</span>}
            </div>
            <div className="local-catalogue">
              {hub.files.map((f) => {
                const report = fitOf(f.size);
                // A split set is one row named by part 1; it is here only
                // when every part is.
                const split = localModels.isSplit(f.name);
                const risk = localModels.toolRisk(f.quant);
                const base = baseName(f.name);
                const partBases = f.parts.map(baseName);
                const have = partBases.every((b) => downloadedNames.has(b));
                const partial = !have && partBases.some((b) => partialNames.has(b) || downloadedNames.has(b));
                const isDefault = defaultHubFile?.name === f.name;
                return (
                  <div key={f.name} className={`local-row ${report.fits ? '' : 'cannot'} ${isDefault ? 'is-default' : ''}`}>
                    <div className="local-row-main">
                      <span className="local-row-name">
                        <span className="mono">{f.quant || base}</span>
                        {isDefault && <span className="chip chip-ok">recommended</span>}
                        {risk && <span className="chip chip-warn">{risk}</span>}
                        {split && <span className="chip">{f.parts.length} parts</span>}
                        {!f.complete && <span className="chip chip-warn">parts missing from the repo</span>}
                      </span>
                      <span className="local-row-note">{split ? `${localModels.modelName(base)} · ${f.parts.length} files` : base}</span>
                    </div>
                    <span className="local-row-size" title="Weights plus the cache for a 16k context">
                      {(f.size / GB).toFixed(1)} GB · needs ~{report.neededGb.toFixed(1)} GB
                    </span>
                    {have ? (
                      <button
                        onClick={() => start({ id: hub.repo, context: 16384 }, report.tight, base)}
                        disabled={!report.fits || !!busy || isThisFile(base)}
                        title={report.fits ? 'Run this file' : report.reason}
                      >
                        {isThisFile(base) ? 'Running' : 'Start'}
                      </button>
                    ) : (
                      <button
                        onClick={() => download(hub.repo, f.name, f.partSizes)}
                        disabled={downloading || !f.complete}
                        title={!f.complete
                          ? 'The repo does not list every part of this set'
                          : partial ? 'Resume the download' : split ? `Download all ${f.parts.length} parts to this PC` : 'Download to this PC'}
                      >
                        {partial ? 'Resume' : 'Download'}
                      </button>
                    )}
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
              <span className="settings-hint">{localModels.downloadLabel(progress)}</span>
              {downloading && <button onClick={cancelDownload}>Pause</button>}
              {(progress.done || progress.cancelled || !!progress.error) && (
                <button onClick={() => setProgress(null)}>Hide</button>
              )}
            </div>
            <div className="local-download-bar" aria-hidden="true">
              <div
                className="local-download-fill"
                style={{ width: `${progress.total ? Math.min(100, (progress.received / progress.total) * 100) : 5}%` }}
              />
            </div>
          </div>
        )}

        {/* ---- 2. the catalogue ------------------------------------------------ */}
        <h3 className="local-heading">Recommended (Unsloth GGUFs)</h3>
        <div className="local-catalogue">
          {localModels.CATALOGUE.map((entry: any) => {
            const report = localModels.fit(entry, facts);
            const have = downloadedNames.has(entry.file);
            const partial = partialNames.has(entry.file);
            const isThis = (status?.repo === entry.id || isThisFile(entry.file)) && running !== 'stopped';
            return (
              <div key={entry.id} className={`local-row ${report.fits ? '' : 'cannot'}`}>
                <div className="local-row-main">
                  <span className="local-row-name">
                    {entry.label} <span className="mono">{entry.quant}</span>
                    {have && <span className="chip chip-ok">on this PC</span>}
                  </span>
                  <span className="local-row-note">{entry.note}</span>
                </div>
                <span className="local-row-size" title="Weights plus the cache for the context it asks for">
                  {entry.sizeGb} GB · needs ~{report.neededGb.toFixed(1)} GB
                </span>
                {have ? (
                  <button
                    onClick={() => start(entry, report.tight, entry.file)}
                    disabled={!report.fits || !!busy || isThis}
                    title={report.fits ? 'Run this model here' : report.reason}
                  >
                    {isThis ? 'Running' : busy === entry.id + entry.file ? 'Starting…' : 'Start'}
                  </button>
                ) : (
                  <button
                    onClick={() => download(entry.id, entry.file)}
                    disabled={downloading || !report.fits}
                    title={report.fits ? (partial ? 'Resume the download' : 'Download to this PC') : report.reason}
                  >
                    {partial ? 'Resume' : 'Download'}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* ---- 3. what is downloaded ------------------------------------------- */}
        {downloaded.length > 0 && (
          <>
            <h3 className="local-heading">Downloaded</h3>
            <p className="settings-hint">In <span className="mono">{modelsDir}</span></p>
            <div className="local-catalogue">
              {downloadedSets.map((f) => {
                const report = fitOf(f.bytes);
                const repo = sources[f.file] || '';
                return (
                  <div key={f.path} className={`local-row ${f.partial || !report.fits ? 'cannot' : ''}`}>
                    <div className="local-row-main">
                      <span className="local-row-name">
                        <span className="mono">{f.file}</span>
                        {f.parts.length > 1 && <span className="chip">{f.parts.length} parts</span>}
                        {f.partial && <span className="chip chip-warn">incomplete</span>}
                      </span>
                      <span className="local-row-note">{repo || 'added by hand'}</span>
                    </div>
                    <span className="local-row-size">{(f.bytes / GB).toFixed(1)} GB</span>
                    {f.partial ? (
                      <button
                        onClick={() => (repo ? download(repo, sourcePaths[f.file] || f.file) : setError(`Nothing remembers where ${f.file} came from. Look it up above and download again.`))}
                        disabled={downloading}
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        onClick={() => start({ id: repo || f.file, context: 16384 }, report.tight, f.file)}
                        disabled={!report.fits || !!busy || isThisFile(f.file)}
                        title={report.fits ? 'Run this file' : report.reason}
                      >
                        {isThisFile(f.file) ? 'Running' : 'Start'}
                      </button>
                    )}
                    {!f.partial && (
                      <button
                        onClick={() => {
                          const r = savedModels.add({
                            kind: 'unsloth',
                            path: f.path,
                            bytes: f.bytes,
                            detail: localModels.parseQuant(f.file),
                            ...(f.parts.length > 1 ? { name: localModels.modelName(f.file) } : {}),
                          });
                          pushToast(r.added ? 'ok' : 'info', r.added ? `${f.file} added to your models.` : r.reason);
                        }}
                        title="Keep this model in the Chat, Design and Code pickers"
                      >
                        Add
                      </button>
                    )}
                    <button
                      onClick={() => remove(f.file)}
                      disabled={!!busy || downloading || isThisFile(f.file)}
                      title={f.parts.length > 1 ? `Delete all ${f.parts.length} parts from the models folder` : 'Delete this file from the models folder'}
                    >
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}

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
