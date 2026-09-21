/** The Office/PDF file engine (UMD, shared with node:test). */
export interface XlsxSheet {
  name: string;
  rows: any[][];
}
export declare function extractDocxText(bytes: Uint8Array): Promise<string>;
export declare function extractXlsxSheets(bytes: Uint8Array): Promise<XlsxSheet[]>;
export declare function sheetToText(rows: any[][]): string;
export declare function extractPptxText(bytes: Uint8Array): Promise<string>;
export declare function writeDocx(title: string, paragraphs: string[]): Promise<Uint8Array>;
export declare function writeXlsx(title: string, sheets: XlsxSheet[]): Promise<Uint8Array>;
export declare function writePptx(title: string, slideTexts: string[]): Promise<Uint8Array>;
