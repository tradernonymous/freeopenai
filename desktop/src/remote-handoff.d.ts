/**
 * Remote handoff orchestrator: package workspace, push to engine, stream status.
 */

export interface HandoffSession {
  id: string;
  status: string;
  root?: string;
  plan?: string;
  events?: unknown[];
  abort?: (() => void) | null;
}

export interface HandoffCallbacks {
  api: {
    buildRun: (body: { plan: string; repo?: string }) => Promise<unknown>;
    buildEvents: (id: string) => string;
  };
  packageWorkspace: (root: string) => Promise<{ path: string; name: string }>;
  uploadToEngine: (path: string, name: string) => Promise<unknown>;
  createBuildSession: (plan: string, uploadResult: unknown) => Promise<{ id: string; status: string }>;
  onEvent?: (event: Record<string, unknown>) => void;
}

export declare const HANDOFF_TIMEOUT_MS: number;
export declare function startHandoff(root: string, plan: string, callbacks: HandoffCallbacks): Promise<{ id: string; status: string }>;
export declare function watchSession(sessionId: string, callbacks: { sseUrl: string; onEvent?: (event: Record<string, unknown>) => void }): () => void;
export declare function stopHandoff(): void;
export declare function active(): HandoffSession | null;
export declare function isActive(): boolean;
export declare function statusText(): string;
