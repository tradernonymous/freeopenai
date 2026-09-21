import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import RadialMenu, { type RadialItem } from './RadialMenu';
// UMD modules: loaded for their side effect, read off globalThis.
import '../plan-graph.js';

const planGraph: typeof import('../plan-graph.js') = (globalThis as any).FreeAI4UPlanGraph;

// The plan, drawn.
//
// A build's steps arrive one at a time and the list below this canvas is the
// log of them. What a list cannot show is shape: how far along the plan is,
// which step is running now, where it went wrong. So the same steps are drawn
// here as a snake of nodes joined in order -- the engine's order, never one
// this component made up. Dragging a node rearranges the picture; it does not
// and cannot reorder the plan, which is why the reset control says "reset
// layout" rather than "undo".
//
// Everything about where a node goes comes from src/plan-graph.js, so the rule
// is tested without a browser and the canvas only draws what it returns.

interface Props {
  steps: import('../plan-graph.js').PlanStep[];
  /** The key of the node the list should scroll to, and vice versa. */
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
}

export default function PlanCanvas({ steps, selectedKey, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; node: import('../plan-graph.js').PlanNode } | null>(null);
  const dragRef = useRef<{ key: string; fromX: number; fromY: number; originX: number; originY: number; moved: boolean } | null>(null);

  // The canvas is as wide as the panel it is in: a layout computed for another
  // width is a layout with nodes off the edge.
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const measure = () => setWidth(host.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const plan = useMemo(
    () => planGraph.layout(steps || [], { width: Math.max(width, planGraph.NODE_W * 2 + 80) }),
    [steps, width],
  );

  // A redraw can renumber the nodes (a step inserted, a session replaced), so a
  // drag position is kept per node key and simply ignored when that key is gone.
  const at = useCallback(
    (node: import('../plan-graph.js').PlanNode) => offsets[node.key] || { x: node.x, y: node.y },
    [offsets],
  );

  const onPointerDown = (node: import('../plan-graph.js').PlanNode, event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const here = at(node);
    dragRef.current = {
      key: node.key,
      fromX: event.clientX,
      fromY: event.clientY,
      originX: here.x,
      originY: here.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (node: import('../plan-graph.js').PlanNode, event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.key !== node.key) return;
    const dx = event.clientX - drag.fromX;
    const dy = event.clientY - drag.fromY;
    // Three pixels of slack: a click that shakes is still a click.
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    const next = planGraph.place(drag.originX + dx, drag.originY + dy, plan.width, plan.height);
    setOffsets((prev) => ({ ...prev, [node.key]: next }));
  };

  const onPointerUp = (node: import('../plan-graph.js').PlanNode, event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag && !drag.moved) onSelect?.(node.key);
  };

  const resetLayout = () => setOffsets({});

  const items = (node: import('../plan-graph.js').PlanNode): RadialItem[] => {
    const list: RadialItem[] = [
      { id: 'focus', label: 'Show in list', icon: 'search', run: () => onSelect?.(node.key) },
      {
        id: 'copy-title',
        label: 'Copy step',
        icon: 'copy',
        run: () => {
          void navigator.clipboard?.writeText(node.title);
        },
      },
    ];
    if (node.detail) {
      list.push({
        id: 'copy-output',
        label: 'Copy output',
        icon: 'terminal',
        run: () => {
          void navigator.clipboard?.writeText(node.detail);
        },
      });
    }
    if (offsets[node.key]) {
      list.push({
        id: 'reset',
        label: 'Reset layout',
        icon: 'refresh',
        run: resetLayout,
      });
    }
    return list;
  };

  if (!plan.nodes.length) return null;

  const { progress } = plan;
  const status = progress.failed ? 'failed' : progress.running ? 'running' : progress.pending === 0 ? 'done' : 'pending';

  return (
    <div className="plan-panel">
      <div className="plan-header">
        <span className={`plan-count ${status}`}>
          <Icon name="activity" size={12} />
          {progress.done + progress.failed + progress.skipped} of {progress.total} steps
          {progress.failed ? ` · ${progress.failed} failed` : progress.running ? ' · running' : ''}
        </span>
        {Object.keys(offsets).length > 0 && (
          <button className="plan-reset" onClick={resetLayout} title="Put the nodes back where the plan put them">
            Reset layout
          </button>
        )}
        {plan.hidden > 0 && <span className="plan-hidden">{plan.hidden} more in the list</span>}
      </div>
      <div className="plan-scroll" ref={scrollRef}>
        <div className="plan-canvas" style={{ width: plan.width, height: plan.height }}>
          <svg className="plan-edges" width={plan.width} height={plan.height} aria-hidden="true">
            {plan.edges.map((edge) => (
              <path key={edge.key} d={edge.d} className="plan-edge" />
            ))}
          </svg>
          {plan.nodes.map((node) => {
            const spot = at(node);
            return (
              <button
                key={node.key}
                type="button"
                className={`plan-node ${node.status} ${selectedKey === node.key ? 'selected' : ''}`}
                style={{ left: spot.x, top: spot.y, width: node.w, height: node.h }}
                onPointerDown={(e) => onPointerDown(node, e)}
                onPointerMove={(e) => onPointerMove(node, e)}
                onPointerUp={(e) => onPointerUp(node, e)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, node });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(node.key);
                  }
                }}
                title={`${node.title}${node.detail ? `\n${node.detail}` : ''}`}
              >
                <span className="plan-node-top">
                  <span className="plan-dot" aria-hidden="true" />
                  <span className="plan-node-title">{node.title}</span>
                </span>
                <span className="plan-node-foot">
                  <span className="plan-node-index">{node.index + 1}</span>
                  {node.exitCode != null && (
                    <span className={`plan-exit ${node.exitCode === 0 ? 'ok' : 'bad'}`}>exit {node.exitCode}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {menu && (
        <RadialMenu
          x={menu.x}
          y={menu.y}
          label={`Step ${menu.node.index + 1}`}
          items={items(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
