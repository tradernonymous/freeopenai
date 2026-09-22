/** Research mode (/research): plan, sources, citations, graph, export (UMD, shared with node:test). */
export interface ChatTurn {
  role: string;
  content: string;
}

export interface SearchRow {
  title: string;
  url: string;
  snippet: string;
}

export interface ResearchSource extends SearchRow {
  /** The number the answer cites it by, 1..n. */
  n: number;
  /** Which planned query found it, and at what rank among that query's new results. */
  query?: number;
  rank?: number;
}

export interface CitationCheck {
  text: string;
  cited: number[];
  unknown: number[];
  uncited: Array<{ index: number; text: string }>;
}

export interface ResearchGraph {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
  trimmed: boolean;
  message: string;
}

export interface ExportOptions {
  question: string;
  answer: string;
  sources: ResearchSource[];
  date?: number | string | Date;
  model?: string;
}

export interface PrintOptions {
  question: string;
  bodyHtml: string;
  sources: ResearchSource[];
  date?: number | string | Date;
  model?: string;
  graphSvg?: string;
  autoPrint?: boolean;
}

export type ResearchStage = 'plan' | 'search' | 'read' | 'write' | 'done';

export declare const MIN_QUERIES: number;
export declare const MAX_QUERIES: number;
export declare const RESULTS_PER_QUERY: number;
export declare const MAX_SOURCES: number;
export declare const MAX_PAGES: number;
export declare const PAGE_CHARS: number;
export declare const TOTAL_CHARS: number;
export declare const MAX_GRAPH_NODES: number;
export declare const NO_SOURCES_LABEL: string;
export declare function formatDate(date?: number | string | Date): string;
export declare function extractJson(reply: string): any;
export declare function planMessages(question: string, date?: number | string | Date): ChatTurn[];
export declare function parseQueries(reply: string, question: string): string[];
export declare function normalizeUrl(url: string): string;
export declare function parseSearchResults(output: string): SearchRow[];
export declare function addSources(sources: ResearchSource[], results: SearchRow[], query?: number): ResearchSource[];
export declare function pickPages(sources: ResearchSource[], max?: number): ResearchSource[];
export declare function clipPage(text: string, limit?: number): string;
export declare function sourcesForPrompt(sources: ResearchSource[], pages?: Record<number, string>, total?: number): string;
export declare function synthesisMessages(question: string, sources: ResearchSource[], pages?: Record<number, string>, date?: number | string | Date): ChatTurn[];
export declare function noSourcesMessages(question: string, date?: number | string | Date): ChatTurn[];
export declare function checkCitations(answer: string, count: number): CitationCheck;
export declare function linkCitations(answer: string, sources: ResearchSource[]): string;
export declare function superscriptCitations(html: string): string;
export declare function graphMessages(question: string, answer: string): ChatTurn[];
export declare function parseGraph(reply: string): ResearchGraph;
export declare function exportMarkdown(opts: ExportOptions): string;
export declare function printHtml(opts: PrintOptions): string;
export declare function progressText(stage: ResearchStage, info?: { queries?: number; sources?: number; pages?: number }): string;
