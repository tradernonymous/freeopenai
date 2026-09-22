// One answer from any model the app knows, without tools: the engine's
// providers, Hugging Face, and "my models" (Ollama Local, Unsloth Local).
//
// Chat has its own richer turn (tools, approvals, fallbacks). Quick, Compare
// and Evals only need "this prompt, that model, the text back", and they used
// to be the place three copies of this switch would have drifted apart.
import { streamChat, type StreamFrame } from './api';
import { isSavedProvider, streamSaved } from './run-model';
import './hf-auth.js';
import './hf-inference.js';
import './saved-models.js';

const hfAuth: typeof import('./hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;
const hfInference: typeof import('./hf-inference.js') = (globalThis as any).FreeAI4UHfInference;
const savedModels: typeof import('./saved-models.js') = (globalThis as any).FreeAI4USavedModels;

export interface Target {
  provider: string;
  model: string;
  label: string;
}

type Message = { role: string; content: string };

export function streamAny(target: Target, messages: Message[], onFrame: (frame: StreamFrame) => void, signal?: AbortSignal): Promise<void> {
  if (isSavedProvider(target.provider)) return streamSaved(target.provider, target.model, messages, onFrame, signal);
  if (target.provider === 'hf') {
    return hfInference.streamChat(target.model, messages, onFrame, signal, hfAuth.accessToken()?.access_token || undefined);
  }
  return streamChat(target.provider, { model: target.model, messages }, onFrame, signal);
}

/** The whole reply as text, and how long it took. */
export async function collectReply(target: Target, messages: Message[], signal?: AbortSignal): Promise<{ text: string; ms: number }> {
  const started = Date.now();
  let text = '';
  await streamAny(target, messages, (frame) => { if (frame.content) text += frame.content; }, signal);
  return { text, ms: Date.now() - started };
}

/** Reasoning is shown in chat, but it is not the answer a check should read. */
export function withoutThinking(text: string): string {
  return String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

/**
 * The models worth offering side by side: the current service's models, then
 * everything added under Ollama Local / Unsloth Local.
 */
export function modelTargets(
  providerLabel: (id: string) => string,
  currentProvider: string,
  currentModels: Array<{ id: string }>,
): Target[] {
  const out: Target[] = currentModels.map((m) => ({ provider: currentProvider, model: m.id, label: `${providerLabel(currentProvider)} · ${m.id}` }));
  for (const saved of savedModels.list()) {
    const provider = saved.kind === 'ollama' ? 'ollama-local' : 'unsloth-local';
    if (provider === currentProvider) continue;
    out.push({ provider, model: saved.name, label: `${saved.kind === 'ollama' ? 'Ollama Local' : 'Unsloth Local'} · ${saved.name}` });
  }
  return out;
}
