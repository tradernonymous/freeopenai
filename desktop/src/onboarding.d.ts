/** The shell-state policy (UMD, shared with node:test). */
export type ShellSurface = 'connect' | 'app';
export type ShellReason = 'checking' | 'first-run' | 'unreachable' | 'signed-out' | 'ready' | 'degraded';

export interface ShellState {
  surface: ShellSurface;
  reason: ShellReason;
  kind: import('./connection.js').ConnectionKind | null;
  firstRun: boolean;
  /** The outcome kind worth a shell banner, when the app is on screen. */
  bannerKind: import('./connection.js').ConnectionKind | null;
}

export interface ShellInput {
  outcome?: { kind?: string } | null;
  health?: { ok?: boolean; loginRequired?: boolean } | null;
  signedIn?: boolean;
  serverSaved?: boolean;
}

export declare const REASONS: ShellReason[];
export declare const ADDRESS_KINDS: string[];
export declare function shellState(input?: ShellInput): ShellState;
export declare function connectTitle(reason: ShellReason): string;
export declare function connectAdvice(reason: ShellReason): string;
