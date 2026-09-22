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
/** A picture for office.writePptx: a PNG/JPEG data: URL placed in EMU. */
export interface DeckImage {
  src: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  name: string;
}
export interface DeckOptions {
  /** The deck's stage in px (default 1920x1080). */
  stage?: { width: number; height: number };
  /** A same-document image source -> a PNG/JPEG data: URL, or '' to skip it. */
  resolve?: (src: string) => string;
}
export declare function slideImages(
  slideHtml: string,
  opts?: DeckOptions & { size?: { cx: number; cy: number } },
): DeckImage[];
export declare function pptxDeck(html: string, opts?: DeckOptions): {
  size: { cx: number; cy: number };
  slides: Array<{ text: string; images: DeckImage[] }>;
};
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

/** Framework exports (Phase 12f). */
export declare function componentName(name: string): string;
export declare function htmlToJsx(html: string, notes?: { handlers: number; scripts: number; customProps?: boolean }): string;
export interface ReactExport {
  name: string;
  tsx: string;
  css: string;
  tokens: string;
  files: Array<[string, string]>;
}
export declare function toReact(html: string, name: string): ReactExport;
export interface FrameworkPrompt {
  name: string;
  language: 'dart' | 'swift';
  fileName: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
}
export declare function toFlutter(html: string, name: string): FrameworkPrompt;
export declare function toSwiftUI(html: string, name: string): FrameworkPrompt;
export declare function codeFromReply(reply: string, language?: string): string;
