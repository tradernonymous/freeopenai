/** The command palette registry and query rules (UMD, shared with node:test). */
export interface CommandEntry {
  id: string;
  group: string;
  title: string;
  hint?: string;
  keys?: string;
  /** A screen to open. */
  palette?: string;
  /** A stored chat id to open. */
  chat?: string;
  /** A skill id to show. */
  skill?: string;
}
export declare const COMMANDS: CommandEntry[];
export declare const MAX_RESULTS: number;
export declare function score(command: CommandEntry, query: string): number;
export declare function search(
  query: string,
  options?: { limit?: number; extra?: CommandEntry[]; keys?: Record<string, string> },
): CommandEntry[];
export declare function chatCommand(session: { id: string; title?: string }): CommandEntry;
export declare function skillCommand(skill: { id?: string; name?: string }): CommandEntry;
