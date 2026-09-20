/** The smart provider-fallback policy (UMD, shared with node:test). */
export interface FallbackAttempt {
  provider: string;
  model: string;
  label: string;
  why: string;
}

export interface FallbackPlan {
  attempts: FallbackAttempt[];
  automatic: boolean;
  note: string;
}

export declare function plan(input: {
  failure?: { kind?: string };
  provider?: string;
  model?: string;
  next?: string;
  local?: { baseUrl?: string; model?: string; ready?: boolean } | null;
}): FallbackPlan;

export declare const SWITCHABLE: string[];
export declare const MAX_ATTEMPTS: number;
