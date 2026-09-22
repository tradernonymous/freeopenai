/** The Tweaks protocol, version 1 (UMD, shared with node:test). */
export interface TweakControl {
  var: string;
  label: string;
  type: 'slider' | 'color' | 'toggle' | 'select';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  on?: string;
  off?: string;
  options?: Array<{ value: string; label: string }>;
  default: string | number;
}

export interface TweakSchema {
  version: number;
  controls: TweakControl[];
}

export declare const VERSION: number;
export declare const MIN_CONTROLS: number;
export declare const MAX_CONTROLS: number;
export declare const TYPES: string[];
export declare const START: string;
export declare const END: string;
export declare const SCRIPT_TYPE: string;
export declare function validateSchema(raw: unknown): TweakSchema | null;
export declare function schemaFromHtml(html: string): TweakSchema | null;
export declare function sanitize(control: TweakControl, value: unknown): string | null;
export declare function readDefaults(html: string): Record<string, string>;
export declare function writeDefaults(html: string, vars: Record<string, string>): string;
export declare function css(vars: Record<string, string>): string;
export declare function initialValues(schema: TweakSchema | null, html: string): Record<string, string>;
export declare function message(schema: TweakSchema | null, values: Record<string, string>): { type: 'neura:set-tweaks'; version: number; vars: Record<string, string> };
