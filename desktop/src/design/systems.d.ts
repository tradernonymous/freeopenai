/** Design systems: tokens + DESIGN.md (UMD, shared with node:test). */
export interface DesignSystem {
  id: string;
  name: string;
  notes?: string;
  tokens: Record<string, string>;
  source?: string;
}

export interface Variant {
  id: 'book' | 'refined' | 'novel';
  label: string;
  caption: string;
  vars: Record<string, string>;
}

export declare const STORE_KEY: string;
export declare const TOKENS: string[];
export declare const PRESETS: DesignSystem[];
export declare function byId(id: string, extra?: DesignSystem[]): DesignSystem | null;
export declare function tokensCss(system: DesignSystem): string;
export declare function designMd(system: DesignSystem): string;
export declare function fromBrand(brand: any, name?: string): DesignSystem;
export declare function parseTokens(source: string): Record<string, string>;
export declare function importSystem(source: string, name?: string): DesignSystem | null;
export declare function readStore(store?: Storage | null): DesignSystem[];
export declare function saveImported(system: DesignSystem, store?: Storage | null): DesignSystem[];
export declare function variants(tokens: Record<string, string>): Variant[];
export declare function hexToHsl(hex: string): { h: number; s: number; l: number } | null;
export declare function hslToHex(hsl: { h: number; s: number; l: number }): string;
