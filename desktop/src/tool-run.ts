// Running one tool call.
//
// Where each tool lives:
//   * web_search / web_fetch  -> the engine (/api/llm/websearch, /api/llm/fetch)
//   * github_*                -> the engine's multi-account GitHub API, the same
//                                routes the web app's connector uses
//   * mcp__<server>__<tool>   -> the engine's MCP client (/api/mcp/call) for a
//                                remote server; `tools/call` over the shell
//                                (mcp.rs) for a local (stdio) one
//   * list/read/write/edit/run -> the shell, confined to the folder the person
//                                opened (local.rs enforces the confinement)
//
// By the time a call reaches here it has been allowed (agent-turn.ts asks
// first for anything in tools.ASKS). The result is TEXT for the model: short,
// factual, and an "Error: ..." sentence rather than a throw when the tool
// itself said no -- a model can do something useful with a sentence.
import { api, ApiError } from './api';
import {
  editLocalFile, hasShell, listLocalDir, mcpStdioList, mcpStdioRequest, mcpStdioStart, readLocalFile, runLocal, writeLocalFile,
} from './bridge';
import './tools.js';

const tools: typeof import('./tools.js') = (globalThis as any).FreeAI4UTools;

type ToolCall = import('./tools.js').ToolCall;
type Args = Record<string, any>;

export interface ToolContext {
  /** The folder open in the app, or '' when none is. */
  localRoot: string;
  /** Runs a sub-agent for `spawn_agent` (ChatScreen owns the runner); absent means none may be spawned. */
  spawnAgent?: (args: Args) => Promise<string>;
}

const q = (value: unknown) => encodeURIComponent(String(value ?? ''));
const opt = (key: string, value: unknown) => (value ? `&${key}=${q(value)}` : '');

function lines(rows: unknown[], each: (row: any) => string, empty: string): string {
  const list = Array.isArray(rows) ? rows : [];
  return list.length ? list.map(each).join('\n') : empty;
}

async function web(name: string, a: Args): Promise<string> {
  if (name === 'web_search') {
    if (!a.query) return 'Error: query is required.';
    const data: any = await api.raw(`/api/llm/websearch?q=${q(a.query)}`);
    const results = Array.isArray(data) ? data : data?.results;
    return lines(results, (r) => `${r.title || r.url}\n${r.url}\n${r.snippet || r.description || ''}\n`, `No results for "${a.query}".`);
  }
  if (!a.url) return 'Error: url is required.';
  const page: any = await api.raw(`/api/llm/fetch?url=${q(a.url)}`);
  return String(page?.text || page?.content || page?.markdown || JSON.stringify(page || {}));
}

