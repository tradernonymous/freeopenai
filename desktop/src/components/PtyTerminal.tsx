import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import Icon from './Icon';
import { onPtyExit, onPtyOutput, ptyBytes, ptyClose, ptyOpen, ptyResize, ptyWrite } from '../bridge';

// NEURA-058: the terminal dock, backed by a real PTY.
//
// The old dock ran one command per entry and kept `cwd` in JavaScript, because
// a child process that exits cannot hand a directory change back. There is one
// long-lived shell now (src-tauri/src/pty.rs), so all of that goes away: `cd`
// is the shell's, `git rebase -i` gets a screen, a REPL stays open, and a
// progress bar redraws the line it already wrote instead of printing a new one.
//
// Three things this component is responsible for:
//
//   1. Bytes, not text. `pty-output` carries base64 because a pty splits UTF-8
//      wherever the read ended; xterm.js takes the Uint8Array and decodes it
//      across chunks, so a character cut in half is never a replacement mark.
//   2. Size. xterm measures the glyph, FitAddon works out cols/rows, and the
//      shell is TOLD -- a shell that believes the wrong width wraps every line
//      in the wrong place.
//   3. Teardown. The session is closed when this unmounts and when the folder
//      changes; the shell (and its tree) dies with it. The app-level case is
//      pty.rs's own "app-quitting" listener, so a tray Quit cannot orphan one.
//
// Ctrl+C needs no code: xterm sends \x03 down onData and the pty delivers a
// real interrupt to the foreground process, which is exactly what the one-shot
// runner could never do. Ctrl+Shift+C / Ctrl+Shift+V are taken for copy and
// paste, so plain Ctrl+C keeps meaning "interrupt".

const MONO = "'Cascadia Mono', 'SF Mono', 'Fira Code', Consolas, monospace";
/** Lines kept above the viewport. Bounded on purpose: the Rust side already
 *  drops the oldest bytes under a flood, and this is the same rule for the DOM. */
const SCROLLBACK = 5000;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `pty-${Date.now().toString(36)}-${counter}`;
}

/** A CSS variable, but only when it is a colour xterm can parse. The palette
 *  holds hex for backgrounds and text and oklch() for the accent, and an
 *  unresolved `oklch(... var(--accent-h))` would throw inside xterm's parser. */
function hexVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback;
}

function themeOf(host: HTMLElement) {
  const style = getComputedStyle(host);
  const background = hexVar(style, '--bg-1', '#111a10');
  const foreground = hexVar(style, '--text-1', '#e8f0e3');
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    // Kept off the accent variable for the reason above; this reads as a
    // selection on both the light and the dark palette.
    selectionBackground: 'rgba(128, 170, 120, 0.35)',
  };
}

export interface PtyTerminalProps {
  root: string;
  /** Where the shell starts, relative to the open folder. Read once per
   *  session: moving the tree afterwards must not restart a live shell. */
  cwd?: string;
  onOpenFolder: () => void;
  /** A machine with no PTY (or no desktop shell at all). The dock falls back. */
  onUnavailable?: (reason: string) => void;
}

