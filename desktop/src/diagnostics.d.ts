/** The diagnostics report formatter (UMD, shared with node:test). */
export interface ShellFacts {
  version?: string;
  os?: string;
  arch?: string;
  webview2?: string;
  log_path?: string;
  log_bytes?: number;
  log_tail?: string;
  data_dir?: string;
  cache_dir?: string;
}
export interface ClientFacts {
  version?: string;
  engine?: string;
  state?: string;
  account?: string;
  hasShell?: boolean;
  backends?: string[];
}
export declare function buildReport(input: {
  shell?: ShellFacts;
  client?: ClientFacts;
}): string;
export declare function redact(text: unknown): string;
export declare function redactUrl(value: unknown): string;
export declare function bytesLabel(bytes: number): string;
