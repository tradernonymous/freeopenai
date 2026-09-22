/** Declarative agent definitions (roadmap 6.7): data only, never code (UMD). */

export type OutputMode = 'last_message' | 'structured';

export interface Agent {
  id: string;
  name: string;
  description: string;
  model?: { provider: string; model: string };
  systemPrompt: string;
  /** Built-in tool names, or `server/tool` / `server/*` for MCP tools. */
  toolNames: string[];
  spawnableAgents?: string[];
  outputMode: OutputMode;
  outputSchema?: Record<string, any>;
  includeMessageHistory: boolean;
  spawnerPrompt?: string;
}

export interface Checked {
  ok: boolean;
  errors: string[];
  warnings: string[];
  agent: Agent | null;
}

type ToolDef = import('./tools.js').ToolDef;

export declare const KEY: string;
export declare const CHANGED_EVENT: string;
export declare const MAX_DEPTH: number;
export declare const OUTPUT_MODES: OutputMode[];
export declare const FIELDS: string[];
export declare const CODE_FIELDS: string[];
export declare const CREDENTIALS_RULE: string;
export declare const BUILTINS: Array<Partial<Agent>>;
export declare function codeReason(raw: unknown): string;
export declare function validate(raw: unknown): Checked;
export declare function toolName(entry: string): string;
export declare function allowsTool(toolNames: string[], defName: string): boolean;
export declare function pickTools(agent: Agent | null, defs: ToolDef[]): ToolDef[];
export declare function list(storage?: any): Agent[];
export declare function get(id: string, storage?: any): Agent | null;
export declare function save(raw: unknown, storage?: any): Checked;
export declare function remove(id: string, storage?: any): boolean;
export declare function isBuiltin(id: string): boolean;
export declare function isOverridden(id: string, storage?: any): boolean;
export declare function parseImport(text: string): { agents: Agent[]; errors: string[] };
export declare function exportJson(agents: Agent[]): string;
export declare function parseCommand(arg: string): { id: string; task: string };
export declare function messagesFor(agent: Agent, task: string, history?: Array<{ role: string; content: any }>): Array<{ role: string; content: any }>;
export declare function spawnTargets(spawner: Agent | null, all: Agent[]): string[];
export declare function spawnDescription(agents: Agent[]): string;
export declare function extractJson(text: string): { ok: boolean; value: any };
export declare function checkStructured(text: string, schema: Record<string, any> | undefined): { ok: boolean; value: any; errors: string[] };
export declare function formatResult(agent: Agent | null, lastMessage: string): { text: string; ok: boolean; errors: string[] };
export declare function template(): Partial<Agent>;
