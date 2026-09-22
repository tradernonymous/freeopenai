/**
 * NEURA-054 -- bring your own key.
 *
 * Note the shape of this surface: nothing takes or returns an API key except
 * saveKey(), which hands it to the shell and resolves with a yes/no. There is
 * deliberately no `keyFor(id)`.
 */

export interface ByokEndpoint {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  addedAt: number;
}

export interface ByokProviderRow {
  id: string;
  label: string;
  configured: boolean;
  kind: string;
  freeTier: { text: string };
}

export interface ByokModelOption {
  id: string;
  free: string;
}

export interface ByokCheck {
  ok: boolean;
  reason: string;
}

export interface ByokUrlCheck extends ByokCheck {
  url: string;
}

export interface ByokStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** The parts of bridge.ts this module is handed; never a key it can read. */
export interface ByokShell {
  secretSet?: (key: string, value: string) => Promise<void>;
  secretDelete?: (key: string) => Promise<void>;
  byokStream?: (
    args: { secret: string; base: string; body: string },
    onChunk: (text: string) => void,
    onStatus?: (status: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface ByokFrame {
  content?: string;
  done?: boolean;
  model?: string;
  toolCalls?: any[];
}

export declare const STORE_KEY: string;
export declare const CHANGED_EVENT: string;
export declare const PROVIDER_ID: string;
export declare const PROVIDER_LABEL: string;
export declare const SECRET_PREFIX: string;

export declare function secretName(id: string): string;
export declare function validateBaseUrl(raw: string): ByokUrlCheck;
export declare function validateKey(raw: string): ByokCheck;
export declare function chatUrl(baseUrl: string): string;
export declare function idFor(baseUrl: string, model: string, taken?: string[]): string;
export declare function list(storage?: ByokStore): ByokEndpoint[];
export declare function add(
  entry: { label?: string; baseUrl: string; model: string; addedAt?: number },
  storage?: ByokStore,
): { ok: boolean; entry: ByokEndpoint | null; reason: string };
export declare function find(id: string, storage?: ByokStore): ByokEndpoint | null;
export declare function findByModel(providerId: string, model: string, storage?: ByokStore): ByokEndpoint | null;
export declare function saveKey(id: string, key: string, shell?: ByokShell): Promise<ByokCheck>;
export declare function remove(id: string, shell?: ByokShell, storage?: ByokStore): Promise<ByokCheck>;
export declare function providerRow(storage?: ByokStore): ByokProviderRow | null;
export declare function modelsFor(providerId: string, storage?: ByokStore): ByokModelOption[];
export declare function explain(status: number, body?: string): string;
export declare function frameOf(payload: string): ByokFrame | null;
export declare function streamChat(
  entry: ByokEndpoint | null,
  messages: Array<{ role: string; content: any }>,
  onFrame: (frame: ByokFrame) => void,
  signal?: AbortSignal,
  shell?: ByokShell,
  tools?: any[],
): Promise<void>;
