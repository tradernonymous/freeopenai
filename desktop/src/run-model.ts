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
import { Template } from '@huggingface/jinja';
import { ApiError, streamLocalChat, type StreamFrame } from './api';
import { ggufInfo, hasShell, localModelStart, localModelStatus, shellPostStream, type LocalModelStatus } from './bridge';
import './saved-models.js';
import './run-settings.js';
import './local-models.js';
import './chat-template.js';

const savedModels: typeof import('./saved-models.js') = (globalThis as any).FreeAI4USavedModels;
const runSettings: typeof import('./run-settings.js') = (globalThis as any).FreeAI4URunSettings;
const localModels: typeof import('./local-models.js') = (globalThis as any).FreeAI4ULocalModels;
const chatTemplate: typeof import('./chat-template.js') = (globalThis as any).FreeAI4UChatTemplate;

// The renderer is a UMD file with no import of its own, so the one place that
// bundles Jinja is here.
chatTemplate.setEngine(Template);

type ModelLimits = import('./run-settings.js').ModelLimits;

/** What the person said their GPU has (a webview cannot measure it). */
export const VRAM_KEY = 'freeai4u.vram_gb';

export function machineSpec(): { ramGb: number; vramGb: number } {
  let vramGb = 0;
  try { vramGb = Number(localStorage.getItem(VRAM_KEY)) || 0; } catch { /* unknown */ }
  return { ramGb: localModels.machine().ramGb, vramGb };
}

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

/**
 * The settings a request actually goes out with: the context resolved per
 * model -- the person's pick capped at what the model was trained for, or
 * Auto sized to this machine -- and always sent, never left to the runtime.
 */
export function resolvedValues(entry: SavedModel): RunValues {
  const values = settingsFor(entry);
  const limits = runSettings.limitsFor(entry.id);
  const ctx = runSettings.effectiveCtx(values, limits, { bytes: entry.bytes, gpuLayers: values.gpuLayers }, machineSpec());
  return { ...values, ctx };
}

/**
 * Ask the model what it is: trained context and KV cost per token. Ollama
 * answers /api/show at once. A GGUF file answers from its own header, read by
 * the shell BEFORE any load -- so even the first load is sized exactly;
 * llama-server's /v1/models (once loaded) is the fallback for a header that
 * cannot be read. Remembered per model, so it is asked once.
 */
export async function detectLimits(entry: SavedModel, server?: { base_url: string; api_key?: string | null }): Promise<ModelLimits | null> {
  if (entry.kind === 'unsloth' && entry.path && hasShell()) {
    try {
      const info = await ggufInfo(entry.path);
      // The same read answers both questions, so the template costs nothing
      // extra: opening a multi-gigabyte file once is the expensive part.
      chatTemplate.remember(entry.id, chatTemplate.templateOf(info));
      const limits = runSettings.parseGgufInfo(info);
      if (limits.trainCtx || limits.kvBytesPerToken) {
        runSettings.setLimits(entry.id, limits);
        if (limits.trainCtx) return limits;
      }
    } catch {
      /* an unreadable header: ask the loaded server below, when there is one */
    }
  }
  try {
    if (entry.kind === 'ollama') {
      if (!hasShell()) return null;
      let text = '';
      let status = 200;
      await shellPostStream(
        { url: `${entry.base || savedModels.OLLAMA_BASE}/api/show`, body: JSON.stringify({ model: entry.name }) },
        (chunk) => { text += chunk; },
        (code) => { status = code; },
      );
      if (status >= 400) return null;
      const limits = runSettings.parseOllamaShow(JSON.parse(text));
      if (limits.trainCtx || limits.kvBytesPerToken) runSettings.setLimits(entry.id, limits);
      return limits;
    }
    if (server?.base_url) {
      const res = await fetch(`${server.base_url.replace(/\/+$/, '')}/v1/models`, {
        headers: server.api_key ? { Authorization: `Bearer ${server.api_key}` } : {},
      });
      if (!res.ok) return null;
      const limits = runSettings.parseLlamaModels(await res.json());
      if (limits.trainCtx) runSettings.setLimits(entry.id, limits);
      return limits;
    }
  } catch {
    /* a model that will not describe itself keeps the defaults */
  }
  return null;
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
  // The file's header first, so this load's context is the exact one.
  if (!runSettings.limitsFor(entry.id)?.trainCtx) await detectLimits(entry);
  onStage?.(`Loading ${entry.name}…`);
  const cores = Number((globalThis as any).navigator?.hardwareConcurrency) || 0;
  const status = await localModelStart({
    repo: entry.name,
    file: entry.path,
    ...runSettings.loadArgs(resolvedValues(entry), cores),
  });
  // A header that could not be read: learned from the server after this load.
  if (!runSettings.limitsFor(entry.id)?.trainCtx) detectLimits(entry, status).catch(() => {});
  return status;
}

