/** NEURA-051: the local runtime's own facts, polled (UMD, shared with node:test). */

export type LocalRuntimeKind = 'llama.cpp' | 'ollama';

export interface LocalTarget {
  kind: LocalRuntimeKind;
  /** Origin with no trailing slash, e.g. `http://127.0.0.1:8080`. */
  base: string;
  /** llama-server's `--api-key`; empty for Ollama. */
  apiKey?: string;
  /** What the caller already knows the model is called; the runtime may correct it. */
  name?: string;
  /** Whether silence is worth reporting (see targetForOllama). */
  announce?: boolean;
}

export interface LocalStatus {
  kind: LocalRuntimeKind | '';
  base: string;
  announce: boolean;
  reachable: boolean;
  /** llama.cpp answered 503: the weights are not in memory yet. */
  loading: boolean;
  model: string;
  /** The window one slot gets; 0 when the runtime does not say. */
  contextSize: number;
  /** -1 when unknown. */
  slotsBusy: number;
  slotsTotal: number;
  slotsKnown: boolean;
  /** Answering, but not everything asked for exists (no /slots, Ollama). */
  degraded: boolean;
  detail: string;
  at: number;
}

export interface LocalChip {
  show: boolean;
  tone: 'ok' | 'warn' | 'error' | 'muted';
  label: string;
  title: string;
}

export interface ProbeOptions {
  /** Injected so tests need no network; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: number;
}

export interface HealthFacts {
  reachable: boolean;
  loading: boolean;
  slotsBusy: number;
  slotsTotal: number;
  detail: string;
}

export interface SlotsFacts {
  supported: boolean;
  busy: number;
  total: number;
  contextSize: number;
  model: string;
  detail: string;
}

export interface OllamaPsFacts {
  reachable: boolean;
  model: string;
  contextSize: number;
  detail: string;
}

export interface Reply {
  ok: boolean;
  status: number;
  body: any;
  error?: string;
}

export declare const POLL_MS: number;
export declare const MAX_POLL_MS: number;
export declare const TIMEOUT_MS: number;
export declare const KINDS: LocalRuntimeKind[];
export declare function empty(): LocalStatus;
export declare function targetFromShell(status: { state?: string; base_url?: string; api_key?: string; repo?: string; file?: string } | null | undefined): LocalTarget | null;
export declare function targetForOllama(base: string, announce?: boolean): LocalTarget | null;
export declare function parseHealth(reply: Reply | null | undefined): HealthFacts;
export declare function parseSlots(reply: Reply | null | undefined): SlotsFacts;
export declare function parseOllamaPs(reply: Reply | null | undefined): OllamaPsFacts;
export declare function contextLabel(size: number): string;
export declare function probe(target: LocalTarget | null | undefined, options?: ProbeOptions): Promise<LocalStatus>;
export declare function chip(status: LocalStatus | null | undefined): LocalChip;
export declare function nextDelay(status: LocalStatus | null | undefined, previous?: number): number;
