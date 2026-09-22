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

// ---- history and schedule ----
export interface EvalTarget {
  provider: string;
  model: string;
  label: string;
}
export interface EvalRunRow {
  taskId: string;
  targetKey: string;
  pass: boolean;
  ms: number;
  chars: number;
  note: string;
  error?: boolean;
}
export interface EvalRunSummary {
  key: string;
  label: string;
  passed: number;
  total: number;
  errors: number;
  rate: number;
  avgMs: number;
}
export interface EvalRun {
  id: string;
  at: number;
  trigger: 'manual' | 'schedule';
  targets: EvalTarget[];
  rows: EvalRunRow[];
  summary: EvalRunSummary[];
}
export interface EvalComparison {
  key: string;
  label: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  beforePassed: number;
  afterPassed: number;
  total: number;
  newlyFailing: string[];
  slower: number | null;
  beforeMs?: number;
  afterMs?: number;
  unreachable: boolean;
}
export interface EvalRegression extends EvalComparison {
  reasons: Array<'rate' | 'slower'>;
}
export interface EvalSchedule {
  enabled: boolean;
  everyHours?: number;
  dailyAt?: string;
  targets: EvalTarget[];
  lastRunAt: number;
}
type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void } | null | undefined;
export declare const HISTORY_KEY: string;
export declare const SCHEDULE_KEY: string;
export declare const HISTORY_CAP: number;
export declare const HISTORY_EVENT: string;
export declare function targetKey(target: { provider?: string; model?: string; label?: string } | null | undefined): string;
export declare function makeRun(results: EvalResult[], opts?: { at?: number; trigger?: 'manual' | 'schedule'; targets?: EvalTarget[] }): EvalRun;
export declare function readHistory(storage?: StorageLike): EvalRun[];
export declare function appendRun(run: EvalRun, storage?: StorageLike, cap?: number): EvalRun[];
export declare function clearHistory(storage?: StorageLike): boolean;
export declare function exportHistory(runs: EvalRun[]): string;
export declare function compareRuns(previous: EvalRun | null | undefined, current: EvalRun): EvalComparison[];
export declare function compareToHistory(history: EvalRun[], current: EvalRun): EvalComparison[];
export declare function regressions(comparison: EvalComparison[], opts?: { dropAtLeast?: number; slowerBy?: number; minMs?: number }): EvalRegression[];
export declare function regressionMessage(r: EvalRegression): string;
export declare function series(history: EvalRun[], key: string): Array<{ at: number; rate: number; passed: number; total: number }>;
export declare function trend(points: Array<{ rate: number }>): 'up' | 'down' | 'flat';
export declare function normalizeSchedule(raw: unknown): EvalSchedule;
export declare function readSchedule(storage?: StorageLike): EvalSchedule;
export declare function writeSchedule(schedule: Partial<EvalSchedule>, storage?: StorageLike): EvalSchedule | null;
export declare function nextEvalRun(schedule: Partial<EvalSchedule> | null | undefined, lastRunAt: number | null | undefined, now: number): number | null;
export declare function scheduleLabel(schedule: Partial<EvalSchedule> | null | undefined): string;
