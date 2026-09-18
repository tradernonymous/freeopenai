/** The brand engine (UMD, shared with node:test). */
export declare function parseColor(raw: unknown): { r: number; g: number; b: number } | null;
export declare function luminance(rgb: { r: number; g: number; b: number }): number;
export declare function contrastRatio(a: string, b: string): number | null;
export declare function contrastReport(fg: string, bg: string): {
  ratio: number | null;
  passAA: boolean;
  passAALarge: boolean;
  passAAA: boolean;
};
export declare function colorName(raw: string): string;
export declare function paletteFromText(text: string, limit?: number): string[];
export declare function semanticRoles(palette: string[]): {
  paper: string;
  ink: string;
  accent: string;
  muted: string;
} | null;
export declare function designMd(brand: any, title?: string): string;
