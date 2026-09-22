/** The studio's model/preview contract (UMD, shared with node:test). */
export interface Question {
  id: string;
  label: string;
  options: string[];
}

export interface Extracted {
  html: string | null;
  questions: Question[] | null;
  assumptions: string[];
  tagged: boolean;
}

export interface Control {
  kind: 'color' | 'length' | 'number' | 'text';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  value?: number;
}

export declare const HOST_MARK: string;
export declare const MAX_QUESTIONS: number;
export declare const HOST_SCRIPT: string;
export declare function extract(reply: string): Extracted;
export declare function extractFragment(reply: string): string | null;
export declare function inject(html: string): string;
export declare function strip(html: string): string;
export declare function cssVars(html: string): Array<{ name: string; value: string }>;
export declare function setTweaks(html: string, vars: Record<string, string>): string;
export declare function controlFor(name: string, value: string): Control;
