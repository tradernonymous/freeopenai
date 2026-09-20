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
