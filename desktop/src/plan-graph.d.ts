/**
 * Build-plan graph layout (UMD, shared with node:test).
 *
 * Steps go in as the engine reported them, nodes and edges come out. Nothing
 * here invents a dependency: an edge joins each step to the next one.
 */
export interface PlanStep {
  id?: string | number;
  title?: string;
  phase?: string;
  status?: string;
  text?: string;
  exitCode?: number;
}

export type PlanStatus = 'running' | 'done' | 'failed' | 'pending' | 'skipped';

export interface PlanNode {
  key: string;
  id: string;
  index: number;
  title: string;
  detail: string;
  status: PlanStatus;
  exitCode: number | null;
  row: number;
  column: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlanEdge {
  key: string;
  from: string;
  to: string;
  d: string;
}

export interface PlanLayout {
  nodes: PlanNode[];
  edges: PlanEdge[];
  columns: number;
  rows: number;
  width: number;
  height: number;
  hidden: number;
  truncated: boolean;
  progress: Record<PlanStatus | 'total', number>;
}

export declare function layout(
  steps: PlanStep[],
  opts?: { width?: number; max?: number },
): PlanLayout;

export declare function place(x: number, y: number, width: number, height: number): { x: number; y: number };

export declare function nudge(
  node: { x: number; y: number } | null,
  dx: number,
  dy: number,
  width: number,
  height: number,
): { x: number; y: number };

export declare function statusOf(phase?: string): PlanStatus;
export declare function perRow(width: number): number;

export declare const NODE_W: number;
export declare const NODE_H: number;
export declare const GAP_X: number;
export declare const GAP_Y: number;
export declare const PAD: number;
export declare const MAX_NODES: number;
