import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { secretDelete, secretSet } from '../bridge';
import '../byok.js';

// NEURA-054: the user's own endpoints, added here and kept here. This panel
// already answers "which model on which service", so "and one more service"
// belongs in it rather than in a Settings page nobody opens mid-turn.
//
// The API key is the one thing this component does NOT keep. It sits in the
// form's own state for as long as it takes to type it, goes to the OS
// credential store through the shell, and the field is cleared in the same
// breath -- no module variable, no localStorage, no prop, never in a notice or
// a title attribute, and never passed to the request itself (byok.js explains
// why the call is made in Rust).
const byok: typeof import('../byok.js') = (globalThis as any).FreeAI4UByok;

// One control instead of two dropdowns.
//
// The header used to carry a provider <select> and a model <select> side by
// side, which is two buttons the user has to read as a pair, in a window that
// already had a sidebar, a rail, a status bar and three mode tabs. This is the
// same information as a single pill that names what will answer — the two facts
// the turn is actually about — and opens a panel to change either.
//
// The panel keeps the pair visible while it is open: providers on the left,
// that provider's models on the right, so "which model on which service" cannot
// be half-changed.

export interface ProviderOption {
  id: string;
  label: string;
  /** What this service's free tier meters. The engine reports it as `text`;
   *  `limitText` is the older field name and is still read. */
  freeTier?: { text?: string; limitText?: string; callsToday?: number; cap?: number } | null;
  /** Only on the local row: where llama.cpp is listening. */
  local?: boolean;
}

export interface ModelOption {
  id: string;
  free?: string;
}

interface ModelPickerProps {
  providers: ProviderOption[];
  models: ModelOption[];
  provider: string;
  model: string;
  onPick: (provider: string, model: string) => void;
  disabled?: boolean;
}

