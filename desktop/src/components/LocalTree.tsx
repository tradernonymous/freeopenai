import { useCallback, useEffect, useState } from 'react';
import Icon, { type IconName } from './Icon';
import { listLocalDir, type LocalEntry } from '../bridge';
// UMD module: loaded for its side effect, read off globalThis.
import '../local-fs.js';

const localFs: typeof import('../local-fs.js') = (globalThis as any).FreeAI4ULocalFs;

// The open folder, one level at a time.
//
// A directory is listed only when it is opened, so pointing this at a folder
// with node_modules in it does not walk the whole disk to draw its first
// screen. Rows are labelled by what they are (local-fs.js kindOf) rather than
// coloured by nothing, and the dotfiles are shown -- they are the user's files,
// and hiding .gitignore from someone looking at their own repo would be worse
// than the noise.
//
// Reading is all this does. Writing lives behind the agent's approval in P7.

const KIND_ICON: Record<string, IconName> = {
  folder: 'folder',
  image: 'image',
  code: 'file',
  data: 'file',
  doc: 'file',
  unknown: 'file',
};

interface LocalTreeProps {
  root: string;
  activePath?: string;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
}

export default function LocalTree({ root, activePath, onOpenFile, onOpenFolder }: LocalTreeProps) {
  const [cache, setCache] = useState<Record<string, LocalEntry[]>>({});
  const [expanded, setExpanded] = useState<string[]>(['']);
  const [loading, setLoading] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(
    (path: string) => {
      setLoading((prev) => (prev.includes(path) ? prev : [...prev, path]));
      listLocalDir(root, path)
        .then((listing) => {
          setCache((prev) => ({ ...prev, [path]: listing.entries }));
          setError(listing.capped ? 'This folder has more entries than the tree shows.' : '');
        })
        .catch((e: unknown) => setError((e as Error).message || String(e)))
        .finally(() => setLoading((prev) => prev.filter((p) => p !== path)));
    },
    [root],
  );

  // A different folder is a different tree: the cache of the old one is not
  // just stale, it is about files this screen must not claim to list.
  useEffect(() => {
    setCache({});
    setExpanded(['']);
    setError('');
    load('');
  }, [root, refreshKey, load]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      if (prev.includes(path)) return prev.filter((p) => p !== path);
      if (!cache[path]) load(path);
      return [...prev, path];
    });
  };

  const refresh = () => {
    setRefreshKey((k) => k + 1);
  };

  const renderLevel = (path: string, depth: number) => {
    const entries = cache[path];
    if (!entries) {
      return loading.includes(path)
        ? <div className="tree-hint" style={{ paddingLeft: depth * 14 + 22 }}>Reading…</div>
        : null;
    }
    if (!entries.length) {
      return <div className="tree-hint" style={{ paddingLeft: depth * 14 + 22 }}>Empty</div>;
    }
    return entries.map((entry) => {
      const kind = localFs.kindOf(entry);
      const open = expanded.includes(entry.path);
      const hidden = entry.name.startsWith('.');
      return (
        <div key={entry.path}>
          <button
            type="button"
            className={`tree-row ${activePath === entry.path ? 'active' : ''} ${hidden ? 'dim' : ''}`}
            style={{ paddingLeft: depth * 14 + 4 }}
            onClick={() => (entry.dir ? toggle(entry.path) : onOpenFile(entry.path))}
            title={entry.path}
          >
            <span className="tree-toggle">
              {entry.dir ? <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} /> : null}
            </span>
            <span className={`tree-icon kind-${kind}`}>
              <Icon name={KIND_ICON[kind] ?? 'file'} size={13} />
            </span>
            <span className="tree-name">{entry.name}</span>
            {!entry.dir && entry.size > 0 && (
              <span className="tree-size">{localFs.formatBytes(entry.size)}</span>
            )}
          </button>
          {entry.dir && open && renderLevel(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="file-tree local-tree">
      <div className="file-tree-header">
        <span className="tree-root" title={root}>
          <Icon name="folder" size={12} /> {localFs.rootLabel(root) || root}
        </span>
        <button onClick={onOpenFolder} title="Open a different folder">
          <Icon name="folder" size={13} />
        </button>
        <button onClick={refresh} title="Re-read this folder">
          <Icon name="refresh" size={13} />
        </button>
      </div>
      <div className="file-tree-list">{renderLevel('', 0)}</div>
      {error && <div className="tree-error">{error}</div>}
    </div>
  );
}
