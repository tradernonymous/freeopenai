/** ZIP read/write (UMD, shared with node:test). */
export declare function crc32(bytes: Uint8Array): number;
export declare function inflateRaw(bytes: Uint8Array): Promise<Uint8Array>;
export declare function deflateRaw(bytes: Uint8Array): Promise<Uint8Array>;
export declare function readEntries(bytes: Uint8Array): Promise<Array<{ name: string; dir: boolean; data: Uint8Array | null }>>;
export declare function findEntry(bytes: Uint8Array, name: string): Promise<Uint8Array | null>;
export declare function writeZip(entries: Array<{ name: string; data: Uint8Array }>): Promise<Uint8Array>;