export default function PtyTerminal({ root, cwd, onOpenFolder, onUnavailable }: PtyTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef('');
  const cwdRef = useRef(cwd);
  const unavailableRef = useRef(onUnavailable);
  const [status, setStatus] = useState<'starting' | 'live' | 'exited'>('starting');
  const [shell, setShell] = useState('');
  const [generation, setGeneration] = useState(0);

  cwdRef.current = cwd;
  unavailableRef.current = onUnavailable;

  const restart = useCallback(() => setGeneration((n) => n + 1), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!root || !host) return;

    // One id per mounted session. A second pty_open on the same id is a
    // restart in the shell, so Restart reuses it rather than leaking one.
    if (!idRef.current) idRef.current = nextId();
    const id = idRef.current;

    let disposed = false;
    const stops: Array<() => void> = [];
    setStatus('starting');

    const term = new Terminal({
      fontFamily: MONO,
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: SCROLLBACK,
      allowProposedApi: false,
      theme: themeOf(host),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch { /* a dock that is hidden has no size yet; the observer refits */ }

    // Copy and paste, so plain Ctrl+C stays an interrupt.
    term.attachCustomKeyEventHandler((event) => {
      if (!event.ctrlKey || !event.shiftKey || event.type !== 'keydown') return true;
      const key = event.key.toLowerCase();
      if (key === 'c') {
        const selection = term.getSelection();
        if (selection) navigator.clipboard?.writeText(selection).catch(() => {});
        return false;
      }
      if (key === 'v') {
        navigator.clipboard
          ?.readText()
          .then((text) => { if (text) ptyWrite(id, text).catch(() => {}); })
          .catch(() => {});
        return false;
      }
      return true;
    });

    // The only caller of ptyWrite: what the user typed, and nothing else.
    const typed = term.onData((data) => {
      ptyWrite(id, data).catch(() => {
        // The shell is gone. Say so once rather than swallowing every key.
        setStatus('exited');
      });
    });
    stops.push(() => typed.dispose());

    onPtyOutput((chunk) => {
      if (chunk.id !== id) return;
      if (chunk.dropped) term.write('\r\n\u001b[2m…[output dropped: the shell outran the window]\u001b[0m\r\n');
      term.write(ptyBytes(chunk.data));
    })
      .then((stop) => { if (disposed) stop(); else stops.push(stop); })
      .catch(() => {});

    onPtyExit((end) => {
      if (end.id !== id) return;
      setStatus('exited');
      term.write(`\r\n\u001b[2m[the shell exited${end.exitCode === null ? '' : ` with ${end.exitCode}`}]\u001b[0m\r\n`);
    })
      .then((stop) => { if (disposed) stop(); else stops.push(stop); })
      .catch(() => {});

    ptyOpen({ id, root, cwd: cwdRef.current ?? '', cols: term.cols, rows: term.rows })
      .then((session) => {
        if (disposed) return;
        setShell(session.shell);
        setStatus('live');
        term.focus();
      })
      .catch((e: unknown) => {
        if (disposed) return;
        const reason = (e as Error)?.message || String(e);
        setStatus('exited');
        term.write(`\u001b[2m${reason}\u001b[0m\r\n`);
        unavailableRef.current?.(reason);
      });

    // The dock is resizable and the window is not: refit, then tell the shell.
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch { return; }
        ptyResize(id, term.cols, term.rows).catch(() => {});
      });
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    window.addEventListener('resize', refit);

    // Light/dark is a data-theme swap on the document element; the terminal
    // owns its own colours, so it has to be told.
    const themes = new MutationObserver(() => {
      term.options.theme = themeOf(host);
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', refit);
      observer.disconnect();
      themes.disconnect();
      stops.forEach((stop) => stop());
      // The shell dies with the screen. Closing before disposing means the
      // last bytes cannot land on a disposed terminal.
      ptyClose(id).catch(() => {});
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // cwd is read through a ref: a tree click must not restart a live shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, generation]);

  if (!root) {
    return (
      <div className="terminal local-terminal">
        <div className="terminal-header">
          <span className="dock-title">
            <Icon name="terminal" size={13} /> Terminal
          </span>
        </div>
        <div className="dock-empty">
          <p>A real shell, on this machine, inside a folder you choose.</p>
          <button className="primary" onClick={onOpenFolder}>
            Open a folder
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal local-terminal">
      <div className="terminal-header">
        <span className="dock-title">
          <Icon name="terminal" size={13} /> Terminal
        </span>
        <span className="terminal-cwd" title={`${shell || 'shell'} — runs on this machine, in the open folder`}>
          <Icon name="folder" size={12} /> {status === 'live' ? shell || 'shell' : status}
        </span>
        <button className="dock-action" onClick={restart} title="Start a fresh shell" aria-label="Restart">
          <Icon name="activity" size={12} />
        </button>
      </div>
      {/* xterm draws into this element and measures it, so it must have a real
          size of its own -- hence the inline box rather than a stylesheet the
          dock does not own. */}
      <div
        ref={hostRef}
        className="terminal-body"
        style={{ padding: '6px 4px 6px 8px', overflow: 'hidden', minHeight: 0 }}
      />
    </div>
  );
}
