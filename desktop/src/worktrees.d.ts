export interface WorktreeRow {
  task: string;
  slug: string;
  branch: string;
  /** Relative to the open folder: .neuraos/worktrees/<slug>. */
  dir: string;
}

export const BASE: string;
export const BRANCH_PREFIX: string;
export const MAX_AGENTS: number;
export function slug(text: string, n: string | number): string;
export function plan(tasks: string[], stamp?: string): WorktreeRow[];
export function tasksFrom(text: string): string[];
export function addCommand(row: WorktreeRow): string;
export function statCommand(): string;
export function commitCommand(row: WorktreeRow): string;
export function mergeCommand(row: WorktreeRow): string;
export function discardCommands(row: WorktreeRow): string[];
export function elapsed(ms: number): string;
export function absolute(rootPath: string, dir: string): string;
