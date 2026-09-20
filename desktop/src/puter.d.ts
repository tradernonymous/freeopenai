/**
 * Puter's SDK, loaded into this webview only when the user picks it.
 *
 * Everything here degrades: with no `puter` global (node, or a build that never
 * loaded it) `loaded()` is false, `isSignedIn()` is false and `ensure()` rejects
 * with a sentence a user can act on.
 */
export declare const SRC: string;
export declare function ensure(): Promise<any>;
export declare function loaded(): boolean;
export declare function isSignedIn(): boolean;
export declare function user(): any;
export declare function signIn(): Promise<boolean>;
export declare function signOut(): Promise<void>;
export declare function onAuthChange(handler: (who: any) => void): () => void;
export declare function imageToDataUrl(result: any): Promise<string>;
export declare function draw(
  prompt: string,
  options?: { model?: string; ratio?: { w: number; h: number }; quality?: string; source?: string },
): Promise<string>;
