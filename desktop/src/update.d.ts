/** The update/version module (UMD, shared with node:test). */
export interface UpdateArtifact {
  name: string;
  sha256: string;
  size: number;
}
export interface VersionPayload {
  version: string;
  builtAt: string;
  commit: string;
  artifacts: UpdateArtifact[];
}
export declare const DEFAULT_REPO: string;
export declare const VERSION_FILE: string;
export declare const DEFAULT_ATTEMPTS: number;
export declare const DEFAULT_BASE_DELAY_MS: number;
export declare const MAX_DELAY_MS: number;
export declare function versionUrl(repo?: string): string;
export declare function desktopUrl(repo?: string): string;
export declare function parseVersion(value: unknown): number[] | null;
export declare function compareVersions(a: unknown, b: unknown): number | null;
export declare function isNewer(remote: unknown, local: unknown): boolean;
export declare function readVersionPayload(payload: any): VersionPayload | null;
export declare function installerFor(parsed: VersionPayload | null): UpdateArtifact | null;
export declare function humanSize(bytes: number): string;
export declare function delayFor(attempt: number, baseDelayMs?: number): number;
export declare function fetchVersion(options?: {
  url?: string;
  repo?: string;
  attempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<VersionPayload | null>;
