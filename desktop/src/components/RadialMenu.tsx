// Right-click, and the actions for what is under the pointer open around it.
//
// A dropdown at the cursor is a list you read top to bottom; a ring is a target
// you learn once and then hit without reading, because every action always sits
// in the same direction. That is the whole reason the shell uses one here: the
// actions on a reply (copy it, ask about it, rework it) are the same four every
// time, and the pointer is already where the text is.
//
// Placement is not decided here -- src/radial.js owns that rule and is tested
// without a browser. This component draws what it returns.
import { useEffect, useRef } from 'react';
import Icon, { type IconName } from './Icon';
import '../radial.js';

const radial: typeof import('../radial.js') = (globalThis as any).FreeAI4URadial;

export interface RadialItem {
  id: string;
  label: string;
  icon?: IconName;
  run: () => void;
}

interface Props {
  /** Where the pointer was, in viewport coordinates. */
  x: number;
  y: number;
  items: RadialItem[];
  /** What the ring is acting on, for a screen reader. */
  label?: string;
  onClose: () => void;
}

export default function RadialMenu({ x, y, items, label, onClose }: Props) {
  const firstRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Escape is the way out of everything else that opens over the app, so it
    // is the way out of this too.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    firstRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ring = radial.place({
    x,
    y,
    count: items.length,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });

  return (
    <div
      className="radial-scrim"
      role="presentation"
      onMouseDown={onClose}
      onContextMenu={(event) => { event.preventDefault(); onClose(); }}
    >
      <div
        className="radial"
        role="menu"
        aria-label={label ? `Actions for ${label}` : 'Actions for this message'}
        style={{ left: ring.cx, top: ring.cy }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="radial-hub" aria-hidden="true" />
        {items.map((item, index) => {
          const point = ring.items[index];
          return (
            <button
              key={item.id}
              ref={index === 0 ? firstRef : undefined}
              type="button"
              role="menuitem"
              className="radial-item"
              style={{ left: point.x - ring.cx, top: point.y - ring.cy }}
              onClick={() => { onClose(); item.run(); }}
            >
              {item.icon && <Icon name={item.icon} size={16} />}
              <span className="radial-label">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
