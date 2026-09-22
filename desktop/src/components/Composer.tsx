import { useMemo, useState, type ReactNode, type RefObject } from 'react';
import Icon from './Icon';
import '../composer.js';

const grammar: typeof import('../composer.js') = (globalThis as any).FreeAI4UComposer;

type ModeId = import('../composer.js').ModeId;
type SlashCommand = import('../composer.js').SlashCommand;
type MentionSource = import('../composer.js').MentionSource;

// The one place a message is written, and the one place everything about the
// next message is decided.
//
// What used to be a header (mode pill, model pill, run-settings gear, "+") and
// a composer row (Stop, the box, Send) is now this box: the mode is a coloured
// label at its start, the model a chip in its footer, tools a dot, and Send and
// Stop are one button that changes with the turn. `/` and `@` open menus above
// it; the keyboard does the rest (Tab cycles the mode, Up recalls the last
// message, Backspace at the start or Esc leaves a mode).

interface Props {
  value: string;
  onChange: (text: string) => void;
  mode: ModeId;
  onMode: (mode: ModeId) => void;
  sending: boolean;
  onSend: () => void;
  onStop: () => void;
  /** A `/command` picked from the menu or sent with an argument. */
  onCommand: (command: SlashCommand, arg: string) => void;
  slashExtra?: SlashCommand[];
  mentionSources: MentionSource[];
  /** A picked `@` row; return the text to leave in the box, or '' to leave none. */
  onMention: (source: MentionSource) => string;
  modelChip: ReactNode;
  toolsOn: boolean;
  /** Chips that sit above the box only while they mean something. */
  above?: ReactNode;
  /** The last thing sent, for Up in an empty box. */
  recall: () => string;
  /** The paperclip: attach a file (PDF, Word, Excel, PowerPoint, text). */
  onAttach?: () => void;
  /** The mic: start or stop dictation, and where it is. */
  onDictate?: () => void;
  dictation?: 'idle' | 'recording' | 'working';
  inputRef: RefObject<HTMLTextAreaElement>;
  placeholder?: string;
}

