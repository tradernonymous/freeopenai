import { useCallback, useEffect, useState } from 'react';
import { pushToast } from './Toasts';
import { localModelsScan, ollamaStart, ollamaTags, pickFolder, type LocalModelFile } from '../bridge';
import '../saved-models.js';
import '../local-models.js';

const savedModels: typeof import('../saved-models.js') = (globalThis as any).FreeAI4USavedModels;
const localModels: typeof import('../local-models.js') = (globalThis as any).FreeAI4ULocalModels;

type SavedModel = import('../saved-models.js').SavedModel;
type SavedKind = import('../saved-models.js').SavedKind;

// My models: choose where models are, see what is there, keep the ones you
// want in the pickers.
//
// The toggle is the whole idea. OLLAMA is a connection: the app asks Ollama's
// own server what it has (the same list `ollama list` and Unsloth Studio's
// "Connected" tab show) and Ollama runs them, so nothing listed here can turn
// out unsupported. UNSLOTH is a folder: the app finds the GGUF files in it and
// llama-server runs them from where they are. Add remembers a name or a path;
// nothing is copied, and Remove forgets it without touching the file.

const GB = 1024 * 1024 * 1024;

interface Found {
  key: string;
  name: string;
  bytes: number;
  detail: string;
  path: string;
}

