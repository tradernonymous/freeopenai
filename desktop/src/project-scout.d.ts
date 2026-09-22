/**
 * project-scout (NEURA-056): the open folder mapped once into a compact index,
 * then queried for "where is X?" instead of re-walking the tree every turn.
 *
 * Nothing here touches a filesystem: the lister and the reader are passed in,
 * so the whole module is pure and testable without one.
 */

export type SymbolKind = 'function' | 'class' | 'const' | 'type' | 'heading';

export interface ScoutSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based line in the file. */
  line: number;
  /** The declaration line started with `export` or `pub`. */
  exported: boolean;
}

export interface IndexedFile {
  path: string;
  size: number;
  /** 0 when the lister gave no mtime; the digest then rests on size alone. */
  mtime: number;
  lang: string;
  symbols: ScoutSymbol[];
  /** False when the file was skipped (binary, too big, past a cap). */
  read: boolean;
  /** Why it was not read; '' when it was. */
  why: string;
}

export interface Area {
  dir: string;
  files: number;
  languages: string[];
}

export interface EntryPoint {
  path: string;
  why: string;
}

export interface Truncated {
  files: boolean;
  bytes: boolean;
  depth: boolean;
  reasons: string[];
}

export interface ScoutStats {
  dirsSeen: number;
  filesSeen: number;
  filesIndexed: number;
  filesRead: number;
  bytesRead: number;
  skippedDirs: number;
  skippedBinary: number;
  skippedTooBig: number;
}

export interface ProjectIndex {
  version: number;
  root: string;
  builtAt: number;
  checkedAt: number;
  /** Always 'regex': there is no language parser here, and it says so. */
  parser: 'regex';
  note: string;
  files: IndexedFile[];
  entries: EntryPoint[];
  areas: Area[];
  /** Hash over `path:size:mtime` for every file; staleness is a mismatch. */
  digest: string;
  truncated: Truncated;
  stats: ScoutStats;
  stale: boolean;
  staleReason: string;
}

export interface ScanResult {
  files: Array<{ path: string; size: number; mtime: number }>;
  stats: ScoutStats;
  truncated: Truncated;
  digest: string;
}

export interface Freshness {
  stale: boolean;
  reason: string;
  added: string[];
  removed: string[];
  changed: string[];
  digest: string;
}

export interface Match {
  path: string;
  /** 1-based line; 1 when the match is the filename itself. */
  line: number;
  name: string;
  kind: SymbolKind | 'file';
  exported: boolean;
  score: number;
  why: 'symbol' | 'filename';
}

export interface QueryAnswer {
  ok: boolean;
  query: string;
  /** Paths and line numbers only -- never file contents. */
  matches: Match[];
  note: string;
  stale: boolean;
  staleReason: string;
}

export interface ScoutStatus {
  state: 'none' | 'building' | 'built' | 'stale';
  label: string;
  fileCount: number;
  symbolCount: number;
  builtAt: number;
  root: string;
  reason: string;
}

export interface ListEntry {
  name: string;
  dir?: boolean;
  size?: number;
  mtime?: number;
}

export interface ScoutIO {
  /** Bound to the open folder by the caller; '' is the root. */
  listFiles: (path: string) => Promise<{ entries: ListEntry[] } | ListEntry[]>;
  readFile?: (path: string) => Promise<{ text?: string; binary?: boolean; bytes?: number } | string>;
}

export interface BuildOptions {
  maxFiles?: number;
  maxDepth?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxSymbols?: number;
  /** Injected clock, so a test's index has a fixed builtAt. */
  now?: number;
}

export declare const KEY: string;
export declare const CHANGED_EVENT: string;
export declare const REBUILD_EVENT: string;
export declare const VERSION: number;
export declare const MAX_FILES: number;
export declare const MAX_TOTAL_BYTES: number;
export declare const MAX_FILE_BYTES: number;
export declare const MAX_DEPTH: number;
export declare const MAX_SYMBOLS_PER_FILE: number;
export declare const MAX_QUERY_RESULTS: number;
export declare const SKIP_DIRS: string[];
export declare const BINARY_EXTS: string[];
export declare const ENTRY_FILES: Record<string, string>;
export declare const NO_PARSER_NOTE: string;

export declare function shouldSkipDir(name: string): boolean;
export declare function isBinaryPath(path: string): boolean;
export declare function languageOf(path: string): string;
export declare function entryReason(path: string): string;
export declare function digestOf(files: Array<{ path: string; size?: number; mtime?: number }>): string;
export declare function extractSymbols(text: string, path: string, limit?: number): ScoutSymbol[];
export declare function scanTree(listFiles: ScoutIO['listFiles'], options?: BuildOptions): Promise<ScanResult>;
export declare function buildIndex(root: string, io: ScoutIO, options?: BuildOptions): Promise<ProjectIndex>;
export declare function checkFresh(index: ProjectIndex | null, io: ScoutIO, options?: BuildOptions): Promise<Freshness>;
export declare function markFresh(index: ProjectIndex, freshness: Freshness, now?: number): ProjectIndex;
export declare function query(index: ProjectIndex | null, text: string, options?: { limit?: number }): QueryAnswer;
export declare function describe(index: ProjectIndex | null, options?: { maxAreas?: number }): string;
export declare function status(index: ProjectIndex | null, building?: boolean): ScoutStatus;
export declare function areasOf(files: Array<{ path: string }>): Area[];
export declare function entriesOf(files: Array<{ path: string }>): EntryPoint[];
export declare function load(root?: string, store?: any): ProjectIndex | null;
export declare function save(index: ProjectIndex, store?: any): boolean;
export declare function clear(store?: any): boolean;
export declare function requestRebuild(): void;
