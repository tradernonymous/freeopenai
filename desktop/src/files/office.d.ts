/** The Office/PDF file engine (UMD, shared with node:test). */
export interface XlsxSheet {
  name: string;
  rows: any[][];
}
/** A picture on a slide: a PNG/JPEG `data:` URL (or raw bytes), placed in EMU. */
export interface PptxImage {
  src?: string;
  data?: Uint8Array;
  x: number;
  y: number;
  cx: number;
  cy: number;
  name?: string;
}
export interface PptxSlide {
  text?: string;
  images?: PptxImage[];
}
export declare function extractDocxText(bytes: Uint8Array): Promise<string>;
export declare function extractXlsxSheets(bytes: Uint8Array): Promise<XlsxSheet[]>;
export declare function sheetToText(rows: any[][]): string;
export declare function extractPptxText(bytes: Uint8Array): Promise<string>;
export declare function writeDocx(title: string, paragraphs: string[]): Promise<Uint8Array>;
export declare function writeXlsx(title: string, sheets: XlsxSheet[]): Promise<Uint8Array>;
/** Slides are text, or { text, images }; `size` (EMU) sets the slide size. */
export declare function writePptx(
  title: string,
  slides: Array<string | PptxSlide>,
  options?: { size?: { cx: number; cy: number } },
): Promise<Uint8Array>;
export declare function decodeImageDataUrl(url: string): { kind: 'png' | 'jpeg'; bytes: Uint8Array } | null;
