import { useEffect, useState } from 'react';
import { pushToast } from './Toasts';
import SelectPill from './SelectPill';
import { hasShell, openUrl, whisperFind, whisperPickBinary, type WhisperFacts } from '../bridge';
import { ENGINE_KEY, LANGUAGE_KEY, MODEL_KEY, normalizeEngine, pickModel, type EngineSetting } from '../dictate';
import { HubDownloader } from './LocalImagesCard';

// Dictation, in Settings: which Whisper the mic uses. Local = the user's own
// whisper.cpp build (whisper-cli) and a ggml model, run on this PC by the
// shell; Hugging Face = the signed-in token. The binary is never downloaded
// for them; a ggml model can be, through "Add from Hugging Face", into
// whisper-models where whisper_find already looks.

const RELEASES = 'https://github.com/ggml-org/whisper.cpp/releases/latest';
const MODELS = 'https://huggingface.co/ggerganov/whisper.cpp/tree/main';

function read(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
  } catch { /* this session keeps it */ }
}

function sizeOf(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export default function DictationCard() {
  const shell = hasShell();
  const [engine, setEngine] = useState<EngineSetting>(() => normalizeEngine(read(ENGINE_KEY)));
  const [model, setModel] = useState(() => read(MODEL_KEY));
  const [language, setLanguage] = useState(() => read(LANGUAGE_KEY));
  const [facts, setFacts] = useState<WhisperFacts | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!shell) return;
    try { setFacts(await whisperFind()); } catch (e) { pushToast('error', String((e as Error).message || e)); }
  };
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async () => {
    setBusy(true);
    try {
      const path = await whisperPickBinary();
      if (path) pushToast('ok', `Dictation will use ${path}.`);
      await refresh();
    } catch (e) {
      pushToast('error', ((e as Error).message || String(e)).split('\n')[0]);
    } finally {
      setBusy(false);
    }
  };

  const chooseEngine = (value: EngineSetting) => { setEngine(value); write(ENGINE_KEY, value === 'auto' ? '' : value); };
  const chooseModel = (value: string) => { setModel(value); write(MODEL_KEY, value); };
  const chooseLanguage = (value: string) => {
    const clean = value.trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 4);
    setLanguage(clean);
    write(LANGUAGE_KEY, clean);
  };

  const models = facts?.models || [];
  const active = pickModel(model, models);
  const open = (url: string) => { openUrl(url).catch(() => window.open(url, '_blank', 'noopener')); };

  return (
    <section className="settings-section dictation-card">
      <h2>Dictation</h2>
      <div className="settings-card">
        <p className="settings-hint">
          The mic in the composer turns speech into text with Whisper — on this PC through whisper.cpp (private, no account),
          or on Hugging Face when you are signed in. Windows' own Win+H works everywhere too.
        </p>

        <div className="dictation-engines" role="radiogroup" aria-label="Dictation engine">
          {([
            ['auto', 'Automatic', 'This PC when set up, else Hugging Face'],
            ['local', 'This PC', 'whisper.cpp only'],
            ['hf', 'Hugging Face', 'the signed-in token only'],
          ] as Array<[EngineSetting, string, string]>).map(([value, label, note]) => (
            <label key={value} className={`dictation-engine${engine === value ? ' active' : ''}`}>
              <input type="radio" name="dictation-engine" checked={engine === value} onChange={() => chooseEngine(value)} />
              <span className="dictation-engine-label">{label}</span>
              <span className="dictation-engine-note">{note}</span>
            </label>
          ))}
        </div>

        <h3 className="local-heading">whisper.cpp on this PC</h3>
        {!shell && <p className="settings-hint">Local dictation needs the desktop app.</p>}
        {shell && (
          <>
            <div className="dictation-row">
              <span className={`chip${facts?.found ? ' ok' : ''}`}>{facts?.found ? 'Found' : 'Not set up'}</span>
              <span className="mono dictation-path" title={facts?.binary || ''}>
                {facts?.found ? facts.binary : `Choose ${facts?.expected_name || 'whisper-cli.exe'} from a whisper.cpp release.`}
              </span>
              <button onClick={pick} disabled={busy}>{facts?.found ? 'Change…' : 'Choose whisper-cli…'}</button>
              <button onClick={refresh} disabled={busy}>Look again</button>
            </div>

            <div className="dictation-field">
              <span>Model</span>
              <SelectPill
                label="Model"
                title="The ggml model whisper.cpp runs"
                value={active}
                disabled={!models.length}
                options={models.length
                  ? models.map((m) => ({ value: m.path, label: m.name, note: sizeOf(m.bytes) }))
                  : [{ value: '', label: 'No ggml .bin model found' }]}
                onPick={chooseModel}
              />
            </div>
            <p className="settings-hint">
              Put ggml models (for example ggml-base.en.bin or ggml-small.bin) in{' '}
              <span className="mono">{facts?.models_dir || '<app data>/whisper-models'}</span> or beside whisper-cli.
            </p>

            <HubDownloader
              kind="voice"
              placeholder="ggerganov/whisper.cpp, a model page link, or a ggml .bin link"
              onDownloaded={async (path, row) => {
                // It lands where whisper_find looks, so it is in the list on
                // the next read; choosing it saves the person a second click.
                chooseModel(path);
                await refresh();
                pushToast('ok', `${row.label} downloaded. Dictation will use it.`);
              }}
            />

            <label className="dictation-field">
              <span>Language</span>
              <input value={language} placeholder="auto (or en, de, fr…)" onChange={(e) => chooseLanguage(e.target.value)} />
            </label>
          </>
        )}

        <div className="dictation-links">
          <button className="link-button" onClick={() => open(RELEASES)}>whisper.cpp releases</button>
          <button className="link-button" onClick={() => open(MODELS)}>ggml model downloads</button>
        </div>
      </div>
    </section>
  );
}
