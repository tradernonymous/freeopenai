import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, imageUrlFrom } from '../api';
import Icon from '../components/Icon';
import SelectPill from '../components/SelectPill';
import LocalImagesCard from '../components/LocalImagesCard';
// UMD modules: loaded for their side effect, read off globalThis.
import '../images.js';
import '../failure.js';
import '../puter.js';
import '../image-run.js';
import { call, hasShell, puterSigninOpen } from '../bridge';

const images: typeof import('../images.js') = (globalThis as any).FreeAI4UImages;
const failure: typeof import('../failure.js') = (globalThis as any).FreeAI4UFailure;
const puter: typeof import('../puter.js') = (globalThis as any).FreeAI4UPuter;
// The runner Chat shares, the kept choice Chat reads, and Chat's hand-off.
const imageRun: typeof import('../image-run.js') = (globalThis as any).FreeAI4UImageRun;
type RunDeps = import('../image-run.js').RunDeps;
type ImagePlan = import('../image-run.js').ImagePlan;

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
//   * A picture can be CHANGED, not only made. The same three services do it,
//     with the edit chain rather than the generate one (images.modelsFor('edit')
//     -- a generation-leaning model on an edit drifts away from its source),
//     and the rule for what to send lives in images.editRequest, which is pure
//     and is what Chat will call. The source picture is read in this window and
//     goes nowhere until the button is pressed.
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
  /** The picture this one was made FROM, when it was a change rather than a draw. */
  from?: string;
}

/** A picture the user chose to change: its bytes, its name, and its own shape. */
interface Source {
  url: string;
  name: string;
  width: number;
  height: number;
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
  // The service, model and shape are kept (image-run.js CHOICE_KEY) so they
  // survive a restart and so Chat's /image draws with exactly what is shown
  // here. Only a pick is written: a default the screen fell back to stays a
  // default, and Chat falls back the same way (images.chosen).
  const kept = useMemo(() => imageRun.readChoice(), []);
  const [choiceId, setChoiceId] = useState(kept.choiceId);
  const [model, setModel] = useState('');
  const [size, setSize] = useState(
    images.SIZE_PRESETS.some((p: any) => p.id === kept.size) ? kept.size : images.SIZE_PRESETS[0].id,
  );
  const [prompt, setPrompt] = useState('');
  // Make a picture, or change one. Two tasks rather than two screens: the
  // service, model and shape decisions are the same ones either way.
  const [mode, setMode] = useState<'generate' | 'edit'>('generate');
  const [source, setSource] = useState<Source | null>(null);
  const [mask, setMask] = useState<Source | null>(null);
  const [dragging, setDragging] = useState(false);
  const sourceInput = useRef<HTMLInputElement>(null);
  const maskInput = useRef<HTMLInputElement>(null);
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
  //
  // And it follows the TASK too: an edit is offered the edit chain, because a
  // model picked for making things up is how an edit stops looking like the
  // picture it started from.
  const modelChoices = useMemo(
    () => (mode === 'edit'
      ? images.modelsForChoice(choice || {}, 'edit')
      : images.modelsForChoice(choice || {}, 'generate')),
    [choice, mode],
  );
  useEffect(() => {
    if (!choice) { setModel(''); return; }
    setModel(imageRun.modelFor(choice, mode === 'edit' ? 'edit' : 'generate', imageRun.readChoice()));
  }, [choice?.id, choice?.kind, mode]);

  // Reading a picture the user pointed at. It is read in this window and held
  // in this component: nothing is uploaded here, and nothing is sent anywhere
  // until they press the button below.

  /** The shape of a picture, so a change on this PC can keep it. */
  const measure = (url: string, name: string): Promise<Source> => imageRun.measurePicture(url)
    .then(({ width, height }) => ({ url, name, width, height }))
    .catch(() => { throw new Error(`${name} is not a picture this window can open.`); });

