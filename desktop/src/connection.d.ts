/** The engine-outcome-to-copy module (UMD, shared with node:test). */
export type ConnectionKind =
  | 'ok'
  | 'unreachable'
  | 'signed-out'
  | 'refused'
  | 'rejected'
  | 'engine-error'
  | 'no-reply';

export interface ConnectionOutcome {
  kind: ConnectionKind;
  status: number;
  message: string;
  banner: string | null;
}

export interface ConnectionInput {
  status?: number | null;
  origin?: string;
  message?: string;
  error?: { status?: number } | null;
}

export declare const KINDS: ConnectionKind[];
export declare function kindForStatus(status: number | null | undefined): ConnectionKind;
export declare function messageFor(kind: ConnectionKind, options?: ConnectionInput): string;
export declare function bannerFor(kind: ConnectionKind): string | null;
export declare function classify(input?: ConnectionInput): ConnectionOutcome;
