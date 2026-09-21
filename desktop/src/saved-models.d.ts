/** My models: the local models kept in the pickers (UMD). */

export type SavedKind = 'ollama' | 'unsloth';

export interface SavedModel {
  id: string;
  kind: SavedKind;
  /** Ollama's name (`deepseek-r1:latest`), or the GGUF file name without `.gguf`. */
  name: string;
  /** Absolute path of the GGUF; empty for Ollama. */
  path: string;
  /** Ollama's address; empty for a file. */
  base: string;
  bytes: number;
  detail: string;
  addedAt: number;
}

export interface SavedProviderRow {
  id: string;
  label: string;
  configured: boolean;
  kind: string;
  local: boolean;
  freeTier: { text: string };
}

export declare const STORE_KEY: string;
export declare const FOLDERS_KEY: string;
export declare const CHANGED_EVENT: string;
export declare const OLLAMA_BASE: string;
export declare const PROVIDERS: Record<SavedKind, { id: string; label: string; note: string }>;
export declare function kindOf(providerId: string): SavedKind | '';
export declare function isSavedProvider(providerId: string): boolean;
export declare function nameFromPath(path: string): string;
export declare function idFor(kind: SavedKind, nameOrPath: string): string;
export declare function list(storage?: any): SavedModel[];
export declare function add(
  entry: { kind: SavedKind; name?: string; path?: string; base?: string; bytes?: number; detail?: string },
  storage?: any,
): { ok: boolean; added: boolean; entry: SavedModel | null; reason: string };
export declare function remove(id: string, storage?: any): boolean;
export declare function has(id: string, storage?: any): boolean;
export declare function providerRows(storage?: any): SavedProviderRow[];
export declare function modelsFor(providerId: string, storage?: any): Array<{ id: string; free: string }>;
export declare function find(providerId: string, modelName: string, storage?: any): SavedModel | null;
export declare function fromOllamaTags(body: any): Array<{ name: string; bytes: number; detail: string }>;
export declare function folders(storage?: any): { ollama: string; unsloth: string };
export declare function setFolder(kind: SavedKind, value: string, storage?: any): boolean;
