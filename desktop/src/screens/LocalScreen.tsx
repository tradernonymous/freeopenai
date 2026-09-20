import { useCallback, useEffect, useState } from 'react';
import LocalTree from '../components/LocalTree';
import Icon from '../components/Icon';
import { readLocalFile, type LocalFile } from '../bridge';
import '../local-fs.js';

const localFs: typeof import('../local-fs.js') = (globalThis as any).FreeAI4ULocalFs;

// The LOCAL screen: this machine, one folder, nothing else.
//
// The app's other surfaces are the engine's -- the workspace tree, the engine
// terminal, builds in the engine's folder. This screen is the first one that is
// about the user's own files, and it is deliberately the plainest thing here:
// a real tree, a read-only viewer, and a way to the terminal.
//
// Read-only is the whole point. The engine never writes a file without an
// approval, and neither does this screen: the write path exists in the shell
// (local_write_file / local_edit_file) for the coding agent to use behind its
// approval, and this screen is not that agent. Putting an editor here first
// would have made the read-only promise harder to keep, not easier.

interface LocalScreenProps {
  root: string;
  onOpenFolder: () => void;
  onShowTerminal: () => void;
  terminalOpen: boolean;
  cwd: string;
}

export default function LocalScreen({ root, onOpenFolder, onShowTerminal, terminalOpen, cwd }: LocalScreenProps) {
  const [selected, setSelected] = useState('');
  const [file, setFile] = useState<LocalFile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // A different folder invalidates whatever was open in the old one.
    setSelected('');
    setFile(null);
    setError('');
  }, [root]);

  const open = useCallback(
    (path: string) => {
      setSelected(path);
      setLoading(true);
      setError('');
      readLocalFile(root, path)
        .then(setFile)
        .catch((e: unknown) => {
          setFile(null);
          setError((e as Error).message || String(e));
        })
        .finally(() => setLoading(false));
    },
    [root],
  );

  if (!root) {
    return (
      <div className="screen local">
        <div className="empty-state">
          <div className="empty-icon">
            <Icon name="folder" size={28} />
          </div>
          <h2>Work on your own files</h2>
          <p>
            Open a folder and this screen reads it from your disk: a real tree, a viewer, and a
            terminal that runs commands here rather than on the engine. Nothing is uploaded, and
            nothing is written without asking.
          </p>
          <button className="primary" onClick={onOpenFolder}>
            Open a folder
          </button>
          <p className="local-note">
            Chat, images and builds keep working from the engine's free models — this is the local
            half, and it works with no engine at all.
          </p>
        </div>
      </div>
    );
  }

  const lines = file && !file.binary ? file.text.split('\n').length : 0;

  return (
    <div className="screen local">
      <header className="screen-header">
        <h1>Local</h1>
        <span className="local-path" title={root}>
          <Icon name="folder" size={12} /> {localFs.rootLabel(root) || root}
          <span className="local-cwd" title={cwd ? `${root}/${cwd}` : root}>
            {cwd ? `/ ${cwd}` : ''}
          </span>
        </span>
        <div className="header-actions">
          <button onClick={onOpenFolder}>
            <Icon name="folder" size={14} /> Change folder
          </button>
          <button className={terminalOpen ? 'primary' : undefined} onClick={onShowTerminal}>
            <Icon name="terminal" size={14} /> Terminal
          </button>
        </div>
      </header>

      <div className="local-body">
        <LocalTree root={root} activePath={selected} onOpenFile={open} onOpenFolder={onOpenFolder} />
        <div className="local-viewer">
          {loading && <div className="empty">Reading {selected}…</div>}
          {!loading && error && <div className="empty files-error">{error}</div>}
          {!loading && !error && !file && (
            <div className="empty">
              Choose a file to read it. This view is read-only — the coding agent asks before it
              writes anything.
            </div>
          )}
          {!loading && file && (
            <>
              <div className="viewer-header">
                <span className="viewer-path" title={file.absolute}>
                  {file.path}
                </span>
                <span className="viewer-meta">
                  {localFs.formatBytes(file.bytes)}
                  {lines ? ` · ${lines} lines` : ''}
                  {file.truncated ? ' · first 1 MB' : ''}
                </span>
                <span className="viewer-flag" title="This view never writes">
                  <Icon name="shield" size={12} /> read-only
                </span>
              </div>
              {file.binary ? (
                <div className="empty">
                  {file.path} is a binary file ({localFs.formatBytes(file.bytes)}), so there is
                  nothing to show as text.
                </div>
              ) : (
                <pre className="viewer-text">{file.text}</pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
