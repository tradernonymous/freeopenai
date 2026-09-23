/**
 * The composer row's two decisions: how much the agent asks before it acts,
 * and which tool groups the next turn may use (UMD).
 *
 * A level is a pair of settings that already exist -- the approval mode in
 * `freeai4u.code_approval` and the Docker sandbox in `freeai4u.docker_sandbox`
 * -- so nothing here is a second opinion about either. See approval.js.
 */

import type { ApprovalMode, ProjectConfig } from './project-config';

export type LevelId = 'ask' | 'delegate' | 'sandbox' | 'full';

export interface Level {
  id: LevelId;
  label: string;
  /** The one line under the label: what will happen if this is chosen. */
  why: string;
  mode: ApprovalMode;
  /** Whether commands are wrapped in the Docker sandbox. */
  sandbox: boolean;
  /** 'high' for the level that has neither prompts nor a container. */
  risk: '' | 'high';
}

export type GroupId = 'search' | 'code' | 'mcp';

export interface Group {
  id: GroupId;
  label: string;
  hint: string;
}

export declare const KEY: string;
export declare const GROUPS_KEY: string;
/** Strictest first: the index is the strictness rank. */
export declare const LEVELS: Level[];
export declare const STRICTEST: LevelId;
export declare const GROUPS: Group[];

export declare function byId(id: string): Level | null;
export declare function rank(id: string): number;
export declare function levelFor(mode: string | null | undefined, sandboxOn: boolean): LevelId;
export declare function modeFor(id: string): ApprovalMode;
export declare function sandboxFor(id: string): boolean;
/** The level that applies once a folder's `.freeai4u.json` has had its say. */
export declare function effectiveLevel(id: string, projectConfig?: Partial<ProjectConfig> | null): LevelId;
/** The level in force, read from the settings themselves. */
export declare function current(storage?: any): LevelId;
/** Put a level in force; returns the level that is now in force. */
export declare function choose(id: string, storage?: any): LevelId;

export declare function groupIds(): GroupId[];
export declare function groupOf(name: string | null | undefined): GroupId | '';
export declare function readGroups(storage?: any): GroupId[];
export declare function saveGroups(ids: string[], storage?: any): GroupId[];
export declare function toggleGroup(ids: string[], id: string): GroupId[];
export declare function offered<T>(catalogue: T[], ids: string[]): T[];
