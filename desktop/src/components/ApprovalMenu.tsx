import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
// approval.js reads these two off the globals they publish, and Chat can be
// the only screen ever opened -- so the composer, not Code, has to be the one
// that makes sure they are loaded.
import '../project-config.js';
import '../docker-sandbox.js';
import '../approval.js';

const approval: typeof import('../approval.js') = (globalThis as any).FreeAI4UApproval;

type LevelId = import('../approval.js').LevelId;

// How much the coding agent asks before it acts, chosen from the composer.
//
// The four rows are not four labels over one switch: each one is a pair of
// settings the app already had (approval.js), so picking one here is the same
// change as making it in Code, and reading it back reads those settings rather
// than a remembered choice. The consequence line under each label is the whole
// point of the menu -- a level nobody can predict the effect of is a level
// nobody can consent to.
//
// The riskiest row is marked `data-risk="high"`, which is what turns its line
// the colour this app uses for risk. Gold is spoken for: it means "the active
// tool", and one signal means one thing.

interface Props {
  /** Told after a pick, with the level that is now in force. */
  onChange?: (level: LevelId) => void;
  disabled?: boolean;
}

export default function ApprovalMenu({ onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<LevelId>(() => approval.current());
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const levels = approval.LEVELS;
  const chosen = approval.byId(level) || levels[0];

  // The Docker checkbox in Code owns half of what a level means, so the level
  // shown is re-read whenever this menu opens rather than trusted from before.
  useEffect(() => {
    if (!open) return;
    const now = approval.current();
    setLevel(now);
    setCursor(Math.max(0, levels.findIndex((l) => l.id === now)));
  }, [open, levels]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) itemsRef.current[cursor]?.focus();
  }, [open, cursor]);

  const pick = (id: LevelId) => {
    const now = approval.choose(id);
    setLevel(now);
    setOpen(false);
    triggerRef.current?.focus();
    if (onChange) onChange(now);
  };

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % levels.length); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + levels.length) % levels.length); return; }
    if (e.key === 'Home') { e.preventDefault(); setCursor(0); return; }
    if (e.key === 'End') { e.preventDefault(); setCursor(levels.length - 1); }
  };

  return (
    <div className="select-pill" ref={boxRef}>
      <button
        type="button"
        ref={triggerRef}
        className="tool-chip"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); }
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="How much the coding agent asks before it edits a file or runs a command"
      >
        <Icon name="shield" size={13} />
        <span>{chosen.label}</span>
        <Icon name="chevron-down" size={11} />
      </button>

      {open && (
        <div
          className="approval-menu"
          role="menu"
          aria-label="How much the agent asks"
          onKeyDown={onMenuKey}
          style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 60 }}
        >
          {levels.map((row, i) => (
            <button
              key={row.id}
              type="button"
              role="menuitemradio"
              aria-checked={row.id === level}
              data-risk={row.risk || undefined}
              className="approval-item"
              ref={(node) => { itemsRef.current[i] = node; }}
              tabIndex={i === cursor ? 0 : -1}
              onFocus={() => setCursor(i)}
              onClick={() => pick(row.id)}
            >
              <span aria-hidden="true">{row.id === level ? <Icon name="check" size={13} /> : null}</span>
              <span>{row.label}</span>
              <span className="approval-item-why">{row.why}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
