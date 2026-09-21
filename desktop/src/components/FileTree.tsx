import { useState, useEffect } from 'react';
import { api } from '../api';
import Icon from './Icon';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: FileNode[];
}

export default function FileTree() {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    setLoading(true);
    try {
      const data = await api.workspaceFiles();
      setFiles(Array.isArray(data) ? data : []);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: FileNode, depth = 0) => {
    const isOpen = expanded.has(node.path);
    return (
      <div key={node.path}>
        <div
          className="tree-node"
          style={{ paddingLeft: depth * 16 + 4 }}
          onClick={() => node.type === 'folder' && toggle(node.path)}
        >
          <span className="tree-toggle">{node.type === 'folder' ? (isOpen ? <Icon name="chevron-down" size={11} /> : <Icon name="chevron-right" size={11} />) : ''}</span>
          <span className="tree-icon"><Icon name={node.type === 'folder' ? 'folder' : 'file'} size={13} /></span>
          <span className="tree-name">{node.name}</span>
        </div>
        {isOpen && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>Workspace</span>
        <button onClick={loadFiles} disabled={loading} title="Refresh">
          <Icon name="refresh" size={13} />
        </button>
      </div>
      <div className="file-tree-list">
        {files.map((node) => renderNode(node))}
        {files.length === 0 && !loading && <div className="empty">No files</div>}
      </div>
    </div>
  );
}