async function github(name: string, a: Args): Promise<string> {
  const need = (...keys: string[]) => keys.filter((k) => a[k] == null || a[k] === '');
  const missing = (keys: string[]) => `Error: ${keys.join(' and ')} ${keys.length > 1 ? 'are' : 'is'} required.`;
  if (name === 'github_list_repos') {
    const data: any = await api.raw('/api/github/repos');
    const repos = Array.isArray(data) ? data : data?.repos;
    return lines(repos, (r) => `${r.full_name || r.name}${r.private ? ' (private)' : ''}${r.account ? ` · as ${r.account}` : ''}`, 'No repositories are visible to the connected accounts.');
  }
  if (name === 'github_list_files') {
    if (need('repo').length) return missing(['repo']);
    const data: any = await api.raw(`/api/github/tree?repo=${q(a.repo)}&path=${q(a.path || '')}${opt('branch', a.branch)}${opt('account', a.account)}`);
    const entries = Array.isArray(data) ? data : data?.entries;
    return lines(entries, (e) => `${e.type === 'dir' ? 'dir ' : 'file'}  ${e.path || e.name}`, 'That folder is empty.');
  }
  if (name === 'github_read_file') {
    const miss = need('repo', 'path');
    if (miss.length) return missing(miss);
    const data: any = await api.raw(`/api/github/file?repo=${q(a.repo)}&path=${q(a.path)}${opt('branch', a.branch)}${opt('account', a.account)}`);
    return String(data?.content ?? data?.text ?? '');
  }
  if (name === 'github_search_code') {
    const miss = need('repo', 'query');
    if (miss.length) return missing(miss);
    const data: any = await api.raw(`/api/github/search?repo=${q(a.repo)}&q=${q(a.query)}${opt('account', a.account)}`);
    return lines(Array.isArray(data) ? data : data?.items, (r) => `${r.path}${r.url ? `  ${r.url}` : ''}`, `No code in ${a.repo} matches "${a.query}".`);
  }
  if (name === 'github_list_commits') {
    if (need('repo').length) return missing(['repo']);
    const data: any = await api.raw(`/api/github/commits?repo=${q(a.repo)}&path=${q(a.path || '')}${opt('account', a.account)}`);
    return lines(Array.isArray(data) ? data : data?.commits, (c) => `${String(c.sha || '').slice(0, 7)}  ${c.date || ''}  ${c.author || ''}  ${c.message || ''}`, `No commits found in ${a.repo}.`);
  }
  if (name === 'github_list_branches') {
    if (need('repo').length) return missing(['repo']);
    const data: any = await api.raw(`/api/github/branches?repo=${q(a.repo)}${opt('account', a.account)}`);
    return lines(Array.isArray(data) ? data : data?.branches, (b) => `${b.name || b}${b.default ? ' (default)' : ''}`, `${a.repo} has no branches yet.`);
  }
  const json = (method: string, path: string, body: Args) =>
    api.raw(path, { method, body: JSON.stringify(body) }) as Promise<any>;
  if (name === 'github_create_branch') {
    const miss = need('repo', 'branch');
    if (miss.length) return missing(miss);
    const data = await json('POST', '/api/github/branch', { repo: a.repo, branch: a.branch, from: a.from, account: a.account });
    return `Created branch ${a.branch} in ${a.repo}${data?.account ? ` as ${data.account}` : ''}.`;
  }
  if (name === 'github_commit_file') {
    const miss = need('repo', 'path');
    if (miss.length || typeof a.content !== 'string') return missing(miss.length ? miss : ['content']);
    const data = await json('PUT', '/api/github/file', {
      repo: a.repo, path: a.path, content: a.content, message: a.message || `Update ${a.path}`, branch: a.branch, account: a.account,
    });
    return `Committed ${a.path}${data?.account ? ` as ${data.account}` : ''}. ${data?.commitUrl || ''}`.trim();
  }
  if (name === 'github_delete_file') {
    const miss = need('repo', 'path');
    if (miss.length) return missing(miss);
    const data = await json('DELETE', '/api/github/file', {
      repo: a.repo, path: a.path, message: a.message || `Delete ${a.path}`, branch: a.branch, account: a.account,
    });
    return `Deleted ${a.path}${data?.account ? ` as ${data.account}` : ''}. ${data?.commitUrl || ''}`.trim();
  }
  return `Error: ${name} is not a GitHub tool this app has.`;
}

