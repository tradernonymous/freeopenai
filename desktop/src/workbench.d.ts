import type { IconName } from './components/Icon';

/** One of the right rail's four tools. */
export type ToolId = 'design' | 'build' | 'files' | 'changes';

export interface WorkbenchTool {
  id: ToolId;
  label: string;
  icon: IconName;
  blurb: string;
}

export const LEFT_KEY: string;
export const RIGHT_KEY: string;
export const TOOL_KEY: string;
export const TOOLS: WorkbenchTool[];
export const DEFAULT_TOOL: ToolId;
export function toolIds(): ToolId[];
export function toolAt(id: string): WorkbenchTool | null;
export function cleanTool(value: unknown): ToolId;
export function readPinned(key: string, store?: Storage): boolean;
export function writePinned(key: string, value: boolean, store?: Storage): void;
export function readTool(store?: Storage): ToolId;
export function writeTool(id: string, store?: Storage): void;
export function pinnedAttr(pinned: boolean): 'true' | 'false';
export function closesOnEscape(pinned: boolean): boolean;
