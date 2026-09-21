/** The network allowlist mirror (UMD, shared with node:test). */
export declare const HOSTS: string[];
export declare function schemeOf(url: unknown): string;
export declare function hostOf(url: unknown): string;
export declare function isLoopback(host: string): boolean;
export declare function hostMatches(host: string, entry: string): boolean;
export declare function isAllowed(url: unknown, extra?: string[]): boolean;
/** '' when the URL is allowed; otherwise a sentence naming why it is not. */
export declare function refusalReason(url: unknown, extra?: string[]): string;
export declare function resolveLocation(base: string, location: string): string | null;
