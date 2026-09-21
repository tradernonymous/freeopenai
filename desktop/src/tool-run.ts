// Running one tool call.
//
// Where each tool lives:
//   * web_search / web_fetch  -> the engine (/api/llm/websearch, /api/llm/fetch)
//   * github_*                -> the engine's multi-account GitHub API, the same
//                                routes the web app's connector uses
//   * mcp__<server>__<tool>   -> the engine's MCP client (/api/mcp/call)
//   * list/read/write/edit/run -> the shell, confined to the folder the person
//                                opened (local.rs enforces the confinement)
//
// By the time a call reaches here it has been allowed (agent-turn.ts asks
// first for anything in tools.ASKS). The result is TEXT for the model: short,
// factual, and an "Error: ..." sentence rather than a throw when the tool
// itself said no -- a model can do something useful with a sentence.
import { api } from './api';
import { editLocalFile, hasShell, listLocalDir, readLocalFile, runLocal, writeLocalFile } from './bridge';
import './tools.js';

const tools: typeof import('./tools.js') = (globalThis as any).FreeAI4UTools;

type ToolCall = import('./tools.js').ToolCall;
type Args = Record<string, any>;

export interface ToolContext {
  /** The folder open in the app, or '' when none is. */
  localRoot: string;
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

async function mcp(name: string, a: Args): Promise<string> {
  const target = tools.mcpTarget(name);
  if (!target) return `Error: no registered MCP server offers ${name}. It may have been removed in Settings → Connectors.`;
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
  if (name.startsWith('github_')) return github(name, args);
  if (name.startsWith('mcp__')) return mcp(name, args);
  if (tools.LOCAL.some((t) => t.function.name === name)) return local(name, args, context.localRoot);
  return `Error: ${name} is not a tool this app has.`;
}
