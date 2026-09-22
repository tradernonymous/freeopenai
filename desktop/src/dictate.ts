// Dictation. WebView2 has no SpeechRecognition, so the app records the mic
// itself and asks Whisper for the words: the user's own whisper.cpp on this PC
// (whisper.rs, 16 kHz mono WAV made by wav.js) or Whisper on Hugging Face (the
// token the person already signed in with). Without either, Windows' own
// Win+H still types into the composer -- the button says so rather than
// failing. Which one is used: `freeai4u.dictation_engine` (see chooseEngine).
import './wav.js';

const wavLib: typeof import('./wav.js') = (globalThis as any).FreeAI4UWav;

export const WHISPER_MODEL = 'openai/whisper-large-v3-turbo';
export const WHISPER_URL = `https://router.huggingface.co/hf-inference/models/${WHISPER_MODEL}`;
/** A dictation longer than this is stopped for you (and stays one request). */
export const MAX_SECONDS = 120;

export interface Recording {
  /** Stop and hand back what was said, as audio. */
  stop: () => Promise<Blob>;
  cancel: () => void;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start();
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let finished: Promise<Blob> | null = null;
  const stop = () => {
    if (!finished) {
      finished = new Promise<Blob>((resolve) => {
        recorder.onstop = () => { release(); resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })); };
        if (recorder.state !== 'inactive') recorder.stop(); else recorder.onstop(new Event('stop'));
      });
    }
    return finished;
  };
  const limit = setTimeout(() => { stop(); }, MAX_SECONDS * 1000);
  return {
    stop: () => { clearTimeout(limit); return stop(); },
    cancel: () => { clearTimeout(limit); recorder.onstop = release; if (recorder.state !== 'inactive') recorder.stop(); else release(); },
  };
}

/** Whisper's words for a recording. Throws with the provider's reason. */
export async function transcribe(audio: Blob, token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(WHISPER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': audio.type || 'audio/webm' },
    body: audio,
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    const why = (data && (data.error?.message || data.error)) || `HTTP ${res.status}`;
    throw new Error(res.status === 401 || res.status === 403
      ? 'Hugging Face refused the token for speech. Give it the "Make calls to Inference Providers" permission.'
      : `Whisper: ${String(why).slice(0, 200)}`);
  }
  return String(data?.text || '').trim();
}

// ---- which Whisper: local whisper.cpp or Hugging Face ----------------------

export const ENGINE_KEY = 'freeai4u.dictation_engine';
export const MODEL_KEY = 'freeai4u.whisper_model';
export const LANGUAGE_KEY = 'freeai4u.whisper_language';

export type EngineSetting = 'auto' | 'local' | 'hf';
export type Engine = 'local' | 'hf' | 'none';

export function normalizeEngine(raw: unknown): EngineSetting {
  return raw === 'local' || raw === 'hf' ? raw : 'auto';
}

/**
 * The engine for one dictation. auto = this PC's whisper.cpp when a binary and
 * a model are set up, else Hugging Face when signed in, else none (the Win+H
 * hint). A forced engine that is not available is 'none', not a silent swap.
 */
export function chooseEngine(opts: { setting: EngineSetting | string; localReady: boolean; hfToken: boolean }): Engine {
  const setting = normalizeEngine(opts.setting);
  if (setting === 'local') return opts.localReady ? 'local' : 'none';
  if (setting === 'hf') return opts.hfToken ? 'hf' : 'none';
  if (opts.localReady) return 'local';
  return opts.hfToken ? 'hf' : 'none';
}

/** The model to run: the saved one if it is still there, else the first found. */
export function pickModel(saved: string, models: Array<{ path: string }>): string {
  if (saved && models.some((m) => m.path === saved)) return saved;
  return models.length ? models[0].path : '';
}

/** Why nothing can transcribe, for the given setting. */
export function noEngineMessage(setting: EngineSetting): string {
  if (setting === 'local') return 'Local dictation needs whisper.cpp and a ggml model: set them up under Settings → Dictation. Windows can also type what you say — press Win+H.';
  if (setting === 'hf') return 'Dictation uses Whisper on Hugging Face: sign in under Settings → Connectors. Windows can also type what you say — press Win+H.';
  return 'Dictation needs whisper.cpp (Settings → Dictation) or a Hugging Face sign-in (Settings → Connectors). Windows can also type what you say — press Win+H.';
}

function stored(key: string): string {
  try { return globalThis.localStorage?.getItem(key) || ''; } catch { return ''; }
}

export function readEngineSetting(): EngineSetting {
  return normalizeEngine(stored(ENGINE_KEY));
}

/** Is local whisper.cpp ready, and with which model? Never throws. */
export async function localSetup(): Promise<{ ready: boolean; model: string }> {
  try {
    const bridge = await import('./bridge.ts');
    if (!bridge.hasShell()) return { ready: false, model: '' };
    const facts = await bridge.whisperFind();
    const model = pickModel(stored(MODEL_KEY), facts.models);
    return { ready: facts.found && !!model, model };
  } catch {
    return { ready: false, model: '' };
  }
}

/** A recording (webm/opus) -> 16 kHz mono WAV bytes, decoded by the page. */
export async function toWav(audio: Blob): Promise<Uint8Array> {
  const Ctx: typeof AudioContext = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
  if (!Ctx) throw new Error('This window cannot decode audio.');
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await audio.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let i = 0; i < decoded.numberOfChannels; i += 1) channels.push(decoded.getChannelData(i));
    return wavLib.toWhisperWav(channels, decoded.sampleRate);
  } finally {
    ctx.close().catch(() => {});
  }
}

/** The words from this PC's whisper.cpp. */
export async function transcribeLocal(audio: Blob, modelPath: string, language = stored(LANGUAGE_KEY)): Promise<string> {
  const bridge = await import('./bridge.ts');
  const wav = await toWav(audio);
  const words = await bridge.whisperTranscribe({ audioWavBase64: wavLib.toBase64(wav), modelPath, language: language || undefined });
  return String(words || '').trim();
}

/**
 * The one call the chat makes: the engine chooseEngine picks. In auto mode a
 * local failure falls back to Hugging Face when signed in.
 */
export async function transcribeAuto(audio: Blob, hfToken: string): Promise<string> {
  const setting = readEngineSetting();
  const local = setting === 'hf' ? { ready: false, model: '' } : await localSetup();
  const engine = chooseEngine({ setting, localReady: local.ready, hfToken: !!hfToken });
  if (engine === 'local') {
    try {
      return await transcribeLocal(audio, local.model);
    } catch (e) {
      if (setting === 'auto' && hfToken) return transcribe(audio, hfToken);
      throw e;
    }
  }
  if (engine === 'hf') return transcribe(audio, hfToken);
  throw new Error(noEngineMessage(setting));
}
