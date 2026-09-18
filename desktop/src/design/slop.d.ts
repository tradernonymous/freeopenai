/** The anti-slop linter (UMD, shared with node:test). */
export interface SlopFinding {
  id: string;
  label: string;
  why: string;
  fix: string;
}
export declare function lint(source: string): SlopFinding[];
export declare function score(source: string): { findings: SlopFinding[]; score: number };
export declare const RULES: Array<{
  id: string;
  label: string;
  why: string;
  fix: string;
  test: (src: string) => boolean;
}>;
