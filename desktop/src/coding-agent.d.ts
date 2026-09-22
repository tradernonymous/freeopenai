/**
 * Local coding agent: plan-approve-edit-run loop.
 */

import type { EffectiveConfig } from './project-config';

export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  params: ToolParam[];
  mutating?: boolean;
}

export interface AgentStep {
  id: number;
  title: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  tool: string;
  args: Record<string, unknown>;
  result: string | null;
  diff: string | null;
}

export interface AgentApproval {
  id: string;
  stepId: number;
  tool: string;
  args: Record<string, unknown>;
  diff: string | null;
  command: string | null;
}

export interface AgentSession {
  id: string;
  root: string;
  model: string;
  provider: string;
  /** The folder's effective settings; null means every mutation is approval-gated. */
  config: EffectiveConfig | null;
  status: 'idle' | 'planning' | 'running' | 'awaiting' | 'done' | 'error' | 'stopped';
  plan: AgentStep[];
  messages: Array<{ role: string; content: string }>;
  pendingApproval: AgentApproval | null;
  toolCalls: number;
  rounds: number;
  error: string | null;
  startedAt: number | null;
  updatedAt: number | null;
}

export interface AgentCallbacks {
  sendMessage: (messages: Array<{ role: string; content: string }>, model: string, provider: string) => Promise<string>;
  readFile?: (root: string, path: string) => Promise<{ text: string; binary: boolean; bytes: number } | string>;
  writeFile?: (root: string, path: string, content: string) => Promise<{ path: string; bytes: number }>;
  editFile?: (root: string, path: string, oldText: string, newText: string) => Promise<{ path: string; replaced: number; bytes: number }>;
  runCmd?: (root: string, command: string, cwd?: string) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
  listFiles?: (root: string, path: string) => Promise<{ entries: Array<{ name: string; dir: boolean; size: number }> }>;
  onEvent?: (event: { type: string; [k: string]: unknown }) => void;
  onDecision?: (approvalId: string, resolve: (decision: { approved: boolean; cancelled?: boolean; reason?: string }) => void) => void;
}

export declare const TOOLS: ToolDef[];
export declare const MAX_ROUNDS: number;
export declare const MAX_TOOL_CALLS: number;
/** `projectPrompt` is the already-labelled block from project-config.promptBlock. */
export declare function systemPrompt(projectNotes?: string, projectPrompt?: string): string;
export declare function parseToolCall(text: string): { name: string; args: Record<string, unknown> } | null;
export declare function createSession(root: string, model?: string, provider?: string): AgentSession;
export declare function readProjectNotes(readFile: (path: string) => Promise<string>): Promise<string>;
export declare function computeDiff(oldText: string, newText: string): string;
export declare function runAgent(session: AgentSession, callbacks: AgentCallbacks): Promise<AgentSession>;
export declare function summarizeArgs(args: Record<string, unknown>): string;
