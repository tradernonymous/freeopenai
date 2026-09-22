// The one place that talks to the Rust shell.
//
// Under Tauri the runtime injects __TAURI_INTERNALS__.invoke; in a plain browser
// (vite dev, or the web build) there is no shell at all. Every caller asks
// hasShell() first, so a screen degrades to a browser behaviour instead of
// throwing — and no other file has to know how the bridge is spelled.

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function bridge(): Invoke | null {
  const w = window as any;
  const internals = w.__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === 'function') return internals.invoke.bind(internals);
  return null;
}

export function hasShell(): boolean {
  return bridge() !== null;
}

export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = bridge();
  if (!invoke) throw new Error('this build has no desktop shell');
  return (await invoke(command, args ?? {})) as T;
}

export interface RemoteResponse {
  status: number;
  body: string;
}

export async function remoteGet(url: string): Promise<RemoteResponse> {
  return call<RemoteResponse>('remote_get', { url });
}

export interface DownloadResult {
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  /** True only when the digest was checked against a published one. */
  verified: boolean;
}

export async function downloadVerified(args: {
  url: string;
  name: string;
  sha256: string;
}): Promise<DownloadResult> {
  return call<DownloadResult>('remote_download', {
    url: args.url,
    name: args.name,
    sha256: args.sha256,
  });
}

export async function runInstaller(path: string): Promise<void> {
  await call('run_installer', { path });
}

export interface DiagnosticsFacts {
  version: string;
  os: string;
  arch: string;
  webview2: string;
  log_path: string;
  log_bytes: number;
  log_tail: string;
  data_dir: string;
  cache_dir: string;
}

export async function diagnosticsFacts(): Promise<DiagnosticsFacts> {
  return call<DiagnosticsFacts>('diagnostics');
}

// ---- the local folder ----------------------------------------------------
//
// Real paths on this machine, confined to one folder by the shell (src-tauri/
// src/local.rs). The frontend's copy of those rules is src/local-fs.js, and the
// two lists are asserted identical in test/desktop-local.test.js.

export interface LocalEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  ext: string;
}

export interface LocalListing {
  path: string;
  absolute: string;
  entries: LocalEntry[];
  capped: boolean;
}

export interface LocalFile {
  path: string;
  absolute: string;
  bytes: number;
  binary: boolean;
  truncated: boolean;
  text: string;
}

