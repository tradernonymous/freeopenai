// Running one of "my models": the two local providers behind the pickers.
//
// Chat, Design and Code all ask the same question -- "stream a reply from this
// (provider, model)" -- and for the two local providers the answer is not the
// engine. This is that answer, in one place:
//
//   * Ollama Local  -> POST /api/chat on Ollama's own server, THROUGH THE SHELL
//     (Ollama refuses a Tauri window's origin; the shell has none), NDJSON
//     parsed here. Settings ride along as `options`, so nothing ever reloads.
//   * Unsloth Local -> llama-server with `-m <the file>`. If another model (or
//     none) is loaded, it is started first -- which takes tens of seconds, so
//     the caller is told the stage and can say "Loading…" instead of looking
//     frozen. Sampling rides along; context/GPU layers are load-time.
import { ApiError, streamLocalChat, type StreamFrame } from './api';
import { hasShell, localModelStart, localModelStatus, shellPostStream, type LocalModelStatus } from './bridge';
import './saved-models.js';
import './run-settings.js';

const savedModels: typeof import('./saved-models.js') = (globalThis as any).FreeAI4USavedModels;
const runSettings: typeof import('./run-settings.js') = (globalThis as any).FreeAI4URunSettings;

type Message = { role: string; content: any };
type SavedModel = import('./saved-models.js').SavedModel;
type RunValues = import('./run-settings.js').RunValues;

/** Settings changed with "Remember for this model" off: this session only. */
const sessionOverrides = new Map<string, RunValues>();

export function isSavedProvider(provider: string): boolean {
  return savedModels.isSavedProvider(provider);
}

export function settingsFor(entry: SavedModel): RunValues {
  return sessionOverrides.get(entry.id) || runSettings.get(entry.id);
}

export function applySettings(entry: SavedModel, values: RunValues, remember: boolean): void {
  if (remember) {
    sessionOverrides.delete(entry.id);
    runSettings.set(entry.id, values);
  } else {
    sessionOverrides.set(entry.id, runSettings.clean(values));
  }
}

export function forgetSettings(entry: SavedModel): void {
  sessionOverrides.delete(entry.id);
  runSettings.reset(entry.id);
}

function sameFile(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/**
 * Make llama-server serve this file, starting or restarting it if it is not.
 * `force` reloads even when it already is (the drawer's "Reload model").
 */
export async function ensureUnsloth(entry: SavedModel, force = false, onStage?: (stage: string) => void): Promise<LocalModelStatus> {
  if (!hasShell()) throw new ApiError(0, 'Running a model on this machine needs the installed desktop app.');
  if (!force) {
    const status = await localModelStatus().catch(() => null);
    if (status && status.state === 'ready' && status.file && sameFile(status.file, entry.path)) return status;
  }
  onStage?.(`Loading ${entry.name}…`);
  const cores = Number((globalThis as any).navigator?.hardwareConcurrency) || 0;
  return localModelStart({
    repo: entry.name,
    file: entry.path,
    ...runSettings.loadArgs(settingsFor(entry), cores),
  });
}

/** One NDJSON line from Ollama's /api/chat, as a frame (or an error). */
export function ollamaFrame(line: string): StreamFrame | null {
  const text = line.trim();
  if (!text) return null;
  let row: any;
  try {
    row = JSON.parse(text);
  } catch {
    return null;
  }
  if (row && row.error) throw new ApiError(0, `Ollama: ${typeof row.error === 'string' ? row.error : JSON.stringify(row.error)}`);
  const content = row?.message?.content;
  // Ollama sends a tool call whole, with its arguments as an object.
  const called = Array.isArray(row?.message?.tool_calls) && row.message.tool_calls.length ? row.message.tool_calls : undefined;
  if (row?.done) return { content: typeof content === 'string' && content ? content : undefined, toolCalls: called, done: true, model: row.model };
  return (typeof content === 'string' && content) || called ? { content: content || undefined, toolCalls: called, model: row.model } : null;
}

/**
 * A turn that used tools is replayed to the model. OpenAI-shaped servers want a
 * call's arguments as JSON text; Ollama wants the object, and names the tool
 * on the result as `tool_name`.
 */
export function forOllama(message: any): any {
  if (!message || typeof message !== 'object') return message;
  if (Array.isArray(message.tool_calls)) {
    return {
      ...message,
      tool_calls: message.tool_calls.map((call: any) => {
        const args = call?.function?.arguments;
        let parsed = args;
        if (typeof args === 'string') {
          try { parsed = JSON.parse(args || '{}'); } catch { parsed = {}; }
        }
        return { ...call, function: { ...(call?.function || {}), arguments: parsed } };
      }),
    };
  }
  if (message.role === 'tool' && message.name && !message.tool_name) return { ...message, tool_name: message.name };
  return message;
}

async function streamOllama(entry: SavedModel, messages: Message[], onFrame: (f: StreamFrame) => void, signal?: AbortSignal, offered?: any[]): Promise<void> {
  if (!hasShell()) throw new ApiError(0, 'Ollama is reached through the installed desktop app.');
  const values = settingsFor(entry);
  const body = JSON.stringify({
    model: entry.name,
    messages: runSettings.withSystem(messages, values).map(forOllama),
    stream: true,
    options: runSettings.ollamaOptions(values),
    ...(offered && offered.length ? { tools: offered } : {}),
  });
  let buffer = '';
  let status = 200;
  let failure = '';
  const drain = (final: boolean) => {
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (status >= 400) { failure += line; continue; }
      const frame = ollamaFrame(line);
      if (frame) onFrame(frame);
    }
    if (final && buffer.trim()) {
      if (status >= 400) failure += buffer;
      else {
        const frame = ollamaFrame(buffer);
        if (frame) onFrame(frame);
      }
      buffer = '';
    }
  };
  await shellPostStream(
    { url: `${entry.base || savedModels.OLLAMA_BASE}/api/chat`, body },
    (chunk) => { buffer += chunk; drain(false); },
    (code) => { status = code; },
    signal,
  );
  drain(true);
  if (status >= 400) {
    let message = failure.slice(0, 300);
    try { message = JSON.parse(failure).error || message; } catch { /* as it came */ }
    throw new ApiError(status, `Ollama answered ${status}: ${message}`);
  }
}

/**
 * Stream a reply from one of "my models". Throws when the pick is not one --
 * the caller checks isSavedProvider first.
 */
export async function streamSaved(
  provider: string,
  model: string,
  messages: Message[],
  onFrame: (frame: StreamFrame) => void,
  signal?: AbortSignal,
  onStage?: (stage: string) => void,
  /** Tool definitions to offer (OpenAI shape), when the turn has any. */
  offered?: any[],
): Promise<void> {
  const entry = savedModels.find(provider, model);
  if (!entry) {
    throw new ApiError(0, `${model || 'That model'} is no longer in your models. Add it again in Settings → Local models.`);
  }
  if (entry.kind === 'ollama') return streamOllama(entry, messages, onFrame, signal, offered);
  const status = await ensureUnsloth(entry, false, onStage);
  onStage?.('');
  const values = settingsFor(entry);
  return streamLocalChat(
    status.base_url,
    entry.name,
    runSettings.withSystem(messages, values),
    onFrame,
    signal,
    status.api_key || undefined,
    { ...runSettings.openaiParams(values), ...(offered && offered.length ? { tools: offered } : {}) },
  );
}
