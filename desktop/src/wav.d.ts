/** Recorded audio -> 16 kHz mono 16-bit WAV for whisper.cpp (UMD, node-tested). */
export declare const TARGET_RATE: number;
export declare function mixToMono(channels: Float32Array | Float32Array[]): Float32Array;
export declare function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array;
export declare function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array;
export declare function toWhisperWav(channels: Float32Array | Float32Array[], sampleRate: number): Uint8Array;
export declare function toBase64(bytes: Uint8Array): string;
