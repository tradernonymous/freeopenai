// Messages that arrive, can be dismissed, and do not disappear into a timer
// nobody can see. The rules live in src/toasts.js; this is the surface.
import { useEffect, useState } from 'react';
import Icon, { type IconName } from './Icon';
import '../toasts.js';

const toasts: typeof import('../toasts.js') = (globalThis as any).FreeAI4UToasts;

export interface ToastRow {
  id: string;
  text: string;
  kind: 'info' | 'ok' | 'warn' | 'error';
  sticky?: boolean;
  at: number;
}

export function pushToast(kind: ToastRow['kind'], text: string, sticky = false): void {
  window.dispatchEvent(new CustomEvent('freeai4u:toast', { detail: { kind, text, sticky } }));
}

export default function Toasts() {
  const [rows, setRows] = useState<ToastRow[]>([]);

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      setRows((current) => toasts.push(current, detail, Date.now()));
    };
    window.addEventListener('freeai4u:toast', onToast);
    // One timer for the whole queue: each toast carries when it arrived, so the
    // list decides what has aged out rather than one timeout per message.
    const interval = setInterval(() => {
      setRows((current) => toasts.prune(current, Date.now()));
    }, 1000);
    return () => {
      window.removeEventListener('freeai4u:toast', onToast);
      clearInterval(interval);
    };
  }, []);

  if (!rows.length) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {rows.map((row) => (
        <div key={row.id} className={`toast toast-${row.kind}`}>
          <Icon name={toasts.iconFor(row.kind) as IconName} size={15} />
          <span className="toast-text">{row.text}</span>
          <button
            className="toast-close"
            type="button"
            aria-label="Dismiss"
            onClick={() => setRows((current) => toasts.dismiss(current, row.id))}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
