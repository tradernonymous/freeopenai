/** The anti-slop linter (UMD, shared with node:test). */
export interface SlopFinding {
  id: string;
  label: string;
  why: string;
  fix: string;
  /** Where, when the rule can say: a selector and ratio, a font name. */
  detail?: string;
}
export declare function lint(source: string): SlopFinding[];
export declare function score(source: string): { findings: SlopFinding[]; score: number };
export declare function contrastFailures(css: string): Array<{ where: string; ratio: number }>;
export declare function hexOf(raw: string): string | null;
export declare const BANNED_DISPLAY: string[];
export declare const RULES: Array<{
  id: string;
  label: string;
  why: string;
  fix: string;
  test: (src: string) => boolean | string;
}>;
