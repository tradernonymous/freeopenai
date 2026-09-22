import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, imageUrlFrom } from '../api';
import Icon from '../components/Icon';
import SelectPill from '../components/SelectPill';
import LocalImagesCard from '../components/LocalImagesCard';
// UMD modules: loaded for their side effect, read off globalThis.
import '../images.js';
import '../failure.js';
import '../puter.js';
import { call, hasShell, puterSigninOpen } from '../bridge';

const images: typeof import('../images.js') = (globalThis as any).FreeAI4UImages;
const failure: typeof import('../failure.js') = (globalThis as any).FreeAI4UFailure;
const puter: typeof import('../puter.js') = (globalThis as any).FreeAI4UPuter;

// Images: which service draws, with which model, at which shape.
//
// What changed, and why it matters:
//
//   * The service is named in the request. The old screen sent a bare model id
//     and let the engine walk its own order, so the pick on screen was not
//     always the service that drew -- and a model id means different things on
//     different services.
//   * Puter is a row in the list, not a checkbox: its own models (docs.puter.com
//     chains), its own sign-in, and its own error vocabulary ("credits used
//     up", not an upgrade dialog).
//   * A size is a preset with pixels and a ratio, so the shape asked for is the
//     shape sent, to whichever service answered.
//   * Every card says who drew it -- the engine reports the service it used --
//     and a failure says what was tried and what to do next.
//   * "This PC" is a third row: the user's own sd-server (sd.rs), started on
//     127.0.0.1 when they draw and stopped when they quit. It is slow, so it
//     reports what the server actually says -- queued, drawing, and for how
//     long -- and can be cancelled, instead of a spinner that cannot be
//     stopped. A job that finishes without bytes is an error, never a frame.

