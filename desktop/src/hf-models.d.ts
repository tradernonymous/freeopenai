/**
 * HuggingFace Model Browser: search, download, GGUF metadata.
 */

export interface HfModelCard {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  siblings?: Array<{ rfilename?: string; name?: string; size?: number; lfs?: { size?: number } }>;
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

/** What a download feeds, and where it lands (models.rs Kind). */
export type ModelKind = 'text' | 'image' | 'voice';

export interface HubFileSize {
  name: string;
  size: number;
}

/** One row to offer: a single file, or a component set fetched as one unit. */
export interface HubOfferRow {
  key: string;
  label: string;
  note: string;
  files: HubFileSize[];
  size: number;
  /** The folder a component set shares under sd-models; '' for one file. */
  set: string;
}

export interface HubOffer {
  rows: HubOfferRow[];
  diffusers: boolean;
  /** One plain sentence when the repo has nothing this tool can load. */
  message: string;
}

export interface FitNote {
  neededGb: number;
  fitsRam: boolean;
  fitsVram: boolean;
  text: string;
}

export declare const KINDS: Record<ModelKind, { extensions: string[]; folder: string }>;
export declare function kindRefusal(kind: ModelKind, name: string): string;
export declare function repoFiles(card: HfModelCard): HubFileSize[];
export declare function imageOffer(card: HfModelCard): HubOffer;
export declare function voiceOffer(card: HfModelCard): HubOffer;
export declare function fitNote(bytes: number, kind: ModelKind, spec: { ramGb?: number; vramGb?: number }): FitNote;
export declare function pastedFile(input: string): string;