export default function MyModels() {
  const [kind, setKind] = useState<SavedKind>('ollama');
  const [saved, setSaved] = useState<SavedModel[]>(() => savedModels.list());
  const [where, setWhere] = useState(() => savedModels.folders());
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [offline, setOffline] = useState(false);
  const facts = localModels.machine();

  useEffect(() => {
    const onChanged = () => setSaved(savedModels.list());
    window.addEventListener(savedModels.CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(savedModels.CHANGED_EVENT, onChanged);
  }, []);

  // A different source is a different list.
  useEffect(() => { setFound(null); setNote(''); setOffline(false); }, [kind]);

  const connect = useCallback((base: string) => {
    setBusy('connect');
    setNote('');
    setOffline(false);
    ollamaTags(base)
      .then((body) => {
        savedModels.setFolder('ollama', base);
        const rows = savedModels.fromOllamaTags(body);
        setFound(rows.map((m) => ({ key: m.name, name: m.name, bytes: m.bytes, detail: m.detail, path: '' })));
        if (!rows.length) setNote('Ollama is running but has no models yet. Pull one with “ollama pull <name>”.');
      })
      .catch((e: unknown) => {
        setFound(null);
        setOffline(true);
        setNote(((e as Error).message || String(e)).split('\n')[0]);
      })
      .finally(() => setBusy(''));
  }, []);

  const startOllama = () => {
    setBusy('start');
    ollamaStart(where.ollama)
      .then((result) => {
        if (result.running) connect(where.ollama);
        else setNote('Ollama was started but has not answered yet. Try Connect again in a moment.');
      })
      .catch((e: unknown) => setNote(((e as Error).message || String(e)).split('\n')[0]))
      .finally(() => setBusy(''));
  };

  const scan = useCallback((dir: string) => {
    setBusy('scan');
    setNote('');
    localModelsScan(dir ? [dir] : [])
      .then((result) => {
        // With a folder chosen, only what is under it; without one, the usual places.
        const under = (f: LocalModelFile) => !dir || f.path.toLowerCase().startsWith(dir.toLowerCase());
        const rows = result.files.filter(under);
        setFound(rows.map((f) => ({
          key: f.path,
          name: savedModels.nameFromPath(f.path),
          bytes: f.bytes,
          detail: localModels.parseQuant(f.file),
          path: f.path,
        })));
        if (!rows.length) {
          setNote(dir
            ? `No GGUF files under ${dir}. Safetensors models cannot run here: llama-server needs GGUF.`
            : `No GGUF files in the usual folders (${result.dirs.join(', ') || 'none exist'}). Browse to where your models are.`);
        }
      })
      .catch((e: unknown) => setNote(((e as Error).message || String(e)).split('\n')[0]))
      .finally(() => setBusy(''));
  }, []);

  const browse = () => {
    pickFolder()
      .then((dir) => {
        if (!dir) return;
        savedModels.setFolder('unsloth', dir);
        setWhere(savedModels.folders());
        scan(dir);
      })
      .catch(() => { /* cancelled */ });
  };

  const add = (row: Found) => {
    const result = savedModels.add(kind === 'ollama'
      ? { kind, name: row.name, base: where.ollama, bytes: row.bytes, detail: row.detail }
      : { kind, name: row.name, path: row.path, bytes: row.bytes, detail: row.detail });
    if (!result.ok) pushToast('error', result.reason);
    else pushToast(result.added ? 'ok' : 'info', result.added ? `${row.name} added. It is in the model picker now.` : result.reason);
  };

  const remove = (entry: SavedModel) => {
    savedModels.remove(entry.id);
    pushToast('info', `${entry.name} removed from your models. The file itself was not touched.`);
  };

  const idOf = (row: Found) => savedModels.idFor(kind, kind === 'ollama' ? row.name : row.path);

  return (
    <div className="my-models">
      <h3 className="local-heading">My models</h3>
      {saved.length ? (
        <div className="local-catalogue">
          {saved.map((entry) => (
            <div key={entry.id} className="local-row">
              <div className="local-row-main">
                <span className="local-row-name">
                  <span className="mono">{entry.name}</span>
                  <span className="chip">{savedModels.PROVIDERS[entry.kind].label}</span>
                </span>
                <span className="local-row-note mono">{entry.kind === 'ollama' ? entry.base : entry.path}</span>
              </div>
              <span className="local-row-size">
                {entry.bytes ? `${(entry.bytes / GB).toFixed(1)} GB` : ''}{entry.detail ? ` · ${entry.detail}` : ''}
              </span>
              <button onClick={() => remove(entry)} title="Forget this model; the file or the Ollama model stays">Remove</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="settings-hint">
          Nothing added yet. Models you add below appear in Chat, Design and Code under
          {' '}<strong>Ollama Local</strong> and <strong>Unsloth Local</strong>.
        </p>
      )}

      <div className="my-models-source" role="tablist" aria-label="Where the models are">
        <button role="tab" aria-selected={kind === 'ollama'} className={kind === 'ollama' ? 'active' : ''} onClick={() => setKind('ollama')}>Ollama</button>
        <button role="tab" aria-selected={kind === 'unsloth'} className={kind === 'unsloth' ? 'active' : ''} onClick={() => setKind('unsloth')}>Unsloth / GGUF folder</button>
      </div>

      {kind === 'ollama' ? (
        <form className="local-add" onSubmit={(e) => { e.preventDefault(); connect(where.ollama); }}>
          <input
            type="text"
            value={where.ollama}
            onChange={(e) => setWhere({ ...where, ollama: e.target.value })}
            spellCheck={false}
            aria-label="Ollama address"
          />
          <button type="submit" disabled={!!busy}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button>
          {offline && <button type="button" onClick={startOllama} disabled={!!busy}>{busy === 'start' ? 'Starting…' : 'Start Ollama'}</button>}
        </form>
      ) : (
        <div className="local-add">
          <input type="text" value={where.unsloth} readOnly placeholder="No folder chosen yet" aria-label="Models folder" />
          <button onClick={browse} disabled={!!busy}>Browse…</button>
          <button onClick={() => scan(where.unsloth)} disabled={!!busy}>
            {busy === 'scan' ? 'Scanning…' : where.unsloth ? 'Rescan' : 'Scan the usual folders'}
          </button>
        </div>
      )}
      <p className="settings-hint">
        {kind === 'ollama'
          ? 'Ollama runs these itself, so every model it lists will work. Nothing is copied.'
          : 'GGUF files run from where they are, with the llama-server this app found (Unsloth Studio’s is used automatically).'}
      </p>
      {note && <div className="chip-note">{note}</div>}

      {found && found.length > 0 && (
        <div className="local-catalogue">
          {found.map((row) => {
            const have = saved.some((s) => s.id === idOf(row));
            // Ollama manages its own memory; the guard is for files this app loads.
            const report = kind === 'unsloth' ? localModels.fit({ sizeGb: row.bytes / GB, context: 16384 }, facts) : null;
            return (
              <div key={row.key} className={`local-row ${report && !report.fits ? 'cannot' : ''}`}>
                <div className="local-row-main">
                  <span className="local-row-name">
                    <span className="mono">{row.name}</span>
                    {row.detail && <span className="chip">{row.detail}</span>}
                  </span>
                  {row.path && <span className="local-row-note mono">{row.path}</span>}
                </div>
                <span className="local-row-size" title={report ? 'Weights plus a 16k cache and headroom' : undefined}>
                  {row.bytes ? `${(row.bytes / GB).toFixed(1)} GB` : ''}
                  {report ? ` · needs ~${report.neededGb.toFixed(1)} GB` : ''}
                </span>
                <button onClick={() => add(row)} disabled={have} title={report && !report.fits ? report.reason : 'Keep this model in the pickers'}>
                  {have ? 'Added' : 'Add'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
