/** Why a turn failed, and what to do about it (UMD, shared with node:test). */
export interface FailureRule {
  kind: string;
  label: string;
  test: RegExp;
  advice: string;
  retryable: boolean;
}

export interface Attribution {
  kind: string;
  /** A short tag: 'Rate-limited', 'Overloaded', 'Failed'. */
  label: string;
  /** What was asked: 'Kilo Code · kilo-auto/free'. */
  asked: string;
  /** One sentence naming what was asked. */
  summary: string;
  /** The provider's own words, trimmed. */
  upstream: string;
  advice: string;
  retryable: boolean;
}

export interface ImageAttribution extends Attribution {
  /** The services the engine walked, in order. */
  tried: string[];
  /** "Tried X, Y." or ''. */
  walk: string;
}

export declare const RULES: FailureRule[];
export declare function classify(message: string): FailureRule;
export declare function attribute(input: {
  message?: string;
  provider?: string;
  providerLabel?: string;
  model?: string;
}): Attribution;
export declare function attributeImage(input: {
  error?: string;
  message?: string;
  asked?: string;
  tried?: string[];
}): ImageAttribution;
export declare function askedName(input: { provider?: string; providerLabel?: string; model?: string }): string;
export declare function nextModel(current: string, list: Array<{ id?: string } | string>): string;
