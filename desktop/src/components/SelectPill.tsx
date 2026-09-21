import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';

// A picker that belongs to this app rather than to the operating system.
//
// The screens used native <select> elements, which on Windows render as an OS
// dropdown: grey chrome, a different font, and a system highlight colour. In a
// dark, hand-styled window that is the detail that makes the whole thing read
// as a web page in a frame. This is the same choice as a pill that names the
// current value, opening a panel that lists the options with the reason for
// each -- which is also where a note like "needs a key" can be said at all.

export interface SelectOption {
  value: string;
  label: string;
  note?: string;
  /** Greyed and unselectable, with its note as the explanation. */
  disabled?: boolean;
}

interface SelectPillProps {
  label: string;
  title: string;
  value: string;
  options: SelectOption[];
  onPick: (value: string) => void;
  disabled?: boolean;
  mono?: boolean;
  filterable?: boolean;
  width?: number;
}

export default function SelectPill({
  label,
  title,
  value,
  options,
  onPick,
  disabled,
  mono,
  filterable,
  width,
}: SelectPillProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

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

  const current = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [options, filter]);

  return (
    <div className="select-pill" ref={boxRef} style={width ? { maxWidth: width } : undefined}>
      <button
        type="button"
        className={`pill ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={title}
      >
        <span className="pill-key">{label}</span>
        <span className={`pill-value ${mono ? 'mono' : ''}`}>{current ? current.label : value || '—'}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open && (
        <div className="select-panel" role="listbox" aria-label={title}>
          {filterable && options.length > 6 && (
            <input
              className="select-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              spellCheck={false}
              autoFocus
            />
          )}
          <div className="select-list">
            {shown.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`select-row ${o.value === value ? 'active' : ''}`}
                disabled={o.disabled}
                title={o.disabled && o.note ? o.note : o.label}
                onClick={() => {
                  if (o.disabled) return;
                  onPick(o.value);
                  setOpen(false);
                  setFilter('');
                }}
              >
                <span className={`select-row-name ${mono ? 'mono' : ''}`}>{o.label}</span>
                {o.note && <span className="select-row-note">{o.note}</span>}
              </button>
            ))}
            {shown.length === 0 && <div className="select-empty">Nothing matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
