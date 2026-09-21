/**
 * HuggingFace Skills knowledge pack: load SKILL.md from HF repos.
 */

export interface HfSkill {
  name: string;
  description: string;
  tags: string[];
  content: string;
  source: string;
  repo?: string;
  path?: string;
}

export declare const SKILL_REPOS: string[];
export declare function fetchSkill(repo: string, path: string, token?: string): Promise<string | null>;
export declare function parseSkillMd(text: string): HfSkill | null;
export declare function loadCatalog(token?: string): Promise<HfSkill[]>;
export declare function filterSkills(skills: HfSkill[], query: string): HfSkill[];
