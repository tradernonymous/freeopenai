/** The engine run-result formatter (UMD, shared with node:test). */
export interface RunFormatted {
  out: string;
  kind: 'out' | 'err';
}
export declare function formatRun(result: any): RunFormatted;
