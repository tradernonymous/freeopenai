/** Exports and the handoff to Code (UMD, shared with node:test). */
export interface Artboard {
  name: string;
  index: number;
  width: number;
  height: number;
}

export declare const ARTBOARD_CLASS: string;
export declare function slug(name: string): string;
export declare function rootVars(html: string): Array<{ name: string; value: string }>;
export declare function tokensCss(html: string, fallback?: string): string;
export declare function slidesOf(html: string): string[];
export declare function artboards(html: string, stage: { width: number; height: number }, page: { width: number; height: number }): Artboard[];
export declare function scopeCss(css: string, cls?: string): string;
export declare function cssOf(html: string): string;
export declare function artboardSvg(opts: { css: string; xhtml: string; width: number; height: number }): string;
export declare function slideTexts(html: string): string[];
export declare function readme(name: string, html: string, tokens: Array<{ name: string; value: string }>): string;
export declare function handoffFiles(opts: { name: string; html: string; designMd: string; fallbackTokens?: string }): Array<[string, string]>;
export declare function handoffBrief(opts: { name: string; dir: string; target?: string }): string;
export declare function projectFiles(opts: {
  name: string;
  html: string;
  designMd: string;
  fallbackTokens?: string;
  template?: string;
  systemName?: string;
  versions?: Array<{ label: string; html: string; ts: number }>;
  now?: number;
}): Array<[string, string]>;
