/** A local model's own GGUF chat template, rendered under caps (UMD). */

export interface TemplateLimits {
  /** Longest template source that is rendered at all. */
  template: number;
  /** Most turns in one render. */
  messages: number;
  /** Most characters of message text going in. */
  input: number;
  /** Most characters of prompt coming out. */
  output: number;
  /** Largest constant a template may hand `range()`. */
  range: number;
}

/** A render: `reason` is empty on success, and otherwise says why to fall back. */
export interface RenderedPrompt {
  prompt: string;
  reason: string;
}

export interface RenderOptions {
  /** Default true: end the prompt at the point the model answers from. */
  addGenerationPrompt?: boolean;
  /** Tool definitions (OpenAI shape) for a template that writes them in. */
  tools?: unknown[];
  /** Lower the output cap for this render (never above LIMITS.output). */
  maxOutput?: number;
}

export declare const LIMITS: TemplateLimits;
export declare const CACHE_KEY: string;

/** Hand in the `Template` class from `@huggingface/jinja`; true once set. */
export declare function setEngine(template: unknown): boolean;

/** The template a `gguf_info` answer carries, or '' when the file has none. */
export declare function templateOf(info: unknown): string;

/** Render, or say why the generic path should be used instead. Never throws. */
export declare function render(
  template: string,
  messages: Array<{ role: string; content: any }>,
  options?: RenderOptions,
): RenderedPrompt;

/** The template remembered for a model: '' for "none", null for "not asked yet". */
export declare function cached(modelId: string, storage?: any): string | null;
export declare function remember(modelId: string, template: string, storage?: any): boolean;
export declare function forget(modelId: string, storage?: any): boolean;
