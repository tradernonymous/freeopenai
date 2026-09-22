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
export declare function asAgent(recipe: Recipe): import('./agents.js').Agent;
export declare function template(): Partial<Recipe>;
