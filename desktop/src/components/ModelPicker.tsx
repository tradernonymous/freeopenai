import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';

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

  const active = providers.find((p) => p.id === provider);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, filter]);

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
              {providers.map((p) => (
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
              {providers.length === 0 && <div className="model-empty">No provider is configured on this engine.</div>}
            </div>
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
          </div>
        </div>
      )}
    </div>
  );
}
