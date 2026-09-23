/** The viralai mockup generator, ported (NEURA-070) -- see mockups.js for what transfers and what changed. */
export interface MockupLimits {
  /** Characters of copy per slide. */
  text: number;
  /** Wrapped lines kept on the card; the rest is elided. */
  lines: number;
  /** Slides in one carousel. */
  slides: number;
}

export interface MockupSpec {
  text?: string;
  width?: number;
  height?: number;
  paper?: string;
  ink?: string;
  accent?: string;
}

export interface PlanLine {
  text: string;
  x: number;
  y: number;
}

export interface Plan {
  width: number;
  height: number;
  paper: string;
  ink: string;
  accent: string;
  bar: number;
  margin: number;
  font: { size: number; weight: string; family: string };
  lineHeight: number;
  lines: PlanLine[];
}

export type Measure = (text: string, size: number, weight: string) => number;

export declare const LIMITS: MockupLimits;
export declare const BASE: {
  width: number;
  height: number;
  paper: string;
  ink: string;
  bar: number;
  margin: number;
  size: number;
  lineHeight: number;
  weight: string;
  family: string;
};

export declare function hash32(text: string): number;
export declare function accentFor(text: string): string;
export declare function wrap(text: string, maxWidth: number, widthOf: (line: string) => number): string[];
export declare function plan(spec: MockupSpec, measure: Measure): Plan;
export declare function carousel(texts: string[], spec: MockupSpec, measure: Measure): Plan[];
/** Paints with CanvasRenderingContext2D's shape; typed loosely so the module stays DOM-free. */
export declare function paint(ctx: any, plan: Plan): void;
