/**
 * Hugging Face sign-in: one-click OAuth (authorization code + PKCE, loopback
 * redirect through the shell) or a pasted access token; one token store.
 */

export interface HfToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  /** 'oauth' (one-click) or 'pat' (a pasted access token). */
  source?: 'oauth' | 'pat';
  /** The OAuth client the token was issued to; a refresh must use the same one. */
  client_id?: string;
}

export interface HfUser {
  name: string;
  fullname: string;
  avatar_url?: string;
}

export declare const TOKEN_KEY: string;
export declare const SECRET_TOKEN: string;
export declare const SECRET_USER: string;
export declare const AUTH_CHANGED_EVENT: string;
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export declare function configureStore(store: SecretStore | null): void;
export declare function hydrate(): Promise<boolean>;
export declare const SCOPE: string;
/** The token page, opened with the Inference Providers permission ticked. */
export declare const TOKEN_PAGE: string;
/** http://127.0.0.1:47823/hf/callback -- registered with the OAuth app. */
export declare const REDIRECT_URI: string;
export declare const LOOPBACK_PORT: number;
export declare const DEFAULT_TIMEOUT_SECS: number;
/** localStorage key of the Settings override of the OAuth client id. */
export declare const CLIENT_ID_KEY: string;
/** How to register the OAuth app (docs/desktop.md). */
export declare const DOCS_URL: string;
/** Check a pasted access token against whoami, store it, resolve with the user. */
export declare function useToken(token: string, fetchImpl?: typeof fetch): Promise<any>;

export declare function signedIn(): boolean;
export declare function accessToken(): HfToken | null;
export declare function authHeaders(): Record<string, string>;

export declare function validClientId(id: unknown): boolean;
export declare function clientIdOverride(): string | null;
/** Keep the Settings override; an empty value forgets it. Throws on a malformed id. */
export declare function setClientIdOverride(id: string | null): void;
/** The Settings override, else the build's client id, else null. */
export declare function resolveClientId(buildClientId?: string | null): string | null;
export declare function pkcePair(): Promise<{ verifier: string; challenge: string }>;
export declare function authorizeUrl(opts: {
  clientId: string;
  redirectUri?: string;
  state: string;
  challenge: string;
  scope?: string;
}): string;

export type HfListenAnswer = string | { code: string; state: string };
export interface BeginOAuthOptions {
  clientId: string | null | undefined;
  redirectUri?: string;
  openUrl: (url: string) => Promise<void> | void;
  listen: (state: string, timeoutSecs: number) => Promise<HfListenAnswer>;
  exchange: (code: string, verifier: string, clientId: string, redirectUri: string) => Promise<any>;
  cancel?: () => Promise<void> | void;
  fetchImpl?: typeof fetch;
  timeoutSecs?: number;
  scope?: string;
  /** How long to wait for the listener to fail fast (a busy port) before opening the browser. */
  settleMs?: number;
}
/** One-click sign-in; resolves with the Hugging Face user once the token is kept. */
export declare function beginOAuth(opts: BeginOAuthOptions): Promise<any>;
/** The shell's refresh (hf_oauth_refresh), used when an OAuth token runs out. */
export declare function configureRefresh(fn: ((refreshToken: string, clientId: string) => Promise<any>) | null): void;
export declare function refreshAccessToken(
  refreshFn?: (refreshToken: string, clientId: string) => Promise<any>,
): Promise<HfToken | null>;
export declare function fetchUser(): Promise<HfUser | null>;
export declare function cachedUser(): HfUser | null;
export declare function signOut(): void;
export declare function saveToken(token: HfToken): void;
export declare function loadToken(): HfToken | null;
export declare function clearToken(): void;