export interface LocalRunResult {
  runId: string;
  command: string;
  cwd: string;
  absoluteCwd: string;
  /** True when the run happened in the shell's throwaway folder. */
  sandbox?: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface LocalRunChunk {
  runId: string;
  stream: 'stdout' | 'stderr';
  text?: string;
  done?: boolean;
}

/** The native folder picker; null when it is cancelled. */
export async function pickFolder(): Promise<string | null> {
  return (await call<string | null>('local_pick_folder')) ?? null;
}

export async function listLocalDir(root: string, path = ''): Promise<LocalListing> {
  return call<LocalListing>('local_list_dir', { root, path });
}

export async function readLocalFile(root: string, path: string): Promise<LocalFile> {
  return call<LocalFile>('local_read_file', { root, path });
}

export async function writeLocalFile(root: string, path: string, content: string): Promise<{ path: string; bytes: number }> {
  return call('local_write_file', { root, path, content });
}

export async function editLocalFile(args: {
  root: string;
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}): Promise<{ path: string; replaced: number; bytes: number }> {
  return call('local_edit_file', {
    root: args.root,
    path: args.path,
    oldText: args.oldText,
    newText: args.newText,
    replaceAll: args.replaceAll ?? false,
  });
}

export async function runLocal(args: {
  root: string;
  runId: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  approveRisky?: boolean;
  /**
   * Run in a fresh, empty folder the shell deletes afterwards instead of in
   * the open project. Not a security boundary -- the command still runs as the
   * user -- but nothing it writes lands in the folder being worked on.
   */
  sandbox?: boolean;
}): Promise<LocalRunResult> {
  return call<LocalRunResult>('local_run', {
    root: args.root,
    runId: args.runId,
    command: args.command,
    cwd: args.cwd ?? '',
    timeoutMs: args.timeoutMs,
    approveRisky: args.approveRisky ?? false,
    sandbox: args.sandbox ?? false,
  });
}

/**
 * Live output from a running local command.
 *
 * This goes through Tauri's own event plugin (`plugin:event|listen`), which is
 * the same call @tauri-apps/api makes -- the app deliberately carries no
 * frontend dependency on it. Nothing depends on it for CORRECTNESS: runLocal
 * returns the settled output either way, so if this subscription is ever
 * refused the terminal shows the whole result when the command finishes
 * instead of nothing at all.
 */
// ---- the local model server (llama.cpp) ---------------------------------
//
// The binary is the user's: this app neither ships one nor downloads one
// behind their back. `find` says where it looks, `pick` takes the file they
// chose, and `openReleases` opens the page to get it from.

export interface LocalServerFacts {
  found: boolean;
  path: string;
  source: string;
  expected_name: string;
  releases_url: string;
  dir: string;
}

export interface LocalModelStatus {
  state: 'stopped' | 'starting' | 'ready' | 'error';
  repo: string;
  quant: string;
  /** The file it was started from, when it was a file and not a -hf spec. */
  file: string;
  port: number;
  /** The bearer token the server was started with; every request must carry it. */
  api_key: string;
  pid: number;
  uptime_ms: number;
  base_url: string;
  detail: string;
}

export async function localServerFind(): Promise<LocalServerFacts> {
  return call<LocalServerFacts>('local_server_find');
}

/** The native picker; resolves with the source path, or null if cancelled. */
export async function localServerPick(): Promise<string | null> {
  return (await call<string | null>('local_server_pick')) ?? null;
}

export async function localServerUse(path: string): Promise<{ path: string; bytes: number }> {
  return call('local_server_use', { path });
}

/** Opens the llama.cpp release page in the user's browser. */
export async function localOpenReleases(): Promise<void> {
  await call('local_open_releases');
}

export async function localModelStart(args: {
  repo: string;
  quant?: string;
  /** A file in the models folder, or an absolute path the scan found. Wins over repo. */
  file?: string;
  port?: number;
  ctx?: number;
  gpuLayers?: number;
  threads?: number;
}): Promise<LocalModelStatus> {
  return call<LocalModelStatus>('local_model_start', args);
}

export async function localModelStatus(): Promise<LocalModelStatus> {
  return call<LocalModelStatus>('local_model_status');
}

export async function localModelStop(): Promise<{ stopped: boolean }> {
  return call('local_model_stop');
}

export async function onLocalRun(handler: (chunk: LocalRunChunk) => void): Promise<() => void> {
  return subscribe<LocalRunChunk>('local-run', handler);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
  return String((input as Request).url || '');
}

// A fetch-shaped wrapper around remote_get, so update.js's retry/backoff logic
// runs unchanged over the shell instead of the webview. Typed to match `fetch`
// so it can be passed wherever a fetch implementation is expected.
export async function shellFetch(input: RequestInfo | URL): Promise<Response> {
  const res = await remoteGet(urlOf(input));
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    json: async () => JSON.parse(res.body),
    text: async () => res.body,
  } as unknown as Response;
}

// ---- opening a page in the user's browser --------------------------------
//
// The shell refuses anything that is not https on a short host list (net.rs
// OPEN_HOSTS): this is for sign-in pages and release pages, not a launcher.
export async function openUrl(url: string): Promise<void> {
  await call('open_url', { url });
}

// ---- the weights themselves ---------------------------------------------
//
// Downloaded by the shell into <app data>/models with progress events
// (`local-download`), resumed from a .part if they stopped, and listed from
// there -- or found where another tool (Unsloth Studio, the Hugging Face
// cache, LM Studio) already put them.

