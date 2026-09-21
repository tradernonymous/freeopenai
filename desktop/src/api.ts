// The FreeAI4U engine client. Everything here talks to the FreeAI4U server
// (Railway by default): the same routes the web app and the Android app use,
// so the desktop is a third front end on one backend.
//
// The server base is a setting, not a constant: it lives in localStorage under
// freeai4u.server and is edited in Settings. https only, except localhost --
// the same rule the launcher enforced.
//
// This file is transport: the address, the request, the stream, the route
// table. What an outcome MEANS, and the words for it, belong to connection.js.
// UMD module: loaded for its side effect, read off globalThis.
import './connection.js';

const connection: typeof import('./connection.js') = (globalThis as any).FreeAI4UConnection;

const SERVER_KEY = 'freeai4u.server';
export const DEFAULT_SERVER = 'https://freeopenai-production.up.railway.app';

export function normalizeServer(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && local) return url.origin;
  return null;
}

export function getServer(): string {
  try {
    const saved = localStorage.getItem(SERVER_KEY);
    if (saved) {
      const ok = normalizeServer(saved);
      if (ok) return ok;
    }
  } catch { /* no localStorage: the default stands */ }
  return DEFAULT_SERVER;
}

/** Whether an address has actually been chosen here (vs the built-in default). */
export function serverSaved(): boolean {
  try {
    return !!localStorage.getItem(SERVER_KEY);
  } catch {
    return false;
  }
}

export function setServer(raw: string): string | null {
  const ok = normalizeServer(raw);
  if (!ok) return null;
  try { localStorage.setItem(SERVER_KEY, ok); } catch { /* best effort */ }
  return ok;
}

function base(): string {
  return getServer();
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request(path: string, opts: RequestInit = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
  } catch (err) {
    throw new ApiError(0, connection.classify({ origin: base() }).message);
  }
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth-required'));
    throw new ApiError(401, connection.classify({ status: 401 }).message);
  }
  if (!res.ok) {
    let engineMessage = '';
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') engineMessage = data.error;
    } catch { /* a body that is not JSON says nothing more */ }
    throw new ApiError(res.status, connection.classify({ status: res.status, message: engineMessage }).message);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---- streaming chat -------------------------------------------------------
// POST /api/llm/chat?provider=<id> with stream:true. The server relays the
// upstream SSE body one chunk at a time; tokens already delivered are kept
// when the stream fails mid-way (the server says so with a final SSE error).

export interface StreamFrame {
  content?: string;
  model?: string;
  done?: boolean;
  /** Tool-call deltas (OpenAI shape) or whole calls (Ollama); tools.js collects them. */
  toolCalls?: any[];
}

export async function streamChat(
  provider: string,
  body: { model: string; messages: Array<{ role: string; content: any }>; stream?: boolean; tools?: any[] },
  onFrame: (frame: StreamFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${base()}/api/llm/chat?provider=${encodeURIComponent(provider)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, connection.classify({ origin: base() }).message);
  }
  if (!res.ok) {
    let engineMessage = '';
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') engineMessage = data.error;
    } catch { /* keep the status line */ }
    throw new ApiError(res.status, connection.classify({ status: res.status, message: engineMessage }).message);
  }
  return readStream(res, onFrame);
}

/**
 * The same stream, against a model running on THIS machine.
 *
 * `llama-server` speaks the OpenAI shape at `http://127.0.0.1:<port>/v1`, so
 * this is the same code with a different base and no engine round-trip: the
 * conversation never leaves the computer, and it works with the engine
 * unreachable. The shell's CSP allows exactly this (loopback http only).
 */
