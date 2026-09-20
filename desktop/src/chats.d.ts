/** Chat import/export helpers (UMD, shared with node:test). */
export interface ChatImportResult {
  sessions: any[];
  added: number;
  updated: number;
  skipped: number;
  total: number;
  trimmed: number;
}
export declare const MAX_SESSIONS: number;
export declare const CHATS_CHANGED_EVENT: string;
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
