/** Local version timeline per design project (UMD, shared with node:test). */
export interface Version {
  id: string;
  label: string;
  ts: number;
  html: string;
}

export declare const PREFIX: string;
export declare const MAX_ENTRIES: number;
export declare const MAX_CHARS: number;
export declare function list(projectId: string, store?: Storage | null): Version[];
export declare function push(projectId: string, entry: { html: string; label?: string; ts?: number }, store?: Storage | null): Version[];
export declare function get(projectId: string, id: string, store?: Storage | null): Version | null;
export declare function clear(projectId: string, store?: Storage | null): void;