export interface LocalModelFile {
  file: string;
  path: string;
  bytes: number;
  /** A .part a download left behind: resumable, not runnable. */
  partial: boolean;
}

export interface LocalDownloadProgress {
  repo: string;
  file: string;
  received: number;
  total: number;
  done: boolean;
  cancelled: boolean;
  error: string;
  path: string;
}

export async function localModelDownload(args: { repo: string; file: string; token?: string }): Promise<{
  path: string;
  bytes: number;
  resumed?: boolean;
  already?: boolean;
  cancelled?: boolean;
}> {
  return call('local_model_download', { repo: args.repo, file: args.file, token: args.token ?? null });
}

export async function localModelDownloadCancel(): Promise<{ cancelling: boolean; file: string }> {
  return call('local_model_download_cancel');
}

export async function localModelsList(): Promise<{ dir: string; files: LocalModelFile[] }> {
  return call('local_models_list');
}

export async function localModelDelete(file: string): Promise<{ removed: number }> {
  return call('local_model_delete', { file });
}

export async function localModelsScan(dirs?: string[]): Promise<{ dirs: string[]; files: LocalModelFile[] }> {
  return call('local_models_scan', { dirs: dirs ?? [] });
}

/** Subscribe to a shell event through Tauri's event plugin (see onLocalRun). */
async function subscribe<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const w = window as any;
  const internals = w.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function' || typeof internals.transformCallback !== 'function') {
    return () => {};
  }
  // Tauri 2 hands a listener the whole Event ({ event, id, payload }), not the
  // payload: every subscriber here used to receive that wrapper, so Ollama
  // chunks, download progress, deep links and the GitHub "finished" signal
  // arrived as the wrong shape. Either shape is accepted.
  const id = internals.transformCallback((message: any) => {
    const wrapped = message && typeof message === 'object' && 'payload' in message && 'event' in message;
    handler((wrapped ? message.payload : message) as T);
  }, false);
  let eventId: unknown;
  try {
    // listen answers with the id unlisten wants -- not the callback's id.
    eventId = await call('plugin:event|listen', { event, target: { kind: 'Any' }, handler: id });
  } catch {
    return () => {};
  }
  return () => {
    call('plugin:event|unlisten', { event, eventId }).catch(() => {});
  };
}

export function onLocalDownload(handler: (progress: LocalDownloadProgress) => void): Promise<() => void> {
  return subscribe<LocalDownloadProgress>('local-download', handler);
}

/** neuraos:// links handed over by the shell, as a list of URLs. */
export function onDeepLink(handler: (urls: string[]) => void): Promise<() => void> {
  return subscribe<string[]>('deep-link', (payload) => handler(Array.isArray(payload) ? payload : [String(payload)]));
}

// ---- secrets ---------------------------------------------------------------
//
// The OS credential store (secrets.rs). Keys are the app's own short names;
// a value is whatever string the caller stores (the HF token JSON).

export async function secretGet(key: string): Promise<string | null> {
  return (await call<string | null>('secret_get', { key })) ?? null;
}

export async function secretSet(key: string, value: string): Promise<void> {
  await call('secret_set', { key, value });
}

export async function secretDelete(key: string): Promise<void> {
  await call('secret_delete', { key });
}

// ---- Puter sign-in ----------------------------------------------------------
//
// Puter's sign-in page renders nothing without a referrer, and a URL launched
// by the OS has none. The shell serves a one-line redirect page on 127.0.0.1
// and opens that, so the browser arrives at Puter from a page (net.rs).
export async function puterSigninOpen(url: string): Promise<void> {
  await call('puter_signin_open', { url });
}

// ---- Ollama, and streaming from a model server on this machine ------------------
//
// All of it goes through the shell (ollama.rs): Ollama refuses a Tauri
// window's origin, and the shell checks that every address is loopback.