async function local(name: string, a: Args, root: string): Promise<string> {
  if (!hasShell()) return 'Error: files and commands on this PC need the installed desktop app.';
  if (!root) return 'Error: no folder is open. Ask the user to open one (Local → Open folder).';
  if (name === 'list_files') {
    const listing = await listLocalDir(root, String(a.path || ''));
    return lines(listing.entries, (e) => `${e.dir ? 'dir ' : 'file'}  ${e.path}${e.dir ? '' : `  (${e.size} bytes)`}`, 'That folder is empty.')
      + (listing.capped ? '\n[the listing was capped]' : '');
  }
  if (name === 'read_file') {
    if (!a.path) return 'Error: path is required.';
    const file = await readLocalFile(root, String(a.path));
    if (file.binary) return `${file.path} is a binary file (${file.bytes} bytes); it cannot be read as text.`;
    return file.text + (file.truncated ? '\n[the file was truncated]' : '');
  }
  if (name === 'write_file') {
    if (!a.path || typeof a.content !== 'string') return 'Error: path and content are required.';
    const out = await writeLocalFile(root, String(a.path), a.content);
    return `Wrote ${out.path} (${out.bytes} bytes).`;
  }
  if (name === 'edit_file') {
    if (!a.path || typeof a.old_text !== 'string' || typeof a.new_text !== 'string') return 'Error: path, old_text and new_text are required.';
    const out = await editLocalFile({ root, path: String(a.path), oldText: a.old_text, newText: a.new_text });
    return out.replaced ? `Edited ${out.path}: ${out.replaced} replacement(s).` : `Error: old_text was not found in ${a.path}; nothing changed.`;
  }
  if (name === 'run_command') {
    if (!a.command) return 'Error: command is required.';
    // The person allowed this exact command on its card, which is what the
    // shell's own risk gate asks for.
    const run = await runLocal({
      root,
      runId: `t${Date.now().toString(36)}`,
      command: String(a.command),
      cwd: a.cwd ? String(a.cwd) : '',
      approveRisky: true,
    });
    const tail = (s: string) => (s.length > 6000 ? `[...]\n${s.slice(-6000)}` : s);
    return [
      `exit code: ${run.timedOut ? 'timed out' : run.exitCode}`,
      run.stdout ? `stdout:\n${tail(run.stdout)}` : '',
      run.stderr ? `stderr:\n${tail(run.stderr)}` : '',
    ].filter(Boolean).join('\n');
  }
  return `Error: ${name} is not a local tool this app has.`;
}

type McpServer = import('./tools.js').McpServer;
type McpTool = import('./tools.js').McpTool;

/** A local server's shell id: the same slug its tool names carry. */
export const stdioId = (server: McpServer) => tools.slug(server.name);

/**
 * Start (or restart) a local server, read its tools (every page of them) and
 * cache them on its row. Throws the shell's error -- stderr tail included --
 * when it cannot start.
 */
export async function startStdio(server: McpServer): Promise<McpTool[]> {
  if (!hasShell()) throw new Error('A local MCP server needs the installed desktop app.');
  const id = stdioId(server);
  await mcpStdioStart({ id, command: server.command || '', args: server.args, env: server.env, cwd: server.cwd });
  const list: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result: any = await mcpStdioRequest(id, 'tools/list', cursor ? { cursor } : {});
    for (const t of Array.isArray(result?.tools) ? result.tools : []) {
      if (!t || !t.name) continue;
      const row: McpTool = { name: String(t.name), description: String(t.description || ''), inputSchema: t.inputSchema || {} };
      // `_meta` carries an MCP App's ui:// resource (tools.uiResourceOf).
      if (t._meta && typeof t._meta === 'object' && !Array.isArray(t._meta)) row._meta = t._meta;
      list.push(row);
    }
    cursor = result?.nextCursor ? String(result.nextCursor) : undefined;
    if (!cursor) break;
  }
  tools.setMcpTools(server.name, list);
  return list;
}

// The last few raw `tools/call` results by call id, for an MCP App's
// `ui/notifications/tool-result` (the model only ever sees the text). Session
// memory only; a card from an earlier session falls back to that text.
const rawResults = new Map<string, any>();

/** The raw result of an MCP call this session, or undefined. */
export function mcpCallResult(callId: string): any {
  return rawResults.get(callId);
}

async function ensureStdio(server: McpServer): Promise<string> {
  const id = stdioId(server);
  if (!(await mcpStdioList()).includes(id)) await startStdio(server);
  return id;
}