export async function streamLocalChat(
  baseUrl: string,
  model: string,
  messages: Array<{ role: string; content: any }>,
  onFrame: (frame: StreamFrame) => void,
  signal?: AbortSignal,
  apiKey?: string,
  /** Sampling fields (temperature, top_p, ...) from the model's run settings. */
  extra?: Record<string, unknown>,
): Promise<void> {
  const origin = String(baseUrl || '').replace(/\/+$/, '');
  if (!origin) throw new ApiError(0, 'No local model server is running.');
  // The shell starts llama-server with a random --api-key so that nothing
  // else on this machine (or a web page in a browser) can use the port.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...(extra || {}), model: model || 'local', messages, stream: true }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, `The local model server at ${origin} is not answering. Start it in Settings → Local models.`);
  }
  if (!res.ok) {
    throw new ApiError(res.status, `The local model server answered ${res.status}.`);
  }
  return readStream(res, onFrame);
}

/** One SSE reader for both transports: engine and local server. */
async function readStream(res: Response, onFrame: (frame: StreamFrame) => void): Promise<void> {
  const type = String(res.headers.get('content-type') || '');
  if (!type.includes('text/event-stream') || !res.body) {
    // A provider answered without a stream: read it whole, still one frame.
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    const called = data?.choices?.[0]?.message?.tool_calls;
    if ((typeof content === 'string' && content) || (Array.isArray(called) && called.length)) {
      onFrame({ content: typeof content === 'string' ? content : undefined, toolCalls: Array.isArray(called) ? called : undefined, done: true });
      return;
    }
    throw new ApiError(res.status, (data && data.error) || connection.messageFor('no-reply'));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failure: string | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        onFrame({ done: true });
        continue;
      }
      try {
        const frame = JSON.parse(payload);
        if (frame && frame.error) {
          failure = typeof frame.error === 'string' ? frame.error : (frame.error.message || 'Stream failed');
          continue;
        }
        const delta = frame?.choices?.[0]?.delta;
        const content = delta && typeof delta.content === 'string' ? delta.content : undefined;
        const called = delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length ? delta.tool_calls : undefined;
        if (content || called) onFrame({ content, toolCalls: called, model: frame?.model });
      } catch { /* a frame that is not JSON says nothing */ }
    }
  }
  if (failure) throw new ApiError(502, failure);
}

// ---- the rest of the engine ----------------------------------------------

