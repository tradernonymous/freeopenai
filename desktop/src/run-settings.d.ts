/** Run settings: how a local model is loaded and asked (UMD). */

export interface RunValues {
  /** 0 = Auto. */
  ctx: number;
  /** -1 = all layers on the GPU, 0 = CPU only. */
  gpuLayers: number;
  /** 0 = Auto (the machine's cores). */
  threads: number;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  repeatPenalty: number;
  system: string;
}

export interface RunEstimate {
  weightsGb: number;
  kvGb: number;
  gpuGb: number;
  totalGb: number;
  warnings: string[];
}

export declare const SETTINGS_KEY: string;
export declare const PRESETS_KEY: string;
export declare const DEFAULTS: RunValues;
export declare const LIMITS: Record<string, [number, number]>;
export declare const LOAD_TIME: string[];
export declare function clean(values: Partial<RunValues> | null | undefined): RunValues;
export declare function get(modelId: string, storage?: any): RunValues;
export declare function set(modelId: string, values: Partial<RunValues>, storage?: any): boolean;
export declare function reset(modelId: string, storage?: any): boolean;
export declare function presets(storage?: any): Record<string, RunValues>;
export declare function savePreset(name: string, values: Partial<RunValues>, storage?: any): boolean;
export declare function deletePreset(name: string, storage?: any): boolean;
export declare function needsReload(before: Partial<RunValues>, after: Partial<RunValues>): boolean;
export declare function estimate(
  model: { bytes?: number; ctx?: number; gpuLayers?: number; kvBytesPerToken?: number },
  machine?: { ramGb?: number; vramGb?: number },
): RunEstimate;
export declare function ollamaOptions(values: Partial<RunValues>): Record<string, number>;
export declare function openaiParams(values: Partial<RunValues>): Record<string, number>;
export declare function loadArgs(values: Partial<RunValues>, cores?: number): { ctx?: number; gpuLayers?: number; threads?: number };
export declare function withSystem<T extends { role: string; content: any }>(messages: T[], values: Partial<RunValues>): T[];

/** What a model reports about itself: trained context and KV-cache cost. */
export interface ModelLimits {
  trainCtx?: number;
  kvBytesPerToken?: number;
  source?: string;
  at?: number;
  /** From a GGUF header: the architecture, layer count, size label, SWA window. */
  arch?: string;
  layers?: number;
  sizeLabel?: string;
  slidingWindow?: number;
}
/** A GGUF file's header as the shell's gguf_info returns it. */
export interface GgufInfo {
  version?: number;
  architecture: string;
  name?: string | null;
  size_label?: string | null;
  file_type?: number | null;
  context_length?: number | null;
  block_count?: number | null;
  embedding_length?: number | null;
  head_count?: number | null;
  head_count_kv?: number | null;
  key_length?: number | null;
  value_length?: number | null;
  sliding_window?: number | null;
  complete?: boolean;
}
export declare const LIMITS_KEY: string;
export declare const CTX_STEPS: number[];
export declare const DEFAULT_KV_BYTES: number;
export declare const AUTO_CAP: number;
export declare function limitsFor(modelId: string, storage?: any): ModelLimits | null;
export declare function setLimits(modelId: string, limits: ModelLimits, storage?: any): boolean;
export declare function parseOllamaShow(show: any): ModelLimits;
export declare function parseLlamaModels(body: any): ModelLimits;
export declare function parseGgufInfo(info: Partial<GgufInfo> | null | undefined): ModelLimits;
export declare function autoCtx(limits: ModelLimits | null, model?: { bytes?: number; gpuLayers?: number }, machine?: { ramGb?: number; vramGb?: number }): number;
export declare function effectiveCtx(values: Partial<RunValues>, limits: ModelLimits | null, model?: { bytes?: number; gpuLayers?: number }, machine?: { ramGb?: number; vramGb?: number }): number;
export declare function ctxSteps(limits: ModelLimits | null): number[];
