/**
 * HuggingFace Skills knowledge pack: load SKILL.md from HF repos, and install
 * one into the open folder (NEURA-053).
 */

export interface HfSkill {
  name: string;
  description: string;
  tags: string[];
  /** Extra files the skill ships, from its `files:` frontmatter. */
  files?: string[];
  content: string;
  repo?: string;
  path?: string;
}

/** Where an installed skill lands, relative to the open folder. */
export declare const SKILLS_DIR: string;

/** The ceilings an install refuses to cross. */
export declare const LIMITS: {
  files: number;
  fileBytes: number;
  totalBytes: number;
};

export declare function parseSkillMd(text: string): HfSkill | null;
export declare function loadCatalog(token?: string): Promise<HfSkill[]>;

/** The single path segment a skill installs into; '' when the name is unusable. */
export declare function skillSlug(name: string): string;

export interface PlannedFile {
  /** The file's path inside the HF repo. */
  repoPath: string;
  /** Its path inside the skill's own folder. */
  name: string;
  /** Where it lands, relative to the open folder. */
  target: string;
}

export interface InstallPlan {
  slug?: string;
  dir?: string;
  files?: PlannedFile[];
  /** Set instead of the rest when the entry will not be installed, and why. */
  error?: string;
}

/** What installing `skill` would write — decided before anything is fetched. */
export declare function planInstall(skill: Partial<HfSkill>): InstallPlan;

export interface InstallProgress {
  phase: 'fetch' | 'write' | 'done';
  file: string;
  index: number;
  total: number;
}

export interface InstallOptions {
  /** HF access token; sent as a header, never written to disk. */
  token?: string;
  /** Stand-in for fetch — tests only. */
  fetchImpl?: typeof fetch;
  /** The only way out to disk: (relativePath, text) => Promise. */
  writeFile: (path: string, text: string) => Promise<unknown>;
  onProgress?: (progress: InstallProgress) => void;
}

export interface InstallResult {
  dir: string;
  files: string[];
  bytes: number;
}

/** Fetch a catalogue entry's files and write them. Rejects with the reason. */
export declare function installSkill(
  skill: Partial<HfSkill>,
  opts: InstallOptions,
): Promise<InstallResult>;

export interface InstalledRecord {
  name: string;
  repo: string;
  dir: string;
  stamp: string;
  at: number;
}

export type InstalledRecords = Record<string, InstalledRecord>;

/** Minimal storage shape, so a test can pass a stand-in for localStorage. */
export interface SkillStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export declare function readInstalled(storage?: SkillStore | null): InstalledRecords;
export declare function rememberInstalled(
  skill: Partial<HfSkill>,
  result: Partial<InstallResult>,
  storage?: SkillStore | null,
): InstalledRecords;
/** 'install', 'installed', or 'update' when the catalogue has moved on. */
export declare function installStatus(
  skill: Partial<HfSkill>,
  records: InstalledRecords,
): 'install' | 'installed' | 'update';