export default function ModelPicker({ providers, models, provider, model, onPick, disabled }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  // ---- the user's own endpoints (NEURA-054) -------------------------------

  const [endpoints, setEndpoints] = useState<import('../byok.js').ByokEndpoint[]>(() => byok.list());
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ label: '', baseUrl: '', model: '' });
  // The key, for as long as the form is open. Cleared below the moment the
  // credential store has it, and whenever the form closes.
  const [key, setKey] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const refresh = () => setEndpoints(byok.list());
    refresh();
    window.addEventListener(byok.CHANGED_EVENT, refresh);
    return () => window.removeEventListener(byok.CHANGED_EVENT, refresh);
  }, []);

  const closeForm = useCallback(() => {
    setAdding(false);
    setDraft({ label: '', baseUrl: '', model: '' });
    setKey('');
    setNotice('');
  }, []);

  // A panel that is closed holds no half-typed key.
  useEffect(() => {
    if (!open) closeForm();
  }, [open, closeForm]);

  const addEndpoint = useCallback(async () => {
    const base = byok.validateBaseUrl(draft.baseUrl);
    if (!base.ok) return setNotice(base.reason);
    const keyed = byok.validateKey(key);
    if (!keyed.ok) return setNotice(keyed.reason);
    const added = byok.add({ label: draft.label, baseUrl: draft.baseUrl, model: draft.model });
    if (!added.ok || !added.entry) return setNotice(added.reason);
    const stored = await byok.saveKey(added.entry.id, key, { secretSet });
    // Whatever happened, the key leaves the page here.
    setKey('');
    if (!stored.ok) {
      // An endpoint with no key is a row that can only fail: take it back out.
      await byok.remove(added.entry.id, { secretDelete });
      setEndpoints(byok.list());
      return setNotice(stored.reason);
    }
    setEndpoints(byok.list());
    closeForm();
    onPick(byok.PROVIDER_ID, added.entry.model);
    return undefined;
  }, [draft, key, closeForm, onPick]);

  const removeEndpoint = useCallback(async (id: string) => {
    // Deleting the endpoint deletes its key: byok.remove does the credential
    // store first and keeps the row if that fails.
    const gone = await byok.remove(id, { secretSet, secretDelete });
    setEndpoints(byok.list());
    if (!gone.ok) setNotice(gone.reason);
  }, []);

  // Clicking anywhere else, or Escape, closes it: a panel that has to be
  // dismissed by finding the button again is worse than two dropdowns.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The engine's providers, then one row for the user's own endpoints when
  // there are any. The screens know nothing about BYOK: this is the only place
  // that has to.
  const rows = useMemo<ProviderOption[]>(() => {
    const own = endpoints.length ? byok.providerRow() : null;
    return own ? [...providers, own] : providers;
  }, [providers, endpoints]);

  const offered = useMemo<ModelOption[]>(
    () => (provider === byok.PROVIDER_ID ? byok.modelsFor(provider) : models),
    [provider, models, endpoints],
  );

  const active = rows.find((p) => p.id === provider);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return offered;
    return offered.filter((m) => m.id.toLowerCase().includes(q));
  }, [offered, filter]);

  const label = [active?.label || provider || 'No provider', model || 'no model']
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="model-picker" ref={boxRef}>
      <button
        type="button"
        className={`model-pill ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Which service and model answer"
      >
        <Icon name="activity" size={13} />
        <span className="model-pill-label">{label}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>

      {open && (
        <div className="model-panel" role="dialog" aria-label="Choose a service and model">
          <div className="model-col">
            <div className="model-col-title">Service</div>
            <div className="model-list">
              {rows.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`model-row ${p.id === provider ? 'active' : ''}`}
                  onClick={() => onPick(p.id, '')}
                >
                  <span className="model-row-name">{p.label}</span>
                  {p.local && <span className="model-row-note">on this machine</span>}
                  {!p.local && (p.freeTier?.text || p.freeTier?.limitText) && (
                    <span className="model-row-note">{p.freeTier.text || p.freeTier.limitText}</span>
                  )}
                </button>
              ))}
              {rows.length === 0 && <div className="model-empty">No provider is configured on this engine.</div>}
            </div>

            {/* NEURA-054: any OpenAI-shaped endpoint, with the user's own key. */}
            {!adding && (
              <button type="button" className="model-row" onClick={() => setAdding(true)}>
                <span className="model-row-name">Add your own endpoint…</span>
                <span className="model-row-note">base URL + key</span>
              </button>
            )}
            {adding && (
              <div className="model-byok">
                <input
                  className="model-filter"
                  value={draft.baseUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                  placeholder="https://api.example.com/v1"
                  aria-label="Base URL"
                  spellCheck={false}
                  autoComplete="off"
                />
                <input
                  className="model-filter"
                  value={draft.model}
                  onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                  placeholder="model id"
                  aria-label="Model id"
                  spellCheck={false}
                  autoComplete="off"
                />
                <input
                  className="model-filter"
                  value={draft.label}
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                  placeholder="name (optional)"
                  aria-label="Name"
                  spellCheck={false}
                  autoComplete="off"
                />
                {/* type=password and no autofill: the key is never shown, never
                    remembered by the webview, and never leaves this field
                    except to the OS credential store. */}
                <input
                  className="model-filter"
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="API key"
                  aria-label="API key"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button type="button" className="model-row" onClick={() => { addEndpoint().catch((e) => setNotice(String(e?.message || e))); }}>
                  <span className="model-row-name">Save endpoint</span>
                </button>
                <button type="button" className="model-row" onClick={closeForm}>
                  <span className="model-row-name">Cancel</span>
                </button>
                <div className="model-empty">
                  The key is kept in this computer’s credential manager and sent by the app, never stored in the page.
                </div>
              </div>
            )}
            {notice && <div className="model-empty" role="alert">{notice}</div>}
          </div>

          <div className="model-col">
            <div className="model-col-title">
              Model
              <input
                className="model-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                spellCheck={false}
              />
            </div>
            <div className="model-list">
              {shown.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`model-row ${m.id === model ? 'active' : ''}`}
                  onClick={() => {
                    onPick(provider, m.id);
                    setOpen(false);
                  }}
                  title={m.id}
                >
                  <span className="model-row-name">{m.id}</span>
                  {m.free && <span className="model-row-note">{m.free}</span>}
                </button>
              ))}
              {shown.length === 0 && <div className="model-empty">No model matches.</div>}
            </div>
            {provider === byok.PROVIDER_ID && endpoints.length > 0 && (
              <div className="model-byok">
                {endpoints.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className="model-row"
                    onClick={() => { removeEndpoint(e.id).catch((err) => setNotice(String(err?.message || err))); }}
                    title={`${e.baseUrl} · ${e.model}`}
                  >
                    <span className="model-row-name">Remove {e.label} · {e.model}</span>
                    <span className="model-row-note">deletes its stored key too</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
