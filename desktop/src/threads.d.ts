export interface ThreadMeta {
  pinned: string[];
  folders: Record<string, string>;
}

export interface ThreadLike {
  id: string;
  title?: string;
  updatedAt?: number;
  messages?: Array<{ role?: string; content?: string; note?: boolean }>;
}

export interface ThreadSection<T extends ThreadLike = ThreadLike> {
  key: string;
  title: string;
  items: T[];
}

export const META_KEY: string;
export const CHANGED_EVENT: string;
export const ACTIVITY_EVENT: string;
export function autoTitle(text: string): string;
export function cleanMeta(value: unknown): ThreadMeta;
export function readMeta(store?: Storage): ThreadMeta;
export function writeMeta(meta: ThreadMeta, store?: Storage): void;
export function togglePin(meta: ThreadMeta, id: string): ThreadMeta;
export function setFolder(meta: ThreadMeta, id: string, name: string): ThreadMeta;
export function folderNames(meta: ThreadMeta): string[];
export function sections<T extends ThreadLike>(sessions: T[], meta: ThreadMeta, query?: string): Array<ThreadSection<T>>;
export function preview(session: ThreadLike, max?: number): string;
