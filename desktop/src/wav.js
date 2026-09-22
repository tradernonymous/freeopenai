// Recorded audio -> the WAV whisper.cpp reads: 16 kHz, mono, 16-bit PCM.
//
// The page decodes the recording (AudioContext.decodeAudioData gives Float32
// channels at the device rate); this mixes the channels down, resamples with
// a plain linear interpolator (speech at 16 kHz does not need better) and
// writes a canonical 44-byte RIFF header. Pure -- no DOM -- so node tests it.
//
// UMD (see chats.js).
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeAI4UWav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TARGET_RATE = 16000;

  /** Average the channels into one. A single channel is returned as is. */
  function mixToMono(channels) {
    if (!channels) return new Float32Array(0);
    if (!Array.isArray(channels)) return channels;
    if (!channels.length) return new Float32Array(0);
    if (channels.length === 1) return channels[0];
    var length = channels.reduce(function (n, c) { return Math.min(n, c.length); }, Infinity);
    var out = new Float32Array(length);
    for (var i = 0; i < length; i += 1) {
      var sum = 0;
      for (var c = 0; c < channels.length; c += 1) sum += channels[c][i];
      out[i] = sum / channels.length;
    }
    return out;
  }

  /** Linear resampling: round(n * to / from) samples out. */
  function resample(samples, fromRate, toRate) {
    var from = Number(fromRate) || TARGET_RATE;
    var to = Number(toRate) || TARGET_RATE;
    if (from === to) return samples;
    var outLength = Math.round(samples.length * to / from);
    var out = new Float32Array(outLength);
    var step = from / to;
    for (var i = 0; i < outLength; i += 1) {
      var pos = i * step;
      var left = Math.floor(pos);
      var right = Math.min(left + 1, samples.length - 1);
      var frac = pos - left;
      var a = samples[Math.min(left, samples.length - 1)] || 0;
      var b = samples[right] || 0;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  function writeAscii(view, offset, s) {
    for (var i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  }

  /** Mono Float32 samples -> WAV bytes (16-bit little-endian PCM). */
  function encodeWav(samples, sampleRate) {
    var rate = Math.round(Number(sampleRate) || TARGET_RATE);
    var dataBytes = samples.length * 2;
    var buffer = new ArrayBuffer(44 + dataBytes);
    var view = new DataView(buffer);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); // byte rate = rate * channels * 2
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);
    for (var i = 0; i < samples.length; i += 1) {
      var s = Math.max(-1, Math.min(1, samples[i] || 0));
      view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    }
    return new Uint8Array(buffer);
  }

  /** Decoded channels at any rate -> the WAV whisper.cpp wants. */
  function toWhisperWav(channels, sampleRate) {
    return encodeWav(resample(mixToMono(channels), sampleRate, TARGET_RATE), TARGET_RATE);
  }

  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /** Bytes -> standard base64 (for the shell call), without btoa. */
  function toBase64(bytes) {
    var out = '';
    var i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    }
    var rest = bytes.length - i;
    if (rest === 1) {
      var one = bytes[i] << 16;
      out += ALPHABET[(one >> 18) & 63] + ALPHABET[(one >> 12) & 63] + '==';
    } else if (rest === 2) {
      var two = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += ALPHABET[(two >> 18) & 63] + ALPHABET[(two >> 12) & 63] + ALPHABET[(two >> 6) & 63] + '=';
    }
    return out;
  }

  return {
    TARGET_RATE: TARGET_RATE,
    mixToMono: mixToMono,
    resample: resample,
    encodeWav: encodeWav,
    toWhisperWav: toWhisperWav,
    toBase64: toBase64,
  };
});
