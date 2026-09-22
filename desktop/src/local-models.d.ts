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

/** One part of a multi-part set: 1-based index, part count, name before the suffix. */
export declare function splitInfo(name: string): { index: number; count: number; stem: string } | null;
/** Every part of the set `name` belongs to, part 1 first; a single file is a set of one. */
export declare function splitParts(name: string): string[];
/** Base name without .gguf or a part suffix. */
export declare function modelName(fileOrPath: string): string;

/** A repo file row once split sets are folded: name is part 1, size the sum. */
export interface HubSetFields {
  parts: string[];
  partSizes: number[];
  /** False when the repo listing is missing a part: shown, never offered. */
  complete: boolean;
}
export declare function groupHubFiles<T extends { name: string; size: number }>(files: T[]): Array<T & HubSetFields>;

/** A models-folder row once split sets are folded: file/path name part 1, bytes the sum. */
export interface LocalSetFile {
  file: string;
  path: string;
  bytes: number;
  /** A .part or a missing part: resumable, not runnable. */
  partial: boolean;
  parts: string[];
  missing: string[];
  complete: boolean;
}
export declare function groupLocalFiles(files: Array<{ file: string; path: string; bytes: number; partial?: boolean }>): LocalSetFile[];

/** Where a set download stands: part 1's name, the 0-based part in flight, bytes done before it, the set's size. */
export interface SplitDownloadState {
  file: string;
  index: number;
  count: number;
  before: number;
  total: number;
}
export declare function setProgress(set: SplitDownloadState, progress: any): {
  repo: string;
  file: string;
  received: number;
  total: number;
  done: boolean;
  cancelled: boolean;
  error: string;
  path: string;
  part: number;
  parts: number;
};

export declare function toolRisk(quant: string): string;
export declare function quantRank(quant: string): number;
export declare function pickDefaultFile<T extends { name: string; size: number }>(files: T[], machineInfo?: MachineFacts): (T & HubSetFields) | null;
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
