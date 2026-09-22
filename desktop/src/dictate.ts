// Dictation. WebView2 has no SpeechRecognition, so the app records the mic
// itself and asks Whisper on Hugging Face (the token the person already signed
// in with) for the words. Without a token, Windows' own Win+H still types into
// the composer -- the button says so rather than failing.
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
