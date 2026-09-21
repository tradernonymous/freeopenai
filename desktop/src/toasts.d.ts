/** The toast queue rules (UMD, shared with node:test). */
export type ToastKind = 'info' | 'ok' | 'warn' | 'error';
export interface Toast {
  id: string;
  text: string;
  kind: ToastKind;
  sticky?: boolean;
  at: number;
}
export declare const MAX_VISIBLE: number;
export declare const DEFAULT_MS: number;
export declare const REPEAT_WINDOW_MS: number;
export declare function iconFor(kind: string): string;
export declare function push(
  list: Toast[],
  toast: { text: string; kind?: ToastKind; sticky?: boolean; id?: string },
  now?: number,
): Toast[];
export declare function dismiss(list: Toast[], id: string): Toast[];
export declare function expired(list: Toast[], now?: number, lifetimeMs?: number): Toast[];
export declare function prune(list: Toast[], now?: number, lifetimeMs?: number): Toast[];
