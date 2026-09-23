/** The composer's grammar: modes, `/` and `@` menus (UMD, shared with node:test). */
export type ModeId = 'chat' | 'plan' | 'build' | 'shell' | 'design';

export interface Mode {
  id: ModeId;
  label: string;
  hint: string;
  cycle: boolean;
}

export interface SlashCommand {
  id: string;
  hint: string;
  aliases?: string[];
  mode?: ModeId;
  insertText?: string;
  next?: string;
  keys?: string;
  skill?: string;
}

export interface MentionSource {
  kind: 'model' | 'file' | 'picture' | 'mcp' | 'skill';
  id: string;
  label: string;
  hint?: string;
  provider?: string;
}

export declare const MODES: Mode[];
export declare const SLASH: SlashCommand[];
export declare function modeById(id: string): Mode;
export declare function cycleMode(current: string, backwards?: boolean): ModeId;
export declare function modeFromTyping(mode: string, text: string): { mode: ModeId; text: string } | null;
export declare function leaveMode(mode: string, key: string, caret: number): ModeId | null;
export declare function skillRow(skill: { id?: string; name?: string; description?: string }): SlashCommand;
export declare function slashMenu(text: string, extra?: SlashCommand[], limit?: number): SlashCommand[];
export declare function parseSlash(text: string, extra?: SlashCommand[]): { command: SlashCommand; arg: string } | null;
export declare function nextStep(id: string): SlashCommand | null;
export declare function mentionAt(text: string, caret?: number): { start: number; query: string } | null;
export declare function mentionMenu(query: string, sources: MentionSource[], limit?: number): MentionSource[];
export declare function completeMention(text: string, start: number, caret: number, insert: string): { text: string; caret: number };
export declare function threadMarkdown(session: any): string;
export declare function lastUserText(messages: Array<{ role: string; content: string }>): string;

/** A picture in the thread: which message, which of its pictures, and who put it there. */
export interface PictureRef {
  url: string;
  index: number;
  slot: number;
  role: 'user' | 'assistant';
}
export interface PictureTarget {
  url: string;
  /** attached: on this message; picked: a picture's Edit button; latest: the newest in the thread. */
  from: 'attached' | 'picked' | 'latest';
  index?: number;
  slot?: number;
  role?: 'user' | 'assistant';
}
export declare function latestPicture(messages: Array<{ role: string; images?: string[] }>): PictureRef | null;
export declare function pictureTarget(input: {
  attached?: string[];
  pinned?: { url: string; index: number; slot: number } | null;
  messages: Array<{ role: string; images?: string[] }>;
}): PictureTarget | null;
export declare function targetLabel(target: PictureTarget | null): string;
export declare function stripPictureMention(text: string): string;
export declare function lastPictureRun<P extends { prompt: string }>(messages: Array<{ picture?: P }>): { index: number; picture: P } | null;
