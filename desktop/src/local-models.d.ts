/** Running a model on this machine: catalogue, fit check, state (UMD). */

export interface LocalModelEntry {
  /** Hugging Face GGUF repository. */
  id: string;
  /** The one file in it the app downloads. */
  file: string;
  label: string;
  note: string;
  quant: string;
  sizeGb: number;
  context: number;
  quality: 'best' | 'good' | 'light';
}

export interface MachineFacts {
  ramGb: number;
  ramKnown: boolean;
  cores: number;
}

export interface FitReport {
  weightsGb: number;
  kvGb: number;
  neededGb: number;
  availableGb: number;
  fits: boolean;
  tight: boolean;
  ramKnown: boolean;
  /** Empty when it fits; otherwise the sentence saying why not. */
  reason: string;
}

export type LocalModelState = 'stopped' | 'starting' | 'ready' | 'error';

export declare const CATALOGUE: LocalModelEntry[];
export declare function parseHfRef(input: string): { repo: string; file: string; quant: string } | null;
export declare function parseQuant(name: string): string;
export declare function isSplit(name: string): boolean;
export declare function toolRisk(quant: string): string;
export declare function quantRank(quant: string): number;
export declare function pickDefaultFile(files: Array<{ name: string; size: number }>, machineInfo?: MachineFacts): { name: string; size: number } | null;
export declare function downloadLabel(progress: any): string;
export declare const STATES: LocalModelState[];
export declare function machine(): MachineFacts;
export declare function fit(entry: Partial<LocalModelEntry>, machineInfo?: MachineFacts): FitReport;
export declare function contextFor(entry: Partial<LocalModelEntry>): number;
export declare function quantFor(entry: Partial<LocalModelEntry>): string;
export declare function stateOf(status: any): LocalModelState;

/** Progress through the shell's warm-up wait, or null when nothing is loading. */
export declare function warmup(status: any): {
  elapsedSeconds: number;
  deadlineSeconds: number;
  fraction: number;
  label: string;
} | null;

export declare const WARMUP_MS: number;
export declare function statusLine(status: any): string;
export declare function providerRow(status: any): {
  id: string;
  label: string;
  configured: boolean;
  kind: string;
  baseUrl: string;
  local: boolean;
  model: string;
  apiKey: string;
  file: string;
} | null;
export declare function chatBody(model: string, messages: Array<{ role: string; content: any }>): {
  model: string;
  messages: Array<{ role: string; content: any }>;
  stream: boolean;
};
export declare function startAdvice(message: string): string;
