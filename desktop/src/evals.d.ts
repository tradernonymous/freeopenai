/** Evals: small tasks scored by code (UMD, shared with node:test). */
export interface EvalTask {
  id: string;
  title: string;
  skill: string;
  prompt: string;
  check: (reply: string) => { pass: boolean; note: string };
}
export interface EvalResult {
  target: { label: string; provider?: string; model?: string };
  taskId: string;
  pass: boolean;
  ms: number;
  chars: number;
  note?: string;
  error?: string;
}
export interface EvalSummary {
  target: EvalResult['target'];
  passed: number;
  total: number;
  errors: number;
  rate: number;
  avgMs: number;
  avgChars: number;
}
export declare const TASKS: EvalTask[];
export declare function byId(id: string): EvalTask | null;
export declare function answerOf(reply: string): string;
export declare function jsonOf(reply: string): any;
export declare function score(task: EvalTask, reply: string): { pass: boolean; note: string };
export declare function summarize(results: EvalResult[]): EvalSummary[];
export declare function toCsv(results: EvalResult[]): string;
