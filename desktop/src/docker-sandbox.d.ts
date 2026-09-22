/** Opt-in Docker sandbox for the coding agent's run_command (UMD). */

export interface DockerSettings {
  enabled: boolean;
  image: string;
}

export interface RunResultLike {
  exitCode: number | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
}

export type Runner<R> = (command: string, cwd: string, timeoutMs?: number) => Promise<R>;

export declare const KEY: string;
export declare const DEFAULT_IMAGE: string;
export declare const VERSION_CHECK: string;
export declare const RUN_TIMEOUT_MS: number;
export declare const DOCKER_DOWN: string;
export declare function settings(storage?: any): DockerSettings;
export declare function saveSettings(next: Partial<DockerSettings>, storage?: any): boolean;
export declare function checkImage(image: string): { ok: true; image: string } | { ok: false; reason: string };
export declare function checkCwd(cwd: string | undefined | null): string | null;
export declare function wrap(opts: { root: string; command: string; cwd?: string; image?: string }):
  | { ok: true; command: string }
  | { ok: false; reason: string };
export declare function isDockerUp(result: RunResultLike | null | undefined): boolean;
export declare function run<R extends RunResultLike>(
  opts: { root: string; command: string; cwd?: string; timeoutMs?: number; settings?: DockerSettings },
  runner: Runner<R>,
): Promise<R>;
export declare function resetCheck(): void;
