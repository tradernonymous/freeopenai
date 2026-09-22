/** Device presets, the browser frame and deck mode (UMD, shared with node:test). */
export type PresetId = 'phone' | 'tablet' | 'desktop' | 'browser' | 'deck';

export interface Preset {
  label: string;
  width: number;
  height: number;
  frame: 'phone' | 'tablet' | 'none' | 'browser' | 'deck';
}

export interface Device extends Preset {
  id: PresetId;
  outerHeight: number;
}

export declare const PRESETS: Record<PresetId, Preset>;
export declare const CHROME_HEIGHT: number;
export declare const GUTTER: number;
export declare function deckSize(format?: { width?: number; height?: number; unit?: string } | null): { width: number; height: number };
export declare function device(id: string, format?: { width?: number; height?: number; unit?: string } | null): Device;
export declare function fitScale(box: { w: number; h: number }, device: { width: number; height: number; outerHeight?: number }): number;
export declare function clampSlide(index: number, count: number, delta: number): number;
export declare function countSlides(html: string): number;
export declare function counter(index: number, count: number): string;
