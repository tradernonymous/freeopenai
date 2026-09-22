import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import SelectPill from './SelectPill';
import { renderMarkdown } from '../markdown';
import { streamAny, type Target } from '../stream-any';

// Compare (roadmap 6.4): one prompt, two or three models, answers side by
// side with their time -- local next to cloud is the usual question. Opened
// with /compare or from a reply's ring. "Use this" puts an answer into the
// chat as the reply.

interface Props {
  open: boolean;
  prompt: string;
  targets: Target[];
  onClose: () => void;
  onUse: (text: string, target: Target) => void;
}

interface Column {
  target: Target | null;
  text: string;
  ms: number;
  busy: boolean;
  error: string;
}

const empty = (target: Target | null): Column => ({ target, text: '', ms: 0, busy: false, error: '' });

export default function CompareDrawer({ open, prompt, targets, onClose, onUse }: Props) {
  const [question, setQuestion] = useState(prompt);
  const [columns, setColumns] = useState<Column[]>(() => [empty(targets[0] || null), empty(targets[1] || null)]);
  const aborts = useRef<AbortController[]>([]);

  useEffect(() => { if (open) setQuestion(prompt); }, [open, prompt]);
  useEffect(() => () => aborts.current.forEach((a) => a.abort()), []);

  if (!open) return null;

  const pick = (index: number, label: string) => {
    const target = targets.find((t) => t.label === label) || null;
    setColumns((prev) => prev.map((c, i) => (i === index ? empty(target) : c)));
  };

  const runAll = () => {
    aborts.current.forEach((a) => a.abort());
    aborts.current = [];
    const text = question.trim();
    if (!text) return;
    columns.forEach((col, index) => {
      if (!col.target) return;
      const controller = new AbortController();
      aborts.current.push(controller);
      const started = Date.now();
      setColumns((prev) => prev.map((c, i) => (i === index ? { ...c, text: '', error: '', busy: true, ms: 0 } : c)));
      streamAny(col.target, [{ role: 'user', content: text }], (frame) => {
        if (frame.content) setColumns((prev) => prev.map((c, i) => (i === index ? { ...c, text: c.text + frame.content } : c)));
      }, controller.signal)
        .catch((e: unknown) => {
          if ((e as Error).name === 'AbortError') return;
          setColumns((prev) => prev.map((c, i) => (i === index ? { ...c, error: ((e as Error).message || String(e)).split('\n')[0] } : c)));
        })
        .finally(() => setColumns((prev) => prev.map((c, i) => (i === index ? { ...c, busy: false, ms: Date.now() - started } : c))));
    });
  };

  return (
    <div className="compare-drawer" role="dialog" aria-label="Compare models">
      <div className="compare-head">
        <strong>Compare</strong>
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} aria-label="The prompt to compare" />
        <button className="primary" onClick={runAll} disabled={!question.trim() || !columns.some((c) => c.target)}>Run</button>
        {columns.length < 3 && <button onClick={() => setColumns((prev) => [...prev, empty(null)])}>+ Model</button>}
        <button className="linkish" onClick={onClose} aria-label="Close compare"><Icon name="close" size={14} /></button>
      </div>
      <div className="compare-columns" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((col, index) => (
          <div key={index} className="compare-col">
            <SelectPill
              label={`Model ${index + 1}`}
              title="Which model answers in this column"
              value={col.target?.label || ''}
              filterable
              options={targets.map((t) => ({ value: t.label, label: t.label }))}
              onPick={(label) => pick(index, label)}
            />
            <div className="compare-meta">
              {col.busy ? 'answering…' : col.ms ? `${(col.ms / 1000).toFixed(1)}s · ${col.text.length.toLocaleString()} chars` : ''}
            </div>
            {col.error && <div className="chip-note">{col.error}</div>}
            <div className="compare-answer message-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(col.text) }} />
            {col.text && !col.busy && col.target && (
              <button onClick={() => onUse(col.text, col.target!)}>Use this answer</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
