/** App-wide shortcuts and the key resolver (UMD, shared with node:test). */
export interface Binding {
  id: string;
  keys: string;
  label: string;
  when: 'always' | 'app';
  fixed?: boolean;
  custom?: boolean;
}

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export type KeyAction = { action: string; to?: string };

export declare const BINDINGS: Binding[];
export declare const OVERRIDES_KEY: string;
export declare const OFF_KEY: string;
export declare function normalise(combo: string): string;
export declare function comboOf(event: KeyLike): string;
export declare function readOverrides(store?: Storage | null): Record<string, string>;
export declare function withOverrides(overrides?: Record<string, string>): Binding[];
export declare function setOverride(id: string, combo: string | null, store?: Storage | null): Record<string, string>;
export declare function enabled(store?: Storage | null): boolean;
export declare function setEnabled(on: boolean, store?: Storage | null): void;
export declare function conflicts(
  bindings?: Array<{ id: string; keys: string }>,
  reserved?: Array<{ id: string; keys: string }>,
): Array<{ keys: string; ids: string[]; reason?: string }>;
export declare function resolveKey(
  state: { enabled?: boolean; paletteOpen?: boolean; bindings?: Binding[]; nav?: (event: KeyLike) => string | null },
  event: KeyLike,
): KeyAction | null;
