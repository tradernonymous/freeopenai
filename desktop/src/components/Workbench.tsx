// The right rail (NEURA-069). The sidebar on the left says WHERE you are; this
// one owns the OUTPUT -- Design, Build, Files and Changes -- so the middle
// column can stay what it has always been, a conversation.
//
// It behaves like the sidebar: 40px of icons until you point at it, full width
// while you are using it, and pinned open when you say so. Unpinned it floats
// over the floor rather than pushing it, so opening a tool never slides the
// line you are reading sideways. The stylesheet does all of that from the
// `data-pinned` attribute; what this component owns is rendering the attribute
// truthfully and keeping exactly one tab selected.
//
// Gold (--gilt) appears on the selected tab and nowhere else: one signal, one
// meaning -- which tool owns the workspace right now.
import { useCallback } from 'react';
import Icon from './Icon';
import LocalTree from './LocalTree';
// UMD module: loaded for its side effect, read off globalThis.
import '../workbench.js';

const workbench: typeof import('../workbench.js') = (globalThis as any).FreeAI4UWorkbench;

type ToolId = import('../workbench.js').ToolId;

interface WorkbenchProps {
  tool: ToolId;
  onPickTool: (id: ToolId) => void;
  pinned: boolean;
  onTogglePin: () => void;
  /** The folder the local surfaces work in; empty until one is opened. */
  localRoot: string;
  onOpenFolder: () => void;
  onOpenFile: (path: string) => void;
  /** Take the workspace to a full screen -- the rail introduces it, it does not replace it. */
  onOpenScreen: (view: 'design' | 'build') => void;
}

/** A tool that has a screen of its own: what it is for, and the way in. */
function ScreenPanel({ blurb, action, onOpen }: { blurb: string; action: string; onOpen: () => void }) {
  return (
    <div>
      <p className="empty">{blurb}</p>
      <button type="button" onClick={onOpen}>{action}</button>
    </div>
  );
}

export default function Workbench({
  tool,
  onPickTool,
  pinned,
  onTogglePin,
  localRoot,
  onOpenFolder,
  onOpenFile,
  onOpenScreen,
}: WorkbenchProps) {
  // A peeking rail is held open by focus, so Escape closes it by letting the
  // focus go -- there is no "open" flag to clear. A pinned rail stays put;
  // the pin button is the way out of that one. Escape is never swallowed: the
  // palette and the composer listen for it too.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'Escape' || !workbench.closesOnEscape(pinned)) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && e.currentTarget.contains(focused)) focused.blur();
    },
    [pinned],
  );

  const current = workbench.toolAt(tool) || workbench.TOOLS[0];

  return (
    <aside
      className="workbench"
      data-pinned={workbench.pinnedAttr(pinned)}
      aria-label="Workbench"
      onKeyDown={onKeyDown}
    >
      <div className="workbench-tabs" role="tablist" aria-orientation="vertical" aria-label="Workbench tools">
        {workbench.TOOLS.map((item) => (
          <button
            key={item.id}
            id={`workbench-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tool === item.id}
            aria-controls="workbench-body"
            className="workbench-tab"
            title={`${item.label} — ${item.blurb}`}
            onClick={() => onPickTool(item.id)}
          >
            <Icon name={item.icon} size={16} />
            <span className="workbench-tab-label">{item.label}</span>
          </button>
        ))}
      </div>

      <button
        className="workbench-pin"
        type="button"
        aria-pressed={pinned}
        onClick={onTogglePin}
        title={pinned ? 'Let this rail close again when you move away' : 'Keep this rail open'}
      >
        {pinned ? 'Pinned' : 'Pin'}
      </button>

      <div
        id="workbench-body"
        className="workbench-body"
        role="tabpanel"
        aria-labelledby={`workbench-tab-${current.id}`}
      >
        {tool === 'design' && (
          <ScreenPanel blurb={current.blurb} action="Open Design" onOpen={() => onOpenScreen('design')} />
        )}
        {tool === 'build' && (
          <ScreenPanel blurb={current.blurb} action="Open Build" onOpen={() => onOpenScreen('build')} />
        )}
        {tool === 'files' && (
          localRoot
            ? <LocalTree root={localRoot} onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} />
            : (
              <div>
                <p className="empty">Open a folder to see its files.</p>
                <button type="button" onClick={onOpenFolder}>Open a folder</button>
              </div>
            )
        )}
        {/* TODO(NEURA-069): Changes still has nothing to show. The app runs git
            for the agent and for the parallel worktrees, but nothing here reads
            `git status` for the open folder, and inventing that in a shell pass
            would be a feature smuggled in under a layout change. The tab says
            what belongs here until it lands. */}
        {tool === 'changes' && (
          <div>
            <p className="empty">
              {localRoot
                ? 'A file-by-file list of what changed in this folder, and the diff for the file you pick, belongs here. Until it lands, the Parallel screen shows what each agent changed in its own worktree.'
                : 'Open a git repository to follow what the agent changes in it.'}
            </p>
            <button type="button" onClick={localRoot ? () => onPickTool('files') : onOpenFolder}>
              {localRoot ? 'See the files' : 'Open a folder'}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
