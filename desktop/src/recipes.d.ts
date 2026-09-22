/** Recipes and automations (roadmap 6.8): saved prompts, their servers, schedules (UMD). */

export interface RecipeParam {
  name: string;
  label: string;
  default: string;
}

export interface Schedule {
  everyMinutes?: number;
  dailyAt?: string;
  /** Off keeps the schedule without running it. Default on. */
  enabled?: boolean;
}

export interface Recipe {
  id: string;
  name: string;
  systemPrompt: string;
  prompt: string;
  params: RecipeParam[];
  model?: { provider: string; model: string };
  /** MCP server names the recipe needs. */
  extensions: string[];
  responseSchema?: Record<string, any>;
  schedule?: Schedule;
}

export interface RunEntry {
  at: number;
  ok: boolean;
  error?: string;
  chatId?: string;
  baseline?: boolean;
}

export interface Checked {
  ok: boolean;
  errors: string[];
  warnings: string[];
  recipe: Recipe | null;
}

export declare const KEY: string;
export declare const RUNS_KEY: string;
export declare const CONSENT_KEY: string;
export declare const CHANGED_EVENT: string;
export declare const FIELDS: string[];
export declare function validate(raw: unknown): Checked;
export declare function list(storage?: any): Recipe[];
export declare function get(id: string, storage?: any): Recipe | null;
export declare function save(raw: unknown, storage?: any): Checked;
export declare function remove(id: string, storage?: any): boolean;
export declare function parseImport(text: string): { recipes: Recipe[]; errors: string[] };
export declare function exportJson(recipes: Recipe[]): string;
export declare function placeholders(prompt: string): string[];
export declare function fillTemplate(prompt: string, params: RecipeParam[], values?: Record<string, string>): { text: string; missing: string[] };
export declare function parseCommand(arg: string, params?: RecipeParam[]): { id: string; values: Record<string, string> };
export declare function nextRun(recipe: Recipe | null, lastRun: number | null | undefined, now: number): number | null;
export declare function isDue(recipe: Recipe | null, lastRun: number | null | undefined, now: number): boolean;
export declare function dueRecipes(recipes: Recipe[], runs: Record<string, RunEntry>, now: number): Recipe[];
export declare function lastRuns(storage?: any): Record<string, RunEntry>;
export declare function recordRun(id: string, entry: Partial<RunEntry>, storage?: any): boolean;
export declare function scheduleLabel(recipe: Recipe | null): string;
export declare function runTitle(recipe: Recipe | null, now: number): string;
export declare function hasConsent(recipeId: string, server: string, storage?: any): boolean;
export declare function grantConsent(recipeId: string, servers: string | string[], storage?: any): boolean;
export declare function needsConsent(recipe: Recipe | null, storage?: any): string[];
export interface BackgroundServers {
  /** Local servers to start now: consent given, not running. */
  start: string[];
  /** Usable as they are: remote, or already running. */
  ready: string[];
  /** Local servers with no consent from this recipe yet. */
  skipped: string[];
  /** Extensions not registered in Settings → Connectors. */
  missing: string[];
}
export declare function backgroundServers(
  recipe: Recipe,
  servers: Array<{ name: string; stdio: boolean; running: boolean }>,
  storage?: any,
): BackgroundServers;
export declare function backgroundRefusal(recipe: Recipe | null, call: { name: string; asks?: string; usable?: boolean }): string;
export declare function backgroundOffer<T extends { function: { name: string } }>(
  recipe: Recipe,
  defs: T[],
  asks: (name: string) => string,
  usableServers: string[],
): T[];
/** NEURA-036: what a background run does with a call. */
export interface BackgroundGate {
  action: 'run' | 'ask' | 'refuse';
  /** 'refuse': the tool result; 'ask': the refusal used if nobody answers in time. */
  text: string;
}
export declare function backgroundGate(
  recipe: Recipe | null,
  call: { name: string; asks?: string; usable?: boolean },
  storage?: any,
): BackgroundGate;
export declare const ALWAYS_KEY: string;
export declare const APPROVAL_TIMEOUT_MS: number;
export declare function recipeAllows(recipeId: string, tool: string, storage?: any): boolean;
export declare function allowForRecipe(recipeId: string, tool: string, storage?: any): boolean;
export declare function approvalText(recipeName: string, summary: string): string;
export type ApprovalDecision = 'once' | 'always' | 'deny' | 'timeout';
export interface PendingApproval {
  id: string;
  recipeId: string;
  recipeName: string;
  tool: string;
  summary: string;
  asks: string;
  at: number;
  expiresAt: number;
}
export interface ApprovalQueue {
  request(item: { recipeId: string; recipeName?: string; tool: string; summary?: string; asks?: string }): Promise<ApprovalDecision>;
  answer(id: string, decision: 'once' | 'always' | 'deny'): boolean;
  sweep(at?: number): number;
  pending(): PendingApproval[];
  subscribe(fn: (pending: PendingApproval[]) => void): () => void;
  timeoutMs: number;
}
export declare function approvalQueue(options?: {
  now?: () => number;
  timeoutMs?: number;
  setTimer?: ((fn: () => void, ms: number) => any) | null;
  clearTimer?: (handle: any) => void;
  storage?: any;
}): ApprovalQueue;
/** The app's one queue of paused background-run approvals. */
export declare const approvals: ApprovalQueue;
export declare function asAgent(recipe: Recipe): import('./agents.js').Agent;
export declare function template(): Partial<Recipe>;
