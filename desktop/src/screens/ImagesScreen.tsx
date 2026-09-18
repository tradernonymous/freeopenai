import { useState, useEffect, useRef } from 'react';
import { api, imageUrlFrom } from '../api';

interface Row {
  id: string;
  label: string;
  ready: boolean;
  model: string;
  reason: string;
  sizes: string[];
}

interface Job {
  prompt: string;
  url: string;
  size: string;
  ts: number;
}

const SIZES = ['1024x1024', '1024x1792', '1792x1024', '512x512'];

export default function ImagesScreen() {
  const [rows, setRows] = useState<Row[]>([]);
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [gallery, setGallery] = useState<Job[]>([]);
  const [puter, setPuter] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refresh = () => {
    api.imageProviders()
      .then((data: any) => {
        const list: Row[] = Array.isArray(data) ? data : (Array.isArray(data?.providers) ? data.providers : []);
        setRows(list);
        // Free FLUX (OVHcloud) is the engine's own default: the first ready row wins.
        const firstReady = list.find((r) => r.ready);
        if (firstReady && !model) setModel(firstReady.model || '');
      })
      .catch((err) => setError((err as Error).message));
  };

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    // Store drawn images as object URLs; revoke on unload.
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const draw = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    try {
      const data: any = await api.imageGenerate({ prompt: text, ...(model ? { model } : {}), size });
      const url = imageUrlFrom(data);
      if (!url) {
        setError((data && data.error) || 'The engine drew nothing it could show. Try another size or provider.');
      } else {
        setGallery((prev) => [{ prompt: text, url, size, ts: Date.now() }, ...prev].slice(0, 60));
        setPrompt('');
      }
    } catch (err) {
      setError((err as Error).message);
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

  const open = (url: string) => {
    // Opening a data: URL in a new tab is blocked; fall back to an <a download>.
    const a = document.createElement('a');
    a.href = url;
    a.download = `freeai4u-${Date.now()}.png`;
    a.click();
  };

  const readyRows = rows.filter((r) => r.ready);
  const waitRows = rows.filter((r) => !r.ready);

  return (
    <div className="screen images">
      <header className="screen-header">
        <h1>Images</h1>
        <div className="header-actions">
          <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)}>
            {readyRows.map((r) => (
              <option key={r.id} value={r.model}>{r.label}{r.model ? ` · ${r.model}` : ''}</option>
            ))}
            {readyRows.length === 0 && <option value="">no image provider ready</option>}
          </select>
          <select className="model-select" value={size} onChange={(e) => setSize(e.target.value)}>
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </header>

      <div className="images-layout">
        <div className="images-composer">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKey}
            placeholder="Describe the image. Free FLUX draws first; nothing to configure."
            rows={3}
          />
          <div className="images-actions">
            <label className="toggle">
              <input type="checkbox" checked={puter} onChange={(e) => setPuter(e.target.checked)} />
              Allow Puter (bills your Puter account)
            </label>
            <button className="primary send-btn-wide" onClick={draw} disabled={busy || !prompt.trim()}>
              {busy ? 'Drawing…' : 'Draw'}
            </button>
          </div>
          {error && <div className="stream-error">{error}</div>}
          <details className="providers-note">
            <summary>Image providers on this engine ({readyRows.length} ready)</summary>
            <div className="providers-note-body">
              {readyRows.map((r) => (
                <div key={r.id} className="provider-row" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="setting-label">{r.label}</span>
                  <span className="setting-value ok">{r.model}</span>
                </div>
              ))}
              {waitRows.map((r) => (
                <div key={r.id} className="provider-row" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="setting-label">{r.label}</span>
                  <span className="setting-value warn">{r.reason || 'not ready'}</span>
                </div>
              ))}
            </div>
          </details>
        </div>

        <div className="images-gallery">
          {gallery.length === 0 && !busy && (
            <div className="empty-state">
              <div className="empty-icon">🖼</div>
              <h2>No images yet</h2>
              <p>Describe something above — the first image is one prompt away.</p>
            </div>
          )}
          {gallery.map((job) => (
            <figure key={job.ts} className="image-card">
              <img src={job.url} alt={job.prompt} loading="lazy" />
              <figcaption>
                <span>{job.prompt}</span>
                <span className="image-meta">{job.size} · <button onClick={() => open(job.url)}>Save</button></span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
