/**
 * HuggingFace Skills knowledge pack: load SKILL.md from HF repos.
 */

export interface HfSkill {
  name: string;
  description: string;
  tags: string[];
  content: string;
  repo?: string;
  path?: string;
}

export declare function parseSkillMd(text: string): HfSkill | null;
export declare function loadCatalog(token?: string): Promise<HfSkill[]>;