export const api = {
  /** Any engine route, with the session and the JSON handling every call gets. */
  raw: (path: string, opts?: RequestInit) => request(path, opts),
  // engine health + auth
  getServer,
  serverSaved,
  health: () => request('/api/health'),
  session: () => request('/api/session'),
  login: (username: string, password: string) => request('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/logout', { method: 'POST' }),

  // providers + models (models are per provider: ?provider=<id>)
  providers: () => request('/api/llm/providers'),
  models: (provider: string) => request(`/api/llm/models?provider=${encodeURIComponent(provider)}`),
  limits: () => request('/api/llm/limits'),

  // One-shot (non-streaming) chat, used by tools that want a complete answer
  // rather than a token stream. The engine requires a model, so this resolves
  // the first free provider/model when the caller does not name one.
  chat: async (messages: Array<{ role: string; content: any }>, model?: string): Promise<any> => {
    const provs = await request('/api/llm/providers');
    const rows: any[] = Array.isArray(provs) ? provs : (Array.isArray(provs?.providers) ? provs.providers : []);
    const row = rows.find((p) => p.free) || rows[0];
    const provider = String(row?.id || '');
    if (!provider) throw new Error('no providers available on the engine');
    let chosen = model;
    if (!chosen) {
      const ms = await request(`/api/llm/models?provider=${encodeURIComponent(provider)}`);
      const list: any[] = Array.isArray(ms) ? ms : (Array.isArray(ms?.models) ? ms.models : []);
      chosen = String(list[0]?.id || list[0] || '');
    }
    if (!chosen) throw new Error(`no models available on provider "${provider}"`);
    return request(`/api/llm/chat?provider=${encodeURIComponent(provider)}`, {
      method: 'POST',
      body: JSON.stringify({ model: chosen, messages }),
    });
  },

  // chat helpers
  skills: () => request('/api/skills'),
  skillContent: (name: string) => request(`/api/skills/content?name=${encodeURIComponent(name)}`),
  fetchUrl: (url: string) => request(`/api/llm/fetch?url=${encodeURIComponent(url)}`),

  // builds: a build is created with the plan text; watch it over SSE; answer
  // approvals and questions through /input; stop it with /cancel.
  buildList: () => request('/api/build/sessions'),
  buildRun: (body: { plan: string; repo?: string; chatId?: string; provider?: string; model?: string }) =>
    request('/api/build/sessions', { method: 'POST', body: JSON.stringify(body) }),
  buildGet: (id: string) => request(`/api/build/sessions/${encodeURIComponent(id)}`),
  buildInput: (id: string, body: { requestId: string; decision?: 'approve' | 'reject'; text?: string }) =>
    request(`/api/build/sessions/${encodeURIComponent(id)}/input`, { method: 'POST', body: JSON.stringify(body) }),
  buildCancel: (id: string) => request(`/api/build/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  buildEvents: (id: string) => `${base()}/api/build/sessions/${encodeURIComponent(id)}/events`,

  // images
  imageProviders: () => request('/api/llm/images/providers'),
  // `provider` is what pins the service. Without it the engine walks its own
  // order, and a model id -- which means different things on different services
  // -- decided the draw instead of the choice on screen.
  imageGenerate: (body: {
    prompt: string;
    provider?: string;
    preferProvider?: string;
    model?: string;
    size?: string;
    quality?: string;
    n?: number;
  }) => request('/api/llm/images/generations', { method: 'POST', body: JSON.stringify(body) }),

  // design
  designTemplates: () => request('/api/design/templates'),
  designProjects: () => request('/api/design/projects'),
  designCreateProject: (body: any) => request('/api/design/projects', { method: 'POST', body: JSON.stringify(body) }),
  designGetProject: (id: string) => request(`/api/design/projects/${encodeURIComponent(id)}`),
  designUpdateProject: (id: string, body: any) => request(`/api/design/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
  designDeleteProject: (id: string) => request(`/api/design/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  designGenerate: (body: any) => request('/api/design/generate', { method: 'POST', body: JSON.stringify(body) }),
  designExport: (body: any) => request('/api/design/export', { method: 'POST', body: JSON.stringify(body) }),
  designBrand: () => request('/api/design/brand'),
  designSaveBrand: (body: any) => request('/api/design/brand', { method: 'POST', body: JSON.stringify(body) }),

  // memory
  memory: () => request('/api/memory'),
  memoryForget: (id: string) => request('/api/memory', { method: 'DELETE', body: JSON.stringify({ id }) }),

  // workspace (Build runs commands here; WORKSPACE_RUN gates it server-side)
  workspaceFiles: () => request('/api/workspace/files'),
  // The engine reads `cwd`; the field this used to send was `path`, which no
  // route reads, so a session's directory was never actually applied.
  workspaceRun: (command: string, cwd?: string) =>
    request('/api/workspace/run', {
      method: 'POST',
      body: JSON.stringify({ command, ...(cwd && cwd !== '.' ? { cwd } : {}) }),
    }),
  workspaceRead: (path: string) => request(`/api/workspace/read?path=${encodeURIComponent(path)}`),

  // github tools (OAuth account connected on the server)
  githubRepos: () => request('/api/github/repos'),
  githubStatus: () => request('/api/github/status'),
};

/** One image URL (or data URL) out of a generations response, or null. */
export function imageUrlFrom(data: any): string | null {
  const first = Array.isArray(data?.data) ? data.data[0] : null;
  if (!first) return null;
  if (typeof first.url === 'string' && first.url) return first.url;
  if (typeof first.b64_json === 'string' && first.b64_json) return 'data:image/png;base64,' + first.b64_json;
  return null;
}
