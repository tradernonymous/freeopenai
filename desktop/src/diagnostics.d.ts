/** The diagnostics report formatter (UMD, shared with node:test). */
export interface ShellFacts {
  version?: string;
  os?: string;
  arch?: string;
  webview2?: string;
  log_path?: string;
  log_bytes?: number;
  log_tail?: string;
  data_dir?: string;
  cache_dir?: string;
}
export interface ClientFacts {
  version?: string;
  engine?: string;
  state?: string;
  account?: string;
  hasShell?: boolean;
  backends?: string[];
  /** NEURA-035: the cold-start marks (startupTimings). */
  startup?: StartupTimings;
}
export declare function buildReport(input: {
  shell?: ShellFacts;
  client?: ClientFacts;
}): string;
export declare function redact(text: unknown): string;
export declare function redactUrl(value: unknown): string;
export declare function bytesLabel(bytes: number): string;
/** NEURA-035: ms since the window started loading; null = not reached yet. */
export interface StartupTimings {
  scriptStart: number | null;
  firstCommit: number | null;
  chatReady: number | null;
}
export type StartupStage = 'script-start' | 'first-commit' | 'chat-ready';
export declare const STARTUP_MARKS: Record<StartupStage, string>;
export declare const STARTUP_TARGET_MS: number;
/** Sets the stage's performance mark once; false when already set or unavailable. */
export declare function markStartup(stage: StartupStage, perf?: Performance): boolean;
export declare function startupTimings(perf?: Performance): StartupTimings;
export declare function startupLabel(timings: Partial<StartupTimings> | null | undefined, targetMs?: number): string;
