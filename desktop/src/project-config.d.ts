/**
 * Per-project configuration read from `.freeai4u.json` in an opened folder.
 *
 * The file is untrusted input that arrives with a repository, so everything it
 * asks for is merged against the person's own settings and can only narrow
 * them -- see the note at the top of project-config.js.
 */

export type ApprovalMode = 'never' | 'commands' | 'always';

export interface ProjectModel {
  provider: string;
  model: string;
}

/** What the file asked for. `null` on a field means the file did not set it. */
export interface ProjectConfig {
  model: ProjectModel | null;
  approvalMode: ApprovalMode | null;
  allowedCommands: string[] | null;
  systemPrompt: string;
}

/** The person's own settings, the ceiling a project file cannot rise above. */
export interface GlobalSettings {
  approvalMode: ApprovalMode;
  allowedCommands: string[];
}

/** What the agent actually runs with: the merge of the two. */
export interface EffectiveConfig {
  model: ProjectModel | null;
  approvalMode: ApprovalMode;
  allowedCommands: string[];
  systemPrompt: string;
}

export interface ParsedConfig {
  /** False only for an absent or empty file. */
  present: boolean;
  config: ProjectConfig;
  /** One readable sentence per ignored field; empty when the file was clean. */
  problems: string[];
}

export interface LoadedConfig extends ParsedConfig {
  effective: EffectiveConfig;
}

export declare const FILENAME: string;
export declare const MODES: ApprovalMode[];
export declare const FIELDS: string[];
export declare const DEFAULT_GLOBAL: GlobalSettings;
export declare const MAX_PROMPT: number;
export declare const MAX_COMMANDS: number;

export declare function parse(text: string | null | undefined): ParsedConfig;
export declare function merge(global: Partial<GlobalSettings> | null | undefined, config: Partial<ProjectConfig> | null | undefined): EffectiveConfig;
export declare function defaults(global?: Partial<GlobalSettings> | null): EffectiveConfig;
export declare function globalSettings(given?: Partial<GlobalSettings> | null): GlobalSettings;
/** The stricter of two approval modes. */
export declare function stricter(a: string, b: string): ApprovalMode;
export declare function normalizeCommand(value: unknown): string;
export declare function commandAllowed(effective: EffectiveConfig | null | undefined, command: unknown): boolean;
/** The agent's gate; true (ask) whenever the settings are missing or unknown. */
export declare function needsApproval(effective: EffectiveConfig | null | undefined, tool: string, args?: Record<string, unknown>): boolean;
/** The project's paragraph, labelled as the project's rather than the app's. */
export declare function promptBlock(systemPrompt?: string): string;
/** Short lines naming what this folder overrides, for the Code screen. */
export declare function describe(effective: EffectiveConfig | null | undefined, global?: Partial<GlobalSettings> | null): string[];
export declare function read(readText: (path: string) => Promise<string | { text: string }>, global?: Partial<GlobalSettings> | null): Promise<LoadedConfig>;
