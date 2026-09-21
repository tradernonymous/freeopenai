/**
 * Hugging Face Inference Providers (the router) as a chat provider.
 */

export interface HfModelOption {
  id: string;
  free: string;
}

export interface HfProviderRow {
  id: string;
  label: string;
  configured: boolean;
  freeTier: { text: string };
}

export declare const API_BASE: string;
export declare const DEFAULT_SUFFIX: string;
export declare const FREE_MODELS: HfModelOption[];
export declare function providerRow(token: string | null): HfProviderRow;
export declare function models(token: string | null): HfModelOption[];
export declare function fetchModels(token: string | null, fetchImpl?: typeof fetch): Promise<HfModelOption[]>;
export declare function chatUrl(): string;
export declare function modelId(model: string): string;
export declare function explain(status: number, body?: string): string;
export declare function streamChat(
  model: string,
  messages: Array<{ role: string; content: any }>,
  onFrame: (frame: { content?: string; done?: boolean; model?: string; toolCalls?: any[] }) => void,
  signal?: AbortSignal,
  token?: string,
  tools?: any[],
): Promise<void>;
