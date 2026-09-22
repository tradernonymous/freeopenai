/** The optional LLM design critique (UMD, shared with node:test). */
type Message = { role: string; content: string };

export type DimensionId = 'hierarchy' | 'typography' | 'color' | 'spacing' | 'originality';

export interface Critique {
  scores: Record<DimensionId, number>;
  keep: string[];
  fix: string[];
  quickWins: string[];
  average: number;
}

export interface Radar {
  size: number;
  polygon: string;
  ring: string;
  mid: string;
  axes: Array<{ id: DimensionId; label: string; x: number; y: number; lx: number; ly: number; value: number }>;
}

export declare const DIMENSIONS: Array<{ id: DimensionId; label: string }>;
export declare const MAX_ITEMS: number;
export declare function defaultOn(tier: 'local' | 'cloud', saved: boolean): boolean;
export declare function messages(opts: { html: string; tier?: string; findings?: Array<{ label: string; detail?: string }> }): Message[];
export declare function parse(reply: string): Critique | null;
export declare function radar(scores: Partial<Record<DimensionId, number>> | null, size?: number): Radar;
