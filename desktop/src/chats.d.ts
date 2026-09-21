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
}
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