  const readPicture = (file: File) => new Promise<Source>((resolve, reject) => {
    if (!/^image\//.test(file.type)) {
      reject(new Error(`${file.name} is not a picture.`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => measure(String(reader.result || ''), file.name).then(resolve, reject);
    reader.readAsDataURL(file);
  });

  const takeSource = async (file: File) => {
    try {
      setSource(await readPicture(file));
      setMode('edit');
      setError(null);
    } catch (e) {
      setError({ summary: 'That picture was not used', upstream: (e as Error).message, walk: '', advice: 'Choose a PNG, JPEG or WebP file.' });
    }
  };

  const takeMask = async (file: File) => {
    try {
      setMask(await readPicture(file));
    } catch (e) {
      setError({ summary: 'That mask was not used', upstream: (e as Error).message, walk: '', advice: 'Choose a PNG where white marks the part to change.' });
    }
  };

  /** Change a picture that is already in the gallery, without saving it first. */
  const changeThis = async (job: Job) => {
    try {
      setSource(await measure(job.url, 'that picture'));
      setMode('edit');
      setPrompt('');
      setError(null);
    } catch (e) {
      setError({ summary: 'That picture cannot be changed here', upstream: (e as Error).message, walk: '', advice: 'Save it, then choose the file.' });
    }
  };

  // "Open in Images" from Chat: the picture waits in image-run.js's one-shot
  // slot. It is taken on arrival (or when this screen is already open and hears
  // the event) and becomes the source of a change -- then the slot is empty,
  // so nothing about the picture is left behind.
  useEffect(() => {
    const arrive = () => {
      const url = imageRun.takeHandoff();
      if (!url) return;
      measure(url, 'the picture from Chat')
        .then((picked) => { setSource(picked); setMask(null); setMode('edit'); setPrompt(''); setError(null); })
        .catch((e) => setError({ summary: 'That picture cannot be changed here', upstream: (e as Error).message, walk: '', advice: 'Save it from Chat, then choose the file.' }));
    };
    arrive();
    window.addEventListener(imageRun.HANDOFF_EVENT, arrive);
    return () => window.removeEventListener(imageRun.HANDOFF_EVENT, arrive);
  }, []);

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
   * The runner both tasks share with Chat (image-run.js): it carries out a plan
   * from images.js -- drawPlan for a draw, editRequest for a change -- over
   * whichever of the three routes the plan names. This screen only hands it the
   * means to reach the network and listens to what a local job reports.
   */
  const runDeps = (): RunDeps => ({
    api,
    imageUrlFrom,
    puter,
    call,
    stopped: () => stopPolling.current,
    onJob: (job) => setLocalJob((prev) => {
      if (!job) return null;
      if (job.since) return { id: job.id, label: job.label, since: job.since };
      return prev && prev.id === job.id ? { ...prev, label: job.label } : prev;
    }),
    onServer: (status) => setSdStatus(status),
  });

  /** Stop the job the user started. The server stays up: the model is loaded. */
  const cancelHere = async () => {
    const id = localJob?.id || '';
    stopPolling.current = true;
    setLocalJob(null);
    if (id) await call('sd_cancel', { id }).catch(() => undefined);
  };

  /**
   * Make or change a picture. What to send is decided by images.js (pure,
   * testable, the same calls Chat makes) and carried out by imageRun.runImage,
   * so this function only says what came back.
   */
  const run = async (kind: 'generate' | 'edit') => {
    const text = prompt.trim();
    if (busy || !choice || (kind === 'generate' && !text)) return;
    const from = kind === 'edit' ? source?.url || '' : '';
    const plan: ImagePlan = kind === 'edit'
      ? images.editRequest(choice, {
        prompt: text,
        source: from,
        mask: mask?.url || '',
        size,
        model,
        sourceWidth: source?.width,
        sourceHeight: source?.height,
      })
      : imageRun.drawPlan(choice, { prompt: text, size, model });
    // A refusal is the whole answer: nothing is sent, and the reason is the
    // sentence the plan gave rather than one invented here.
    if (!plan.route) {
      setError({ summary: 'Nothing was sent', upstream: '', walk: '', advice: plan.error });
      return;
    }
    setBusy(true);
    setError(null);
    setPuterMsg('');
    stopPolling.current = false;
    try {
      // Null means cancelled: the user stopped it, which is not an error and
      // not an image. (`finally` below puts the button back.)
      const done = await imageRun.runImage(kind, choice, plan, runDeps());
      if (!done) return;
      const job: Job = { prompt: plan.body.prompt, url: done.url, size, who: done.who, notes: done.notes, ts: Date.now() };
      setGallery((prev) => [kind === 'edit' ? { ...job, from } : job, ...prev].slice(0, 60));
      setPrompt('');
    } catch (err) {
      const told = imageRun.failureView(kind, plan.route, choice, err);
      setError({ summary: told.summary, upstream: told.upstream, walk: told.walk, advice: told.advice });
      if (plan.route === 'browser') setPuterMsg(told.message);
    } finally {
      setBusy(false);
    }
  };
  const submit = () => { run(mode === 'edit' ? 'edit' : 'generate'); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // One Save for a picture, wherever it is shown (Chat's picture actions use
  // the same one).
  const save = (url: string) => imageRun.savePicture(url);

  const readyCount = rows.filter((r) => r.kind === 'server' && r.ready).length;
  const editable = images.canEdit(choice || {});
  const blocked = !choice
    || (isBrowser ? !signedIn : !choice.ready)
    || (mode === 'edit' && (!editable || !source));
  // Who pays, said before the button rather than after the bill. An edit is a
  // request like any other: on the engine it spends the operator's key, on
  // Puter the signed-in account's credits, and on this PC nothing but minutes.
  const cost = !choice
    ? ''
    : isLocal
      ? 'Runs on this PC: no account, no network, a few minutes of this machine.'
      : isBrowser
        ? 'Puter charges the account that is signed in, the same as a draw.'
        : `Runs on the engine's ${choice.label} key — a change costs what a draw costs.`;

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
          {/* Pills instead of native dropdowns: a <select> opens an
              OS-styled menu, which is the one thing in a hand-styled window
              that still looked like a web page. Each pill names its current
              value and explains every other one. */}
          <SelectPill
            label="Task"
            title="Make a picture, or change one"
            value={mode}
            options={[
              { value: 'generate', label: 'Make a picture', note: 'from your words alone' },
              { value: 'edit', label: 'Change a picture', note: 'start from one you choose' },
            ]}
            onPick={(id) => setMode(id === 'edit' ? 'edit' : 'generate')}
          />
          <SelectPill
            label="Service"
            title="Which service draws"
            value={choice?.id || ''}
            options={rows.length
              ? rows.map((r) => ({
                value: r.id,
                label: r.label,
                // In the edit task a service that only draws is shown greyed
                // with the reason, rather than offered and then refused.
                disabled: mode === 'edit' && !images.canEdit(r),
                note: mode === 'edit' && !images.canEdit(r)
                  ? 'draws only, cannot change a picture'
                  : r.kind === 'browser' ? 'your browser' : r.ready ? '' : (r.reason || 'not ready'),
              }))
              : [{ value: '', label: 'no service reported' }]}
            onPick={(id) => { setChoiceId(id); imageRun.writeChoice({ choiceId: id, model: '', editModel: '' }); }}
          />
          <SelectPill
            label="Model"
            title="Which model draws"
            value={model}
            mono
            filterable
            options={modelChoices.map((m: string) => ({ value: m === 'service default' ? '' : m, label: m }))}
            onPick={(m) => {
              setModel(m);
              imageRun.writeChoice(mode === 'edit' ? { choiceId: choice?.id || '', editModel: m } : { choiceId: choice?.id || '', model: m });
            }}
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
            onPick={(id) => { setSize(id); imageRun.writeChoice({ size: id }); }}
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
            placeholder={mode === 'edit'
              ? 'Say what to change about the picture below — for example, make the sky clear and blue.'
              : isBrowser
                ? 'Describe the image. Puter draws it in your browser, on your account.'
                : 'Describe the image. Free FLUX draws first; pick another service above to change that.'}
            rows={3}
          />

          {/* The picture being changed. It is read in this window and stays
              here: it is sent only when the button below is pressed, and only
              to the service named on the row. */}
          {mode === 'edit' && (
            <div className="images-source">
              <div
                className={`dropzone${dragging ? ' dragging' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) takeSource(f);
                }}
                onClick={() => sourceInput.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') sourceInput.current?.click(); }}
              >
                <input
                  ref={sourceInput}
                  type="file"
                  hidden
                  accept="image/*"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) takeSource(f); e.currentTarget.value = ''; }}
                />
                {source
                  ? <img src={source.url} alt={source.name} style={{ maxHeight: 120, borderRadius: 6 }} />
                  : <span>Drop the picture to change — or click to choose one</span>}
              </div>
              {source && (
                <div className="dictation-row">
                  <span className="chip ok">{source.name}</span>
                  <span className="settings-hint">{source.width}×{source.height}</span>
                  <button onClick={() => { setSource(null); setMask(null); }}>Remove</button>
                </div>
              )}
              {/* A mask is a picture, not a brush: this app paints nothing.
                  White marks what may change, black what must stay. It is only
                  offered to a service that can actually be handed one. */}
              {source && images.canMask(choice || {}) && (
                <div className="dictation-row">
                  <span className="chip">{mask ? mask.name : 'No mask'}</span>
                  <span className="settings-hint">
                    Optional: a black-and-white picture, white where {choice?.label || 'the service'} may change things.
                  </span>
                  <input
                    ref={maskInput}
                    type="file"
                    hidden
                    accept="image/*"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) takeMask(f); e.currentTarget.value = ''; }}
                  />
                  <button onClick={() => maskInput.current?.click()}>Choose mask…</button>
                  {mask && <button onClick={() => setMask(null)}>Clear</button>}
                </div>
              )}
            </div>
          )}

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
            <button className="primary send-btn-wide" onClick={submit} disabled={busy || !prompt.trim() || blocked}>
              {busy
                ? (mode === 'edit' ? 'Changing…' : 'Drawing…')
                : isBrowser && !signedIn
                  ? (mode === 'edit' ? 'Sign in to change it' : 'Sign in to draw')
                  : mode === 'edit' ? 'Change the picture' : 'Draw'}
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
              <span className="settings-hint">
                {mode === 'edit' && !editable
                  ? images.editReason(choice || {})
                  : mode === 'edit' && !source
                    ? 'Choose the picture to change first.'
                    : (choice?.reason || 'Pick a service that is ready.')}
              </span>
            )}
          </div>
          {mode === 'edit' && cost && <div className="chip-note">{cost}</div>}
          {puterMsg && <div className="chip-note">{puterMsg}</div>}

          {error && (
            <div className="failure-card">
              <div className="failure-head">
                <strong>{error.summary}</strong>
                <button onClick={submit} disabled={busy}>Retry</button>
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
              <p>
                {mode === 'edit'
                  ? 'Choose a picture and say what to change — the service, model and shape are on the row.'
                  : 'Describe something above — the service, model and shape are on the row.'}
              </p>
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
                  {/* Change this one next, without saving it and finding it
                      again: it becomes the source in the composer, where it
                      sits beside whatever comes back. */}
                  <button onClick={() => changeThis(job)}>Change this</button>
                </span>
                {job.from && (
                  <span className="image-notes">Changed from a picture you chose</span>
                )}
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
