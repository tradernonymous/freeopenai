/** Carrying out a picture plan, shared by Images and Chat (UMD, shared with node:test). */
import type { ImageChoice } from './images.js';

export interface KeptChoice {
  choiceId: string;
  size: string;
  model: string;
  editModel: string;
}

export type ImagePlan =
  | { error: string; route?: undefined; model?: undefined; notes?: undefined; body?: undefined }
  | { error?: undefined; route: 'server' | 'browser' | 'local'; model: string; notes: string[]; body: any };

export interface LocalJob {
  id: string;
  label: string;
  since?: number;
}

export interface RunDeps {
  api: { imageGenerate: (body: any) => Promise<any>; imageEdit: (body: any) => Promise<any> };
  imageUrlFrom: (data: any) => string | null;
  puter: { isSignedIn: () => boolean; draw: (prompt: string, options?: any) => Promise<string> };
  call: <T = any>(command: string, args?: Record<string, unknown>) => Promise<T>;
  /** Read before every poll of a local job: true stops it. */
  stopped?: () => boolean;
  /** A local job's progress line; null when it is over. */
  onJob?: (job: LocalJob | null) => void;
  /** sd-server's own status, after a start and after a job. */
  onServer?: (status: any) => void;
  wait?: (ms: number) => Promise<unknown>;
}

export interface ImageResult {
  url: string;
  who: string;
  notes: string[];
}

export interface ImageFailure {
  summary: string;
  upstream: string;
  walk: string;
  advice: string;
  message: string;
}

export declare const CHOICE_KEY: string;
export declare const HANDOFF_EVENT: string;
export declare function readChoice(storage?: Pick<Storage, 'getItem'> | null): KeptChoice;
export declare function writeChoice(patch: Partial<KeptChoice>, storage?: Pick<Storage, 'getItem' | 'setItem'> | null): KeptChoice;
export declare function modelFor(choice: Partial<ImageChoice> | null, kind: 'generate' | 'edit', kept?: Partial<KeptChoice>): string;
export declare function drawPlan(choice: Partial<ImageChoice> | null, request: { prompt: string; size?: string; model?: string }): ImagePlan;
export declare function withSeed(plan: ImagePlan, seed?: number): ImagePlan;
export declare function runLocal(body: any, deps: RunDeps): Promise<string>;
export declare function runImage(kind: 'generate' | 'edit', choice: Partial<ImageChoice> | null, plan: ImagePlan, deps: RunDeps): Promise<ImageResult | null>;
export declare function failureView(kind: 'generate' | 'edit', route: string | undefined, choice: Partial<ImageChoice> | null, error: unknown): ImageFailure;
export declare function costNote(choice: Partial<ImageChoice> | null): string;
export declare function savePicture(url: string, doc?: Document): boolean;
export declare function measurePicture(url: string, ImageCtor?: any): Promise<{ width: number; height: number }>;
export declare function handOff(url: string, announce?: (event: string) => void): boolean;
export declare function takeHandoff(): string | null;
