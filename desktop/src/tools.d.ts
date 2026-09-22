/** Tools: what a model in Chat may ask for, and the rules around asking (UMD). */

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, any> };
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text, as the model wrote it. */
  arguments: string;
}

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, any> };

/** Remote: `{ name, url }` (https, through the engine). Local: `{ name, transport: 'stdio', command, args, env, cwd? }`. */
export interface McpServer {
  name: string;
  url?: string;
  transport?: 'stdio';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  tools: McpTool[];
}

export interface StdioServerInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  tools?: McpTool[];
}

export declare const MCP_KEY: string;
export declare const ON_KEY: string;
export declare const ALWAYS_KEY: string;
export declare const CHANGED_EVENT: string;
export declare const MAX_ROUNDS: number;
export declare const MAX_RESULT_CHARS: number;
export declare const WEB: ToolDef[];
export declare const GITHUB: ToolDef[];
export declare const LOCAL: ToolDef[];
export declare const ASKS: Record<string, string>;
export declare function slug(name: string): string;
export declare function mcpServers(storage?: any): McpServer[];
export declare function saveMcpServers(list: McpServer[], storage?: any): boolean;
export declare function addMcpServer(name: string, url: string, tools?: McpServer['tools'], storage?: any): { ok: boolean; reason: string };
export declare function addStdioServer(row: StdioServerInput, storage?: any): { ok: boolean; reason: string };
export declare function setMcpTools(name: string, tools: McpTool[], storage?: any): boolean;
export declare function removeMcpServer(name: string, storage?: any): boolean;
export declare function isStdio(server: McpServer | null | undefined): boolean;
export declare function validateStdioServer(row: Partial<StdioServerInput> | null | undefined): { ok: boolean; reason: string; server: McpServer | null };
export declare function splitArgs(line: string): string[];
export declare function joinArgs(list: string[]): string;
export declare function parseEnvLines(text: string): { env: Record<string, string>; bad: string[] };
export declare function parseMcpConfig(text: string): { servers: McpServer[]; errors: string[] };
export declare function mcpResultText(result: any): string;
export declare function splitStderr(message: string): { message: string; stderr: string };
export declare function mcpToolName(server: string, tool: string): string;
export declare function mcpTarget(name: string, storage?: any): { server: McpServer; tool: string } | null;
export declare function mcpDefs(storage?: any): ToolDef[];
export declare function catalogue(context: { github?: boolean; localRoot?: string; shell?: boolean }, storage?: any): ToolDef[];
export declare function enabled(storage?: any): boolean;
export declare function setEnabled(on: boolean, storage?: any): boolean;
export declare function alwaysKey(name: string): string;
export declare function setAlways(name: string, storage?: any): boolean;
export declare function needsApproval(name: string, storage?: any): string;
export declare function collect(state: any[] | null, deltas: any[] | undefined): any[];
export declare function finish(state: any[] | null): ToolCall[];
export declare function parseArgs(text: string | Record<string, any>): Record<string, any>;
export declare function assistantMessage(text: string, calls: ToolCall[]): { role: 'assistant'; content: string; tool_calls: any[] };
export declare function toolMessage(call: ToolCall, result: string): { role: 'tool'; tool_call_id: string; name: string; content: string };
export declare function clip(text: string): string;
export declare function summarise(name: string, args: Record<string, any>): string;
export declare function isToolsRefusal(message: string): boolean;