interface Job {
  prompt: string;
  url: string;
  size: string;
  who: string;
  notes: string[];
  ts: number;
}

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function ImagesScreen() {
  const [rows, setRows] = useState<any[]>([]);
  const [choiceId, setChoiceId] = useState('');
  const [model, setModel] = useState('');
  const [size, setSize] = useState(images.SIZE_PRESETS[0].id);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<null | { summary: string; upstream: string; walk: string; advice: string }>(null);
  const [gallery, setGallery] = useState<Job[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [puterMsg, setPuterMsg] = useState('');
  const [reportError, setReportError] = useState('');
  const [sd, setSd] = useState<SdFacts | null>(null);
  const [sdStatus, setSdStatus] = useState<SdStatus | null>(null);
  // The job on this PC: its id (so it can be cancelled), what the server last
  // said about it, and when it started.
  const [localJob, setLocalJob] = useState<{ id: string; label: string; since: number } | null>(null);
  const [localMs, setLocalMs] = useState(0);
  // Set when the user cancels or the screen goes away: the poll loop reads it
  // instead of running on after nobody is looking.
  const stopPolling = useRef(false);

  // What the shell knows about sd-server. A browser build has no shell, so it
  // simply has no "This PC" row -- not a row that fails when pressed.
  const readSd = useCallback(async () => {
    if (!hasShell()) return null;
    try {
      const facts = await call<SdFacts>('sd_find');
      setSd(facts);
      const status = await call<SdStatus>('sd_status');
      setSdStatus(status);
      return facts;
    } catch {
      // The shell answering nothing about sd-server is not an Images failure:
      // the engine services above still work.
      setSd(null);
      setSdStatus(null);
      return null;
    }
  }, []);

  const refresh = useCallback(() => {
    setReportError('');
    const local = readSd();
    api.imageProviders()
      .then(async (data: any) => setRows(images.withLocal(images.providerChoices(data), await local)))
      .catch(async (err: unknown) => {
        // Even with no engine, this PC can still draw: the row survives.
        setRows(images.withLocal([], await local));
        setReportError((err as Error).message || String(err));
      });
  }, [readSd]);

  useEffect(() => { refresh(); }, [refresh]);

  // The elapsed line ticks on its own so a long job does not look stuck.
  useEffect(() => {
    if (!localJob) return undefined;
    const timer = setInterval(() => setLocalMs(Date.now() - localJob.since), 1000);
    return () => clearInterval(timer);
  }, [localJob]);

  // Leaving the screen stops the polling. The server itself is not stopped:
  // it belongs to the user, the card starts and stops it, and the shell reaps
  // it on exit (sd.rs shutdown).
  useEffect(() => () => { stopPolling.current = true; }, []);

  // The Puter row reports its own state: the SDK knows whether anybody is
  // signed in, and that is a fact about the browser, not the engine.
  useEffect(() => {
    setSignedIn(puter.isSignedIn());
    const stop = puter.onAuthChange?.(() => setSignedIn(puter.isSignedIn()));
    return typeof stop === 'function' ? stop : undefined;
  }, []);

  const choice = useMemo(() => images.chosen(choiceId, rows), [choiceId, rows]);
  const isBrowser = choice?.kind === 'browser';
  const isLocal = images.isLocal(choice || {});

  // The model follows the service: an id from one service means nothing on the
  // next, which is exactly how a draw used to land on the wrong model. The list
  // is what the service itself reports it can be asked for -- several rows on a
  // gateway with more than one image model, one on a service that serves one.
  const modelChoices = useMemo(() => images.modelsForChoice(choice || {}, 'generate'), [choice]);
  useEffect(() => {
    if (!choice) { setModel(''); return; }
    setModel(images.modelFor(choice, 'generate'));
  }, [choice?.id, choice?.kind]);

  const connectPuter = () => {
    setPuterMsg('');
    setBusy(true);
    // Under the shell the sign-in page opens in the system browser THROUGH a
    // redirect page the shell serves on 127.0.0.1: Puter's page is blank
    // without a referrer, and a URL launched by Windows has none.
    const open = hasShell() ? (url: string) => puterSigninOpen(url) : undefined;
    puter.signIn(open ? { open } : undefined)
      .then((ok: boolean) => {
        setSignedIn(!!ok);
        setPuterMsg(ok ? 'Signed in to Puter.' : 'Sign-in did not finish. Finish it in the browser tab that opened, then try again.');
      })
      .catch((err: unknown) => setPuterMsg((err as Error).message || String(err)))
      .finally(() => setBusy(false));
  };

  /**
   * Draw on this machine: make sure sd-server is up, submit the job, then poll
   * it. Everything is awaited in small steps, so the window keeps painting
   * through the minutes an image takes, and every step reports what the server
   * itself said.
   *
   * Returns the data: URL, or '' when the user cancelled.
   */
  const drawHere = async (text: string): Promise<string> => {
    stopPolling.current = false;
    let status = await call<SdStatus>('sd_status');
    if (status.state !== 'ready') {
      setLocalJob({ id: '', label: 'Loading the model…', since: Date.now() });
      status = await call<SdStatus>('sd_start', { port: null, threads: null });
      setSdStatus(status);
    }
    if (stopPolling.current) { setLocalJob(null); return ''; }

    const request = images.localRequest({ prompt: text, size });
    const submitted = await call<any>('sd_generate', request);
    const id = String(submitted?.id || '');
    if (!id) throw new Error('The local server accepted the job without an id.');
    setLocalJob({ id, label: 'Queued', since: Date.now() });
    try {
      for (;;) {
        if (stopPolling.current) return '';
        await wait(900);
        if (stopPolling.current) return '';
        const view = images.localJobView(await call<any>('sd_job', { id }));
        setLocalJob((prev) => (prev && prev.id === id ? { ...prev, label: view.label } : prev));
        if (view.state === 'cancelled') return '';
        if (view.error) throw new Error(view.error);
        if (view.done) return view.url;
      }
    } finally {
      setLocalJob(null);
      setSdStatus(await call<SdStatus>('sd_status').catch(() => null as any));
    }
  };

  /** Stop the job the user started. The server stays up: the model is loaded. */
  const cancelHere = async () => {
    const id = localJob?.id || '';
    stopPolling.current = true;
    setLocalJob(null);
    if (id) await call('sd_cancel', { id }).catch(() => undefined);
  };

  const draw = async () => {
    const text = prompt.trim();
    if (!text || busy || !choice) return;
    setBusy(true);
    setError(null);
    setPuterMsg('');
    const shape = images.preset(size);
    try {
      let url = '';
      let who = '';
      let notes: string[] = [];
      if (isLocal) {
        // Empty means cancelled: the user stopped it, which is not an error
        // and not an image. (`finally` below puts the button back.)
        const drawn = await drawHere(text);
        if (!drawn) return;
        url = drawn;
        who = `This PC · ${choice.model || 'sd-server'}`;
      } else if (isBrowser) {
        if (!puter.isSignedIn()) throw new Error('Sign in to Puter first.');
        url = await puter.draw(text, { model, ratio: shape.ratio, quality: images.QUALITY });
        who = `${choice.label} · ${model}`;
      } else {
        const data: any = await api.imageGenerate(images.serverBody(choice, {
          prompt: text,
          size,
          kind: 'generate',
          model,
        }));
        url = imageUrlFrom(data) || '';
        const told = images.attribution(data);
        who = told.who || choice.label;
        notes = told.notes;
        if (!url) throw new Error((data && data.error) || 'The service answered without a picture.');
      }
      setGallery((prev) => [{ prompt: text, url, size, who, notes, ts: Date.now() }, ...prev].slice(0, 60));
      setPrompt('');
    } catch (err) {
      const e = err as any;
      const message = images.describePuterError(e) || (e && e.message) || String(e);
      if (isLocal) {
        setError({
          summary: 'This PC could not draw that',
          upstream: message,
          walk: '',
          advice: images.localAdvice(message),
        });
      } else if (isBrowser) {
        setError({
          summary: 'Puter could not draw that',
          upstream: message,
          walk: '',
          advice: images.puterAdvice(message),
        });
        setPuterMsg(message);
      } else {
        const told = failure.attributeImage({
          error: message,
          tried: Array.isArray(e?.tried) ? e.tried : [],
          asked: choice.label,
        });
        setError({ summary: told.summary, upstream: told.upstream, walk: told.walk, advice: told.advice });
      }
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      draw();
    }
  };

  const save = (url: string) => {
    // Opening a data: URL in a new tab is blocked; an anchor download is not.
    const a = document.createElement('a');
    a.href = url;
    a.download = `freeai4u-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const readyCount = rows.filter((r) => r.kind === 'server' && r.ready).length;
  const blocked = !choice || (isBrowser ? !signedIn : !choice.ready);

  return (
    <div className="screen images">
      <header className="screen-header">
        <h1>Images</h1>
        <span className="header-note">
          {readyCount > 0
            ? `${readyCount} service${readyCount === 1 ? '' : 's'} ready on the engine`
            : 'No engine service ready'}
          {signedIn ? ' · Puter signed in' : ''}
        </span>
        <div className="header-actions">
          {/* Three pills instead of three native dropdowns: a <select> opens an
              OS-styled menu, which is the one thing in a hand-styled window
              that still looked like a web page. Each pill names its current
              value and explains every other one. */}
          <SelectPill
            label="Service"
            title="Which service draws"
            value={choice?.id || ''}
            options={rows.length
              ? rows.map((r) => ({
                value: r.id,
                label: r.label,
                note: r.kind === 'browser' ? 'your browser' : r.ready ? '' : (r.reason || 'not ready'),
              }))
              : [{ value: '', label: 'no service reported' }]}
            onPick={(id) => setChoiceId(id)}
          />
          <SelectPill
            label="Model"
            title="Which model draws"
            value={model}
            mono
            filterable
            options={modelChoices.map((m: string) => ({ value: m === 'service default' ? '' : m, label: m }))}
            onPick={(m) => setModel(m)}
          />
          <SelectPill
            label="Shape"
            title="Aspect and pixels"
            value={size}
            options={images.SIZE_PRESETS.map((p: any) => ({
              value: p.id,
              label: p.label,
              note: `${p.width}×${p.height}`,
            }))}
            onPick={(id) => setSize(id)}
          />
          <button onClick={refresh} title="Re-read the engine's image services" aria-label="Refresh">
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </header>

      <div className="images-layout">
        <div className="images-composer">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKey}
            placeholder={isBrowser
              ? 'Describe the image. Puter draws it in your browser, on your account.'
              : 'Describe the image. Free FLUX draws first; pick another service above to change that.'}
            rows={3}
          />

          {/* Puter is a service, so its sign-in is always on screen -- not
              only when it is the service selected. Someone who wants it should
              not have to select it first to find out they cannot use it yet,
              and someone who is signed in should be able to sign out without
              switching services. */}
          <div className={`puter-strip ${isBrowser ? 'is-chosen' : ''}`}>
            <span className={`chip ${signedIn ? 'chip-ok' : 'chip-warn'}`}>
              <Icon name={signedIn ? 'check' : 'alert'} size={12} />
              {signedIn ? 'Puter: signed in' : 'Puter: not signed in'}
            </span>
            {!signedIn && (
              <button onClick={connectPuter} disabled={busy}>Sign in to Puter</button>
            )}
            {signedIn && (
              <button
                onClick={() => { puter.signOut().then(() => { setSignedIn(false); setPuterMsg('Signed out of Puter.'); }); }}
              >
                Sign out
              </button>
            )}
            <span className="settings-hint">
              {isBrowser
                ? (choice?.note || 'Puter bills the account that is signed in, not this app.')
                : 'Signing in adds Puter as a service you can pick above: it draws in this window, on your own Puter account.'}
            </span>
          </div>

          <div className="images-actions">
            <button className="primary send-btn-wide" onClick={draw} disabled={busy || !prompt.trim() || blocked}>
              {busy ? 'Drawing…' : isBrowser && !signedIn ? 'Sign in to draw' : 'Draw'}
            </button>
            {/* A job on this PC is minutes of this machine's own work, so it
                says what the server said and can be stopped -- the one thing a
                spinner cannot offer. */}
            {localJob && (
              <>
                <span className="chip-note">
                  {localJob.label} · {images.localElapsed(localMs)}
                </span>
                <button onClick={cancelHere}>Cancel</button>
              </>
            )}
            {blocked && !isBrowser && !busy && (
              <span className="settings-hint">{choice?.reason || 'Pick a service that is ready.'}</span>
            )}
          </div>
          {puterMsg && <div className="chip-note">{puterMsg}</div>}

          {error && (
            <div className="failure-card">
              <div className="failure-head">
                <strong>{error.summary}</strong>
                <button onClick={draw} disabled={busy}>Retry</button>
              </div>
              {error.upstream && <div className="failure-upstream">{error.upstream}</div>}
              {error.walk && <div className="failure-note">{error.walk}</div>}
              <div className="failure-advice">{error.advice}</div>
            </div>
          )}
          {reportError && <div className="stream-error">{reportError} — the engine may be unreachable.</div>}

          <details className="providers-note" open={readyCount === 0}>
            <summary>Image services ({readyCount} ready)</summary>
            <div className="providers-note-body">
              {rows.map((r) => (
                <div key={r.id} className="provider-row">
                  <span className="setting-label">
                    {r.label}{r.kind === 'browser' ? ' (browser)' : r.kind === 'local' ? ' (this machine)' : ''}
                  </span>
                  <span className={`setting-value ${r.kind === 'browser' ? 'warn' : r.ready ? 'ok' : 'warn'}`}>
                    {r.kind === 'browser'
                      ? (signedIn ? 'signed in' : 'needs sign-in')
                      : (r.ready ? (r.model || 'ready') : (r.reason || 'not configured'))}
                  </span>
                </div>
              ))}
              {rows.length === 0 && <div className="empty">The engine reported no image services.</div>}
            </div>
          </details>

          <LocalImagesCard
            facts={sd}
            status={sdStatus}
            drawing={busy}
            onRefresh={async () => { await readSd(); refresh(); }}
            onStart={async () => { setSdStatus(await call<SdStatus>('sd_start', { port: null, threads: null })); }}
            onStop={async () => { await call('sd_stop'); setSdStatus(await call<SdStatus>('sd_status')); }}
          />
        </div>

        <div className="images-gallery">
          {gallery.length === 0 && !busy && (
            <div className="empty-state">
              <div className="empty-icon"><Icon name="image" size={28} /></div>
              <h2>No images yet</h2>
              <p>Describe something above — the service, model and shape are on the row.</p>
            </div>
          )}
          {gallery.map((job) => (
            <figure key={job.ts} className="image-card">
              <img src={job.url} alt={job.prompt} loading="lazy" />
              <figcaption>
                <span className="image-prompt">{job.prompt}</span>
                <span className="image-meta">
                  <span className="image-by" title="Which service drew this">
                    <Icon name="activity" size={11} /> {job.who || 'the engine'}
                  </span>
                  <span className="image-size">{images.sizeLabel(job.size)}</span>
                  <button onClick={() => save(job.url)}>Save</button>
                </span>
                {job.notes.length > 0 && (
                  <span className="image-notes">{job.notes.join(' · ')}</span>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
