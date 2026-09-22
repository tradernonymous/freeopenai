/** What the Design studio asks a model, by tier (UMD, shared with node:test). */
type Message = { role: string; content: string };

export declare const CHARTER: string;
export declare const CLOUD_RULES: string;
export declare const LOCAL_RULES: string;
export declare const DECK_RULES: string;
export declare function tierOf(provider: string): 'local' | 'cloud';
export declare function buildMessages(opts: {
  brief: string;
  system?: import('./systems.js').DesignSystem | null;
  tier: 'local' | 'cloud';
  format?: { label?: string; width?: number; height?: number; unit?: string; deck?: boolean } | null;
  html?: string;
  answers?: Array<{ label: string; answer: string }>;
}): Message[];
export declare function commentMessages(opts: { outer: string; comment: string; tokens?: Record<string, string>; tier?: string }): Message[];
