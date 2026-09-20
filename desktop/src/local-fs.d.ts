/**
 * The local folder's rules, mirrored from src-tauri/src/local.rs.
 *
 * test/desktop-local.test.js asserts these lists are identical to the Rust
 * ones, so the two surfaces cannot disagree about what is protected or what
 * needs approval.
 */

/** Never written, whatever the caller asks for. */
export declare const PROTECTED_DIRS: string[];
/** Never written, except the template everyone commits. */
export declare const PROTECTED_FILES: string[];
/** Commands that are destructive by nature: [substring, why]. */
export declare const RISKY: Array<[string, string]>;

export declare function isDriveAbsolute(value: string): boolean;
/** `rel` joined under `root`, or null when it would leave the folder. */
export declare function joinInside(root: string, rel: string): string | null;
/** `absolute` expressed relative to `root`; '' is the root itself. */
export declare function relativeWithin(root: string, absolute: string): string;
/** The refusal message for a write to `rel`; '' means it is writable. */
export declare function protectedPath(rel: string): string;
/** Why `command` needs approval, or null when it is ordinary. */
export declare function riskOf(command: string): string | null;

export interface CdResult {
  handled: boolean;
  /** The new working folder, relative to the root; '' is the root. */
  cwd: string;
  /** The part after `&&`, which the caller should run with the new cwd. */
  run?: string | null;
  out?: string;
  err?: string;
}

/** What `cd` (with or without `&& rest`) means here; `pwd` is handled too. */
export declare function applyCd(root: string, cwd: string, command: string): CdResult;

export type LocalFileKind = 'folder' | 'code' | 'image' | 'data' | 'doc' | 'unknown';

export interface LocalEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  ext: string;
}

export declare function kindOf(entry: Partial<LocalEntry>): LocalFileKind;
export declare function formatBytes(bytes: number): string;
export declare function rootLabel(path: string): string;
export declare function parentOf(path: string): string;
