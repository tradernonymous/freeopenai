/**
 * HuggingFace OAuth: PKCE loopback + device-code fallback, token store.
 */

export interface HfToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
}

export interface HfUser {
  name: string;
  fullname: string;
  avatar_url?: string;
}

export interface HfDeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval?: number;
}

export declare const TOKEN_KEY: string;
export declare const CLIENT_ID: string;
export declare const SCOPE: string;

export declare function signedIn(): boolean;
export declare function accessToken(): HfToken | null;
export declare function authHeaders(): Record<string, string>;
export declare function signInPKCE(): Promise<HfToken>;
export declare function startDeviceCode(): Promise<HfDeviceCode>;
export declare function pollDeviceCode(deviceCode: string, interval?: number, expiresAt?: number): Promise<HfToken>;
export declare function refreshAccessToken(): Promise<HfToken | null>;
export declare function fetchUser(): Promise<HfUser | null>;
export declare function cachedUser(): HfUser | null;
export declare function signOut(): void;
export declare function saveToken(token: HfToken): void;
export declare function loadToken(): HfToken | null;
export declare function clearToken(): void;
