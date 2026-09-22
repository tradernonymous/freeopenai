/** The Social post skill: platform templates (UMD, shared with node:test). */
export interface SocialTemplate {
  id: string;
  label: string;
  category: string;
  width: number;
  height: number;
  unit: string;
  deck: boolean;
  description: string;
  prompt: string;
}

export interface TemplateRow {
  id: string;
  label: string;
  category: string;
  width: number;
  height: number;
  unit: string;
  description: string;
}

export declare const TEMPLATES: SocialTemplate[];
export declare function byId(id: string): SocialTemplate | null;
export declare function merge(engineTemplates: TemplateRow[]): TemplateRow[];
export declare function promptFor(id: string): string;