/**
 * Read the header of every GGUF in "my models" that has no limits yet, in the
 * background. Runs whenever the list changes -- every place that adds a model
 * (My models, a finished download) goes through saved-models -- so Auto is
 * right on the very first run.
 */
export function learnLimits(): void {
  if (!hasShell()) return;
  for (const entry of savedModels.list()) {
    if (entry.kind === 'unsloth' && entry.path && !runSettings.limitsFor(entry.id)) {
      detectLimits(entry).catch(() => {});
    }
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(savedModels.CHANGED_EVENT, learnLimits);
}

// ---- the model's own chat template -------------------------------------------
//
// A GGUF carries the Jinja template the model was trained with. Sending the
// messages list instead leaves the shape to whatever is downstream, and for a
// model whose template differs -- where the system prompt goes, which tags a
// thinking model opens -- the answer is wrong in a way that reads like a bad
// model. So when the file has a template this page can render (chat-template.js
// renders it under caps, because it is data out of a downloaded file), the turn
// goes out as that exact prompt; otherwise nothing changes.

/** Reasons already said once, so a refused template is not logged every turn. */
const templateSaid = new Set<string>();

function templateRefused(entry: SavedModel, reason: string): void {
  const key = `${entry.id}:${reason}`;
  if (templateSaid.has(key)) return;
  templateSaid.add(key);
  // Readable, and only ever a note: the turn still goes out the generic way.
  console.warn(`${entry.name}: using the generic prompt because ${reason}.`);
}

/**
 * The template for a model, read from its header once and remembered. '' means
 * the file has none -- a real answer, remembered like any other. A header that
 * could not be read is NOT remembered, because that is a condition that mends.
 */
export async function chatTemplateFor(entry: SavedModel): Promise<string> {
  if (entry.kind !== 'unsloth' || !entry.path || !hasShell()) return '';
  const known = chatTemplate.cached(entry.id);
  if (known !== null) return known;
  try {
    const found = chatTemplate.templateOf(await ggufInfo(entry.path));
    chatTemplate.remember(entry.id, found);
    return found;
  } catch {
    return '';
  }
}

/**
 * Send an already-shaped prompt to llama-server's text completion endpoint.
 * True once it has streamed; false means nothing was read and the caller
 * should send the messages the generic way instead.
 *
 * The prompt goes out WITHOUT a BOS token: llama-server tokenizes a prompt with
 * its special tokens on and prepends the model's own, so chat-template.js drops
 * the template's leading one rather than have the model see it twice.
 */
async function streamRendered(
  status: LocalModelStatus,
  entry: SavedModel,
  prompt: string,
  values: RunValues,
  onFrame: (frame: StreamFrame) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const origin = String(status.base_url || '').replace(/\/+$/, '');
  if (!origin) return false;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (status.api_key) headers.Authorization = `Bearer ${status.api_key}`;
  let res: Response;
  try {
    res = await fetch(`${origin}/v1/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...runSettings.openaiParams(values), model: entry.name || 'local', prompt, stream: true }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // A server that is not answering: the generic path says so properly.
    return false;
  }
  // An older server with no text-completion route answers 404: fall back
  // rather than tell the person their model failed.
  if (!res.ok || !res.body) {
    try { await res.body?.cancel(); } catch { /* nothing was read */ }
    return false;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onFrame({ done: true });
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { finish(); continue; }
      let frame: any;
      try { frame = JSON.parse(payload); } catch { continue; }
      if (frame && frame.error) {
        const message = typeof frame.error === 'string' ? frame.error : frame.error.message;
        throw new ApiError(0, message || 'The local model server stopped mid-answer.');
      }
      const choice = frame && frame.choices && frame.choices[0];
      const text = choice && choice.text;
      // Reasoning arrives as the model writes it (<think>…), which is how
      // every other provider's shows: markdown.ts folds it.
      if (typeof text === 'string' && text) onFrame({ content: text, model: frame.model });
      if (choice && choice.finish_reason) finish();
    }
  }
  finish();
  return true;
}

/** One NDJSON line from Ollama's /api/chat, as a frame (or an error). */
export function ollamaFrame(line: string): (StreamFrame & { thinking?: string }) | null {
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
  // With `think` on, Ollama streams the reasoning apart as message.thinking.
  const thinking = typeof row?.message?.thinking === 'string' && row.message.thinking ? row.message.thinking : undefined;
  if (row?.done) return { content: typeof content === 'string' && content ? content : undefined, toolCalls: called, done: true, model: row.model };
  return (typeof content === 'string' && content) || called || thinking
    ? { content: content || undefined, toolCalls: called, model: row.model, ...(thinking ? { thinking } : {}) }
    : null;
}

/**
 * Ollama's `think` for a /reasoning level: unset leaves the model's default;
 * off is false; gpt-oss takes the level itself, every other thinking model a
 * plain true (Ollama refuses a level string for them).
 */
export function ollamaThink(model: string, reasoning?: string): boolean | string | undefined {
  if (!reasoning) return undefined;
  if (reasoning === 'off') return false;
  return /gpt-oss/i.test(model) ? reasoning : true;
}

/** An Ollama user turn with pictures: text content plus bare base64 images. */
function ollamaImages(message: any): any {
  if (!Array.isArray(message.content)) return message;
  const text = message.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n');
  const images = message.content
    .filter((p: any) => p?.type === 'image_url' && typeof p.image_url?.url === 'string')
    .map((p: any) => String(p.image_url.url).replace(/^data:[^,]*,/, ''));
  return { ...message, content: text, ...(images.length ? { images } : {}) };
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
  return ollamaImages(message);
}

async function streamOllama(entry: SavedModel, messages: Message[], onFrame: (f: StreamFrame) => void, signal?: AbortSignal, offered?: any[], reasoning?: string): Promise<void> {
  if (!hasShell()) throw new ApiError(0, 'Ollama is reached through the installed desktop app.');
  if (!runSettings.limitsFor(entry.id)) await detectLimits(entry);
  const values = resolvedValues(entry);
  const think = ollamaThink(entry.name, reasoning);
  const body = JSON.stringify({
    model: entry.name,
    messages: runSettings.withSystem(messages, values).map(forOllama),
    stream: true,
    options: runSettings.ollamaOptions(values),
    ...(think !== undefined ? { think } : {}),
    ...(offered && offered.length ? { tools: offered } : {}),
  });
  let buffer = '';
  let status = 200;
  let failure = '';
  // Reasoning is shown the way every other provider's is: inside <think>.
  let thinking = false;
  const emit = (frame: StreamFrame & { thinking?: string }) => {
    const { thinking: thought, ...rest } = frame;
    if (thought) {
      onFrame({ content: (thinking ? '' : '<think>') + thought, model: rest.model });
      thinking = true;
    }
    if (rest.content || rest.toolCalls || rest.done) {
      if (thinking) { onFrame({ content: '</think>' }); thinking = false; }
      onFrame(rest);
    }
  };
  const drain = (final: boolean) => {
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (status >= 400) { failure += line; continue; }
      const frame = ollamaFrame(line);
      if (frame) emit(frame);
    }
    if (final && buffer.trim()) {
      if (status >= 400) failure += buffer;
      else {
        const frame = ollamaFrame(buffer);
        if (frame) emit(frame);
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
  /** The chat's /reasoning level; Ollama gets it as `think`. */
  reasoning?: string,
): Promise<void> {
  const entry = savedModels.find(provider, model);
  if (!entry) {
    throw new ApiError(0, `${model || 'That model'} is no longer in your models. Add it again in Settings → Local models.`);
  }
  if (entry.kind === 'ollama') return streamOllama(entry, messages, onFrame, signal, offered, reasoning);
  const status = await ensureUnsloth(entry, false, onStage);
  onStage?.('');
  const values = settingsFor(entry);
  const shaped = runSettings.withSystem(messages, values);
  // A turn that offers tools stays on the generic path: llama-server is started
  // with --jinja precisely so it parses a tool call back out of the reply, and
  // a raw completion gives it nothing to parse.
  if (!(offered && offered.length)) {
    const template = await chatTemplateFor(entry);
    if (template) {
      const rendered = chatTemplate.render(template, shaped);
      if (rendered.reason) templateRefused(entry, rendered.reason);
      else if (await streamRendered(status, entry, rendered.prompt, values, onFrame, signal)) return;
    }
  }
  return streamLocalChat(
    status.base_url,
    entry.name,
    shaped,
    onFrame,
    signal,
    status.api_key || undefined,
    { ...runSettings.openaiParams(values), ...(offered && offered.length ? { tools: offered } : {}) },
  );
}
