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
  kind: 'server' | 'browser' | 'local';
  ready: boolean;
  model: string;
  reason: string;
  note: string;
  edits: string;
  models?: string[];
  /** Local rows only: the sd-server binary and the weights the shell found. */
  binary?: string;
  modelPath?: string;
}

/** What the shell's `sd_find` reports about sd-server on this machine. */
export interface SdModelFile {
  name: string;
  path: string;
  bytes: number;
}

export interface SdFacts {
  found: boolean;
  binary: string;
  source: string;
  model: string;
  models: SdModelFile[];
  models_dir: string;
  expected_name: string;
  releases_url: string;
  models_url: string;
  default_port: number;
}

/** One poll of an sd-server job, as the screen should read it. */
export interface LocalJobView {
  state: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled';
  done: boolean;
  /** A data: URL, and only ever for a job that really carried an image. */
  url: string;
  label: string;
  error: string;
}

/** Puter's curated chains, mirrored from chatlib.js (test-asserted). */
export declare const PUTER_GENERATE_MODELS: string[];
export declare const PUTER_EDIT_MODELS: string[];
export declare const QUALITY: string;
export declare const SIZE_PRESETS: ImageSizePreset[];
export declare const BROWSER_ID: string;
export declare const LOCAL_ID: string;
export declare const LOCAL_STEPS: number;
export declare const LOCAL_STEP_PX: number;
export declare const LOCAL_MAX_PX: number;

export declare function localRow(facts: Partial<SdFacts> | null): ImageChoice;
export declare function isLocal(choice: Partial<ImageChoice> | null): boolean;
export declare function localSide(px: number): number;
export declare function localSize(sizeId: string): { width: number; height: number };
export declare function localRequest(request: {
  prompt: string;
  size: string;
  negativePrompt?: string;
  steps?: number;
}): { prompt: string; negativePrompt: string; width: number; height: number; steps: number };
export declare function localJobView(job: any): LocalJobView;
export declare function localElapsed(ms: number): string;
export declare function localAdvice(message: string): string;

export declare function preset(id: string): ImageSizePreset;
export declare function modelsFor(kind?: 'generate' | 'edit'): string[];
export declare function modelsForChoice(choice: Partial<ImageChoice>, kind?: 'generate' | 'edit'): string[];
export declare function providerChoices(report: any): ImageChoice[];
export declare function withLocal(choices: ImageChoice[], facts: Partial<SdFacts> | null): ImageChoice[];
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
