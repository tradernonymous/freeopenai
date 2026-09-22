/** Chat import/export helpers (UMD, shared with node:test). */
export interface ChatImportResult {
  sessions: any[];
  added: number;
  updated: number;
  skipped: number;
  total: number;
  trimmed: number;
}
export interface ChatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}
/** Where the history lives under the shell: plain sessions in and out. */
export interface ChatBackend {
  list(): Promise<any[]>;
  put(sessions: any[]): Promise<unknown>;
  remove(ids: string[]): Promise<unknown>;
}
export interface HydrateOptions {
  /** The localStorage stand-in to migrate from (tests). */
  storage?: ChatStorage | null;
  /** Told once when the store falls back to localStorage. */
  onNotice?: (text: string) => void;
  /** Debounce before a flush, ms (default 400). */
  delay?: number;
}
export interface HydrateResult {
  mode: 'shell' | 'local';
  migrated: number;
  error?: string;
}
export declare function hydrate(
  backend:
    | ChatBackend
    | Promise<ChatBackend | null>
    | (() => ChatBackend | null | Promise<ChatBackend | null>)
    | null
    | undefined,
  options?: HydrateOptions,
): Promise<HydrateResult>;
export declare function flush(): Promise<boolean>;
/** Re-read the backend and take newer chats (another window wrote). */
export declare function refresh(): Promise<boolean>;
/** Take chats another window left in localStorage (runs on 'storage'). */
export declare function absorb(): boolean;
/** Save a chat made in another window so the main window has it at once. */
export declare function handOff(session: any): boolean;
export declare function persistent(): boolean;
export declare function detach(): void;
export declare const MAX_SESSIONS: number;
export declare const STORE_KEY: string;
export declare const CHATS_CHANGED_EVENT: string;
export declare function browserStorage(): ChatStorage | null;
export declare function isStoredSession(value: unknown): boolean;
export declare function readStore(storage?: ChatStorage | null): any[];
export declare function writeStoreReport(storage: ChatStorage | null, sessions: any[]): { ok: boolean; kept: number; dropped: number; quota: boolean };
export declare function writeStore(storage: ChatStorage | null, sessions: any[]): boolean;
export declare function byRecency(sessions: any[]): any[];
export declare function isChatSession(value: unknown): boolean;
export declare function updatedAtOf(session: any): number;
export declare function sanitize(list: unknown): any[];
export declare function merge(raw: unknown, incoming: unknown, max?: number): ChatImportResult;
export declare function summary(result: ChatImportResult | null): string;
export declare function downloadJson(
  fileName: string,
  text: string,
  options?: { document?: Document | null; URL?: typeof URL | null },
): boolean;