export default function Composer(props: Props) {
  const { value, onChange, mode, onMode, sending, onSend, onStop, onCommand, slashExtra, mentionSources, onMention, modelChip, toolsOn, above, recall, onAttach, onDictate, dictation, inputRef } = props;
  const [cursor, setCursor] = useState(0);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState('');

  const slash = useMemo(() => grammar.slashMenu(value, slashExtra), [value, slashExtra]);
  const at = grammar.mentionAt(value, caret);
  const mentions = useMemo(
    () => (at ? grammar.mentionMenu(at.query, mentionSources) : []),
    [at?.query, at?.start, mentionSources],
  );
  const menuKind: 'slash' | 'mention' | null = dismissed === value ? null : slash.length ? 'slash' : mentions.length ? 'mention' : null;
  const rows: Array<{ key: string; title: string; hint: string; kind?: string }> = menuKind === 'slash'
    ? slash.map((c) => ({ key: c.id, title: `/${c.id}`, hint: c.hint + (c.keys ? ` · ${c.keys}` : '') }))
    : menuKind === 'mention'
      ? mentions.map((m) => ({ key: `${m.kind}:${m.id}`, title: m.label, hint: m.hint || '', kind: m.kind }))
      : [];
  const pickIndex = Math.min(cursor, Math.max(rows.length - 1, 0));
  const modeInfo = grammar.modeById(mode);

  const pick = (index: number) => {
    if (menuKind === 'slash') {
      const command = slash[index];
      if (command) onCommand(command, '');
    } else if (menuKind === 'mention' && at) {
      const source = mentions[index];
      if (!source) return;
      const insert = onMention(source);
      const done = grammar.completeMention(value, at.start, caret, insert);
      onChange(done.text);
      requestAnimationFrame(() => {
        const box = inputRef.current;
        if (box) { box.focus(); box.setSelectionRange(done.caret, done.caret); setCaret(done.caret); }
      });
    }
    setCursor(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const box = e.currentTarget;
    const start = box.selectionStart ?? 0;
    if (rows.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % rows.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + rows.length) % rows.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && (menuKind === 'mention' || !/\s/.test(value)))) {
        // A single match completes; a `/word` Enter runs the highlighted row.
        e.preventDefault();
        pick(pickIndex);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(value); return; }
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      onMode(grammar.cycleMode(mode, e.shiftKey));
      return;
    }
    const leave = grammar.leaveMode(mode, e.key, start === box.selectionEnd ? start : -1);
    if (leave) {
      e.preventDefault();
      onMode(leave);
      return;
    }
    if (e.key === 'Escape' && sending) { e.preventDefault(); onStop(); return; }
    if (e.key === 'ArrowUp' && !value) {
      const last = recall();
      if (last) { e.preventDefault(); onChange(last); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const parsed = grammar.parseSlash(value, slashExtra);
      if (parsed) { onCommand(parsed.command, parsed.arg); return; }
      onSend();
    }
  };

  const onInput = (text: string, pos: number) => {
    const into = grammar.modeFromTyping(mode, text);
    if (into) { onMode(into.mode); onChange(into.text); return; }
    setCaret(pos);
    setCursor(0);
    onChange(text);
  };

  const placeholder = props.placeholder
    || (mode === 'shell' ? 'A command for the open folder — Enter runs it'
      : mode === 'design' ? 'Describe what to design — Enter opens it in Design'
        : mode === 'build' ? 'Describe the build — this starts a remote build session'
          : mode === 'plan' ? 'What should be planned? Nothing is changed in Plan'
            : 'Message NeuraOS — / for commands, @ for models and files');

  return (
    <div className={`composer mode-${mode}`}>
      {rows.length > 0 && (
        <div className="composer-menu" role="listbox" aria-label={menuKind === 'slash' ? 'Commands' : 'Mentions'}>
          {rows.map((row, i) => (
            <button
              key={row.key}
              role="option"
              aria-selected={i === pickIndex}
              className={`composer-menu-row${i === pickIndex ? ' is-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(i); }}
              onMouseEnter={() => setCursor(i)}
            >
              {row.kind && <span className={`mention-kind kind-${row.kind}`}>{row.kind}</span>}
              <span className="composer-menu-title mono">{row.title}</span>
              <span className="composer-menu-hint">{row.hint}</span>
            </button>
          ))}
        </div>
      )}
      {above}
      <div className="composer-box">
        {modeInfo.label && (
          <button className="mode-label" onClick={() => onMode('chat')} title={`${modeInfo.hint} — Backspace or Esc leaves`}>
            {modeInfo.label}
          </button>
        )}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onInput(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          placeholder={placeholder}
          rows={1}
          aria-label="Message"
        />
        <button
          className={`send-btn${sending ? ' is-stop' : ''}`}
          onClick={sending ? onStop : onSend}
          disabled={!sending && !value.trim()}
          title={sending ? 'Stop the reply (Esc)' : 'Send (Enter)'}
          aria-label={sending ? 'Stop' : 'Send'}
        >
          <Icon name={sending ? 'stop' : 'arrow-up'} size={sending ? 12 : 16} />
        </button>
      </div>
      <div className="composer-foot">
        {onAttach && (
          <button className="composer-icon" onClick={onAttach} title="Attach a file (PDF, Word, Excel, PowerPoint, text)" aria-label="Attach a file">
            <Icon name="paperclip" size={14} />
          </button>
        )}
        {onDictate && (
          <button
            className={`composer-icon ${dictation === 'recording' ? 'recording' : ''}`}
            onClick={onDictate}
            disabled={dictation === 'working'}
            title={dictation === 'recording' ? 'Stop and type what you said' : dictation === 'working' ? 'Transcribing…' : 'Dictate (Whisper on Hugging Face; Win+H works too)'}
            aria-label={dictation === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={dictation === 'recording'}
          >
            <Icon name="mic" size={14} />
          </button>
        )}
        {modelChip}
        <span
          className={`tools-dot${toolsOn ? ' is-on' : ''}`}
          title={toolsOn ? 'Tools are on — /tools to change' : 'Tools are off — /tools to change'}
          aria-label={toolsOn ? 'Tools on' : 'Tools off'}
        />
        <span className="composer-hint">Tab mode · / commands · @ mention</span>
      </div>
    </div>
  );
}