export async function ollamaTags(base?: string): Promise<any> {
  return call('ollama_tags', { base: base ?? null });
}

export async function ollamaPs(base?: string): Promise<any> {
  return call('ollama_ps', { base: base ?? null });
}

export async function ollamaEject(base: string, model: string): Promise<void> {
  await call('ollama_eject', { base: base || null, model });
}

export async function ollamaStart(base?: string): Promise<{ started: boolean; running: boolean }> {
  return call('ollama_start', { base: base ?? null });
}

interface ShellChatEvent {
  id: string;
  status?: number;
  chunk?: string;
  done?: boolean;
  cancelled?: boolean;
  error?: string;
}

/**
 * POST a JSON body to a model server on this machine and receive the reply a
 * chunk at a time. Resolves when the body ends; rejects with AbortError when
 * `signal` fires (the shell is told to stop reading too).
 */
export async function shellPostStream(
  args: { url: string; body: string; apiKey?: string },
  onChunk: (text: string) => void,
  onStatus?: (status: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let settle: (error?: Error) => void = () => {};
  const finished = new Promise<void>((resolve, reject) => {
    settle = (error) => (error ? reject(error) : resolve());
  });
  const stop = await subscribe<ShellChatEvent>('shell-chat', (event) => {
    if (!event || event.id !== id) return;
    if (typeof event.status === 'number') onStatus?.(event.status);
    if (typeof event.chunk === 'string') onChunk(event.chunk);
    if (event.error) settle(new Error(event.error));
    else if (event.done) settle();
  });
  const onAbort = () => {
    call('shell_chat_cancel', { id }).catch(() => {});
    const error = new Error('aborted');
    error.name = 'AbortError';
    settle(error);
  };
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort);
  // The command resolves when the stream ends, but events can still be in
  // flight at that moment: the `done` event is what finishes this, and a
  // command failure (refused address, nothing listening) is an error.
  call('shell_chat_stream', { id, url: args.url, body: args.body, apiKey: args.apiKey ?? null })
    .catch((e: unknown) => settle(e instanceof Error ? e : new Error(String(e))));
  try {
    await finished;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    stop();
  }
}

// ---- connecting an account in a window of this app --------------------------
//
// The engine keys a GitHub connection to its session cookie. The system browser
// has a different cookie jar, so the sign-in happens in a second window of this
// app (same cookies), which the shell closes when GitHub hands back (net.rs).
export async function authWindowOpen(url: string): Promise<void> {
  await call('auth_window_open', { url });
}

/** The sign-in window closed; `landed` is where the engine sent it (path + query). */
export function onConnectFinished(handler: (landed: string) => void): Promise<() => void> {
  return subscribe<string>('connect-finished', (landed) => handler(String(landed || '')));
}

// ---- Phase 5: Quick window and notifications ------------------------------
//
// quick.rs. The Quick window is the same frontend in a window labelled
// "quick"; `?quick=1` lets a plain browser (vite dev) show it too.

/** Whether this frontend is running in the Quick window. */
export function isQuickWindow(): boolean {
  try {
    const label = (window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
    if (label) return label === 'quick';
  } catch { /* not under the shell */ }
  return new URLSearchParams(window.location.search).get('quick') === '1';
}

/** Take a new global hotkey for the Quick window ("alt+space", "ctrl+shift+k"). */
export async function quickHotkeySet(combo: string): Promise<string> {
  return call<string>('quick_hotkey_set', { combo });
}

export async function quickHide(): Promise<void> {
  if (hasShell()) await call('quick_hide');
}

export async function mainShow(): Promise<void> {
  if (hasShell()) await call('main_show');
}

/** A system notification when the main window is not in front; false when not shown. */
export async function notifyUser(title: string, body: string): Promise<boolean> {
  if (!hasShell()) return false;
  try {
    return await call<boolean>('notify', { title, body });
  } catch {
    return false;
  }
}