/** `tools/call` over the shell; the server is started first if it is not running. */
async function mcpStdio(server: McpServer, tool: string, a: Args, callId: string): Promise<string> {
  if (!hasShell()) return 'Error: a local MCP server needs the installed desktop app.';
  const id = await ensureStdio(server);
  const result: any = await mcpStdioRequest(id, 'tools/call', { name: tool, arguments: a }, 120_000);
  if (callId) {
    rawResults.set(callId, result);
    if (rawResults.size > 50) rawResults.delete(rawResults.keys().next().value as string);
  }
  const text = tools.mcpResultText(result);
  return result?.isError ? `Error: ${text}` : text;
}

/**
 * The MCP App behind an mcp__ tool: its `ui://` resource and server. A local
 * (stdio) server is read over the shell; a remote one through the engine's
 * /api/mcp/resource, which forwards `resources/read` (ui:// only).
 */
export function mcpAppFor(name: string): { uri: string; stdio: boolean; server: McpServer } | null {
  const target = tools.mcpTarget(name);
  if (!target) return null;
  const tool = (target.server.tools || []).find((t) => t.name === target.tool);
  const uri = tools.uiResourceOf(tool);
  return uri ? { uri, stdio: tools.isStdio(target.server), server: target.server } : null;
}

const appCache = new Map<string, Promise<string>>();

/**
 * `resources/read` on a remote server, through the engine. An engine from
 * before /api/mcp/resource answers 404 (or 405 for an unknown POST).
 */
async function readRemoteResource(server: McpServer, uri: string): Promise<any> {
  try {
    return await api.raw('/api/mcp/resource', {
      method: 'POST',
      body: JSON.stringify({ url: server.url, uri }),
    });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
      throw new Error('Update the engine to show this app.');
    }
    throw e;
  }
}

/** An MCP App's HTML via `resources/read`, cached per server + uri for the session. Throws with a reason. */
export function readMcpApp(name: string): Promise<string> {
  const app = mcpAppFor(name);
  if (!app) return Promise.reject(new Error('This tool has no app.'));
  if (app.stdio && !hasShell()) return Promise.reject(new Error('A local MCP server needs the installed desktop app.'));
  const key = `${stdioId(app.server)} ${app.uri}`;
  let pending = appCache.get(key);
  if (!pending) {
    pending = (async () => {
      const result: any = app.stdio
        ? await mcpStdioRequest(await ensureStdio(app.server), 'resources/read', { uri: app.uri }, 30_000)
        : await readRemoteResource(app.server, app.uri);
      const out = tools.appHtmlFrom(result);
      if (!out.html) throw new Error(out.reason);
      return out.html;
    })();
    // A failure is not remembered: the next look tries again.
    pending.catch(() => appCache.delete(key));
    appCache.set(key, pending);
  }
  return pending;
}

async function mcp(name: string, a: Args, callId = ''): Promise<string> {
  const target = tools.mcpTarget(name);
  if (!target) return `Error: no registered MCP server offers ${name}. It may have been removed in Settings → Connectors.`;
  if (tools.isStdio(target.server)) return mcpStdio(target.server, target.tool, a, callId);
  const data: any = await api.raw('/api/mcp/call', {
    method: 'POST',
    body: JSON.stringify({ url: target.server.url, tool: target.tool, arguments: a }),
  });
  const text = String(data?.text ?? '');
  return data?.isError ? `Error: ${text}` : text;
}

/** Run one allowed call and return what the model should be told. */
export async function executeTool(call: ToolCall, args: Args, context: ToolContext): Promise<string> {
  const name = call.name;
  if (name === 'web_search' || name === 'web_fetch') return web(name, args);
  if (name === 'spawn_agent') return context.spawnAgent ? context.spawnAgent(args) : 'Error: no sub-agent may be spawned here.';
  if (name.startsWith('github_')) return github(name, args);
  if (name.startsWith('mcp__')) return mcp(name, args, call.id);
  if (tools.LOCAL.some((t) => t.function.name === name)) return local(name, args, context.localRoot);
  return `Error: ${name} is not a tool this app has.`;
}
