/** Which service draws, with which model, at which shape (UMD, node-tested). */

export interface ImageSizePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  ratio: { w: number; h: number };
}

export interface ImageChoice {
  id: string;
  label: string;
  kind: 'server' | 'browser';
  ready: boolean;
  model: string;
  reason: string;
  note: string;
  edits: string;
  models?: string[];
}

/** Puter's curated chains, mirrored from chatlib.js (test-asserted). */
export declare const PUTER_GENERATE_MODELS: string[];
export declare const PUTER_EDIT_MODELS: string[];
export declare const QUALITY: string;
export declare const SIZE_PRESETS: ImageSizePreset[];
export declare const BROWSER_ID: string;

export declare function preset(id: string): ImageSizePreset;
export declare function modelsFor(kind?: 'generate' | 'edit'): string[];
export declare function modelsForChoice(choice: Partial<ImageChoice>, kind?: 'generate' | 'edit'): string[];
export declare function providerChoices(report: any): ImageChoice[];
export declare function chosen(choiceId: string, choices: ImageChoice[]): ImageChoice | null;
export declare function modelFor(choice: Partial<ImageChoice>, kind?: 'generate' | 'edit'): string;
export declare function serverBody(
  choice: Partial<ImageChoice>,
  request: { prompt: string; size: string; kind?: 'generate' | 'edit'; model?: string },
): { prompt: string; provider: string; size: string; quality: string; model?: string };
export declare function sizeLabel(id: string): string;
export declare function attribution(data: any): { who: string; notes: string[] };
export declare function describePuterError(error: any): string;
export declare function puterAdvice(message: string): string;
