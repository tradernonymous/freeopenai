/// <reference types="vite/client" />
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { writeLocalFile } from '../bridge';

// Monaco for one local file (phase 12e), opened from the Local screen's Edit.
//
// Loading: this component is itself lazy (LocalScreen uses React.lazy), and
// Monaco plus its workers are dynamic imports inside loadMonaco() -- nothing of
// Monaco is in the main chunk, and nothing loads until a file is opened for
// editing. The workers are Vite `?worker` imports, bundled as files of this app:
// the CSP allows no remote scripts, so no CDN loader is used.
//
// Saving: Ctrl+S (or Save) writes through writeLocalFile, so the shell's
// confinement rules apply exactly as they do to the agent -- a path outside the
// open folder is refused there, not here. The person is typing and pressing
// Save themselves, which is the approval; nothing here writes on its own.

type Monaco = typeof import('monaco-editor');
type Editor = import('monaco-editor').editor.IStandaloneCodeEditor;

let loading: Promise<Monaco> | null = null;

function loadMonaco(): Promise<Monaco> {
  if (!loading) {
    loading = Promise.all([
      import('monaco-editor'),
      import('monaco-editor/esm/vs/editor/editor.worker?worker'),
      import('monaco-editor/esm/vs/language/json/json.worker?worker'),
      import('monaco-editor/esm/vs/language/css/css.worker?worker'),
      import('monaco-editor/esm/vs/language/html/html.worker?worker'),
      import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
    ]).then(([monaco, EditorWorker, JsonWorker, CssWorker, HtmlWorker, TsWorker]) => {
      (globalThis as any).MonacoEnvironment = {
        getWorker(_id: string, label: string) {
          if (label === 'json') return new JsonWorker.default();
          if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker.default();
          if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker.default();
          if (label === 'typescript' || label === 'javascript') return new TsWorker.default();
          return new EditorWorker.default();
        },
      };
      return monaco;
    });
    // A failed load (a missing chunk) may be retried by opening the editor again.
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** Monaco's language id for a path: by file name (Dockerfile), then by extension; plaintext otherwise. */
function languageFor(monaco: Monaco, path: string): string {
  const name = (path.split(/[/\\]/).pop() || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  const langs = monaco.languages.getLanguages();
  const byName = langs.find((l) => (l.filenames || []).some((f) => f.toLowerCase() === name));
  if (byName) return byName.id;
  const byExt = ext ? langs.find((l) => (l.extensions || []).some((e) => e.toLowerCase() === ext)) : undefined;
  return byExt ? byExt.id : 'plaintext';
}

function themeName(): string {
  return document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark';
}

function message(e: unknown): string {
  return ((e as Error)?.message || String(e)).split('\n')[0];
}

interface CodeEditorProps {
  root: string;
  path: string;
  /** The file's text as read; the editor owns the buffer after it opens. */
  text: string;
  onSaved: (text: string) => void;
  /** Discard / Done: back to the read-only viewer. Unsaved edits are dropped. */
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export default function CodeEditor({ root, path, text, onSaved, onClose, onDirtyChange }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const savedVersion = useRef(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [language, setLanguage] = useState('');
  const saveRef = useRef<() => void>(() => undefined);
  const savedCb = useRef(onSaved);
  savedCb.current = onSaved;
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;

  useEffect(() => {
    dirtyCb.current?.(dirty);
  }, [dirty]);

  useEffect(() => {
    let disposed = false;
    let editor: Editor | null = null;
    setStatus('loading');
    setError('');
    setDirty(false);
    loadMonaco()
      .then((monaco) => {
        if (disposed || !host.current) return;
        const lang = languageFor(monaco, path);
        setLanguage(lang);
        const created = monaco.editor.create(host.current, {
          value: text,
          language: lang,
          theme: themeName(),
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
        });
        editor = created;
        editorRef.current = created;
        savedVersion.current = created.getModel()?.getAlternativeVersionId() ?? 0;
        created.onDidChangeModelContent(() => {
          setDirty((created.getModel()?.getAlternativeVersionId() ?? 0) !== savedVersion.current);
        });
        created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
        created.focus();
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setStatus('error');
        setError(`The editor could not load: ${message(e)}`);
      });
    return () => {
      disposed = true;
      const model = editor?.getModel();
      editor?.dispose();
      model?.dispose();
      editorRef.current = null;
    };
    // `text` is read once on open: after that the editor holds the buffer.
  }, [root, path]);

  saveRef.current = () => {
    const model = editorRef.current?.getModel();
    if (!model || status === 'saving') return;
    const value = model.getValue();
    const version = model.getAlternativeVersionId();
    setStatus('saving');
    setError('');
    writeLocalFile(root, path, value)
      .then(() => {
        savedVersion.current = version;
        setDirty(model.getAlternativeVersionId() !== version);
        setStatus('ready');
        savedCb.current(value);
      })
      .catch((e: unknown) => {
        setStatus('ready');
        setError(`Not saved: ${message(e)}`);
      });
  };

  return (
    <div className="code-editor" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}>
      <div className="viewer-header">
        <span className="viewer-path" title={path}>
          {path}
        </span>
        <span className="viewer-meta">
          {language && `${language} · `}
          {status === 'loading' ? 'loading editor…' : status === 'saving' ? 'saving…' : dirty ? '● unsaved changes' : 'saved'}
        </span>
        <button className="primary" onClick={() => saveRef.current()} disabled={status !== 'ready' || !dirty} title="Save (Ctrl+S)">
          <Icon name="check" size={13} /> Save
        </button>
        <button onClick={onClose} title={dirty ? 'Drop the unsaved changes and go back to the read-only view' : 'Back to the read-only view'}>
          <Icon name="close" size={13} /> {dirty ? 'Discard' : 'Done'}
        </button>
      </div>
      {error && <div className="empty files-error">{error}</div>}
      <div ref={host} className="code-editor-host" style={{ flex: 1, minHeight: 240 }} />
    </div>
  );
}
