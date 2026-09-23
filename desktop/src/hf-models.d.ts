/**
 * HuggingFace Model Browser: search, download, GGUF metadata.
 */

export interface HfModelCard {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  siblings?: Array<{ rfilename?: string; name?: string; size?: number }>;
  cardData?: { license?: string };
  license?: string;
  gated?: boolean | string;
}

export interface GgufFile {
  name: string;
  size: number;
  quant: string;
  fitsRam: string;
  url: string;
}

export declare const HF_API: string;
export declare function searchModels(query: string, opts?: {
  limit?: number;
  sort?: string;
  direction?: string;
  filter?: string;
  authHeaders?: Record<string, string>;
}): Promise<HfModelCard[]>;
export declare function getModel(modelId: string, opts?: {
  authHeaders?: Record<string, string>;
}): Promise<HfModelCard>;
export declare function ggufFiles(card: HfModelCard): GgufFile[];
export declare function parseQuant(filename: string): string;
export declare function estimateFitsRam(sizeBytes: number, quant: string): string;
export declare function fileUrl(modelId: string, filename: string): string;
export declare function formatSize(bytes: number): string;
export declare function licenseShort(card: HfModelCard): string;
export declare function isGated(card: HfModelCard): boolean;
