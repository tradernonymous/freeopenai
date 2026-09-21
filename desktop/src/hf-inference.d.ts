/**
 * HuggingFace Inference API as a chat provider.
 */

export interface HfModelOption {
  id: string;
  free: string;
}

export interface HfProviderRow {
  id: string;
  label: string;
  freeTier: { text: string };
}

export declare function providerRow(token: string | null): HfProviderRow | null;
export declare function models(token: string | null): HfModelOption[];
export declare function streamChat(
  model: string,
  messages: Array<{ role: string; content: string }>,
  onFrame: (frame: { content?: string; done?: boolean; model?: string }) => void,
  signal?: AbortSignal,
  token?: string,
): Promise<void>;
