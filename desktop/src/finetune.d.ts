/**
 * Experimental local fine-tuning via llama.cpp (LoRA).
 */

export interface FinetuneRequirements {
  ramGb: number;
  diskGb: number;
  fits: boolean;
  reason: string;
}

export interface DatasetValidation {
  valid: boolean;
  count: number;
  errors: string[];
}

export interface FinetuneSession {
  id: string;
  baseModel: string;
  datasetPath: string;
  loraR: number;
  loraAlpha: number;
  learningRate: number;
  epochs: number;
  batchSize: number;
  status: 'idle' | 'validating' | 'training' | 'done' | 'error' | 'stopped';
  progress: number;
  currentEpoch: number;
  totalEpochs: number;
  outputPath: string;
  error: string | null;
  logs: string[];
  startedAt: number | null;
  updatedAt: number | null;
}

export declare const MIN_RAM_GB: number;
export declare const MIN_DISK_GB: number;
export declare const DEFAULT_LORA_R: number;
export declare const DEFAULT_LORA_ALPHA: number;
export declare const DEFAULT_LR: number;
export declare const DEFAULT_EPOCHS: number;
export declare const DEFAULT_BATCH: number;
export declare function estimateRequirements(baseModelGb: number, loraR: number, datasetSize: number): FinetuneRequirements;
export declare function validateDataset(jsonlText: string): DatasetValidation;
export declare function createSession(opts?: Partial<FinetuneSession>): FinetuneSession;
export declare function buildCommand(session: FinetuneSession): string[];
export declare function statusText(session: FinetuneSession | null): string;
