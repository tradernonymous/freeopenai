/** Chat encryption at rest: AES-GCM-256 via WebCrypto (UMD, shared with node:test). */
import type { ChatBackend } from './chats.js';

export interface ChatKeyStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}
export declare const IV_BYTES: number;
export declare function toBase64(bytes: Uint8Array | ArrayBuffer): string;
export declare function fromBase64(text: string): Uint8Array;
export declare function generateKey(): Promise<CryptoKey>;
export declare function exportKey(key: CryptoKey): Promise<string>;
export declare function importKey(base64: string): Promise<CryptoKey>;
export declare function encrypt(key: CryptoKey, text: string): Promise<string>;
export declare function decrypt(key: CryptoKey, blob: string): Promise<string>;
export declare function loadOrCreateKey(store: ChatKeyStore): Promise<CryptoKey>;
export declare function backend(options: {
  call: (command: string, args?: Record<string, unknown>) => Promise<any>;
  key: CryptoKey;
}): ChatBackend & { clear(): Promise<unknown> };
