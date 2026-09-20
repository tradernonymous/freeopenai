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
}): Promise<LocalRunResult> {
  return call<LocalRunResult>('local_run', {
    root: args.root,
    runId: args.runId,
    command: args.command,
    cwd: args.cwd ?? '',
    timeoutMs: args.timeoutMs,
    approveRisky: args.approveRisky ?? false,
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
  port: number;
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
  const w = window as any;
  const internals = w.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function' || typeof internals.transformCallback !== 'function') {
    return () => {};
  }
  const id = internals.transformCallback((payload: LocalRunChunk) => handler(payload), false);
  try {
    await call('plugin:event|listen', { event: 'local-run', target: { kind: 'Any' }, handler: id });
  } catch {
    return () => {};
  }
  return () => {
    call('plugin:event|unlisten', { event: 'local-run', eventId: id }).catch(() => {});
  };
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
