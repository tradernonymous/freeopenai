/** The diagram artifact type: graph JSON -> deterministic SVG (UMD, shared with node:test). */
export interface DiagramNode {
  id: string;
  label: string;
  group?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Graph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  trimmed: boolean;
  message: string;
}

export interface PlacedNode extends DiagramNode {
  layer: number;
  order: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: Array<DiagramEdge & { back: boolean; points: Array<[number, number]> }>;
}

export declare const MAX_NODES: number;
export declare const RADIUS: number;
export declare const SCRIPT_TYPE: string;
export declare function normalize(raw: unknown): Graph;
export declare function extractGraph(reply: string): Graph | null;
export declare function parseMermaid(source: string): { nodes: DiagramNode[]; edges: DiagramEdge[] };
export declare function layout(graph: { nodes: DiagramNode[]; edges: DiagramEdge[] }): Layout;
export declare function roundedPath(points: Array<[number, number]>, r?: number): string;
export declare function toSvg(graph: { nodes: DiagramNode[]; edges: DiagramEdge[] } | Layout, opts?: Record<string, string>): string;
export declare function toPage(graph: { nodes: DiagramNode[]; edges: DiagramEdge[] }, opts?: { title?: string; tokens?: Record<string, string> }): string;
export declare function graphFromHtml(html: string): Graph | null;
