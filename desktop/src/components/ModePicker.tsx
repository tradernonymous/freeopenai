import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

// One control instead of a row of tabs.
//
// The header used to carry three buttons (Chat / Plan / Build) that were always
// there, always the same width, and read as navigation while actually being a
// property of the next message. This is that choice as a single pill that names
// what the next send does, opening a short list with the reason for each --
// fewer permanent controls, and the explanation appears exactly when someone is
// choosing rather than sitting in the layout forever.

export type ChatMode = 'chat' | 'plan' | 'build';

const MODES: Array<{ id: ChatMode; label: string; icon: 'chat' | 'file' | 'build'; note: string }> = [
  { id: 'chat', label: 'Chat', icon: 'chat', note: 'Answer in the conversation. Nothing runs anywhere.' },
  { id: 'plan', label: 'Plan', icon: 'file', note: 'Draft a plan first, then decide whether to build it.' },
  { id: 'build', label: 'Build', icon: 'build', note: 'Start a real build session; approvals appear in Builds.' },
];

interface ModePickerProps {
  mode: ChatMode;
  onPick: (mode: ChatMode) => void;
  disabled?: boolean;
}

export default function ModePicker({ mode, onPick, disabled }: ModePickerProps) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const active = MODES.find((m) => m.id === mode) || MODES[0];

  // Escape or a click anywhere else closes it, the same as the model pill.
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

  return (
    <div className="mode-picker" ref={boxRef}>
      <button
        type="button"
        className={`mode-pill mode-${active.id} ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`What the next message does: ${active.label.toLowerCase()}`}
      >
        <Icon name={active.icon} size={13} />
        <span className="mode-pill-label">{active.label}</span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open && (
        <div className="mode-panel" role="dialog" aria-label="What the next message does">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mode-row ${m.id === active.id ? 'active' : ''}`}
              onClick={() => {
                onPick(m.id);
                setOpen(false);
              }}
            >
              <Icon name={m.icon} size={14} />
              <span className="mode-row-main">
                <span className="mode-row-name">{m.label}</span>
                <span className="mode-row-note">{m.note}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
