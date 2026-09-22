import { useCallback, useEffect, useState } from 'react';
import { pushToast } from './Toasts';
import { api } from '../api';
import { authWindowOpen, hasShell, mcpStdioList, mcpStdioStop, onConnectFinished } from '../bridge';
import { startStdio, stdioId } from '../tool-run';
import HfSignIn from './HfSignIn';
import '../tools.js';

const tools: typeof import('../tools.js') = (globalThis as any).FreeAI4UTools;

type McpServer = import('../tools.js').McpServer;

// Connectors, in Settings: what a model in Chat can reach beyond the web.
//
//   * GITHUB is the engine's connector -- the same one the web app has, with
//     the same several-accounts support -- so an account connected here is
//     connected there too. The sign-in happens in a window of this app, not in
//     the system browser: the engine keys the connection to its session cookie,
//     and only a window that shares this app's cookies can carry that session
//     through GitHub and back.
//   * MCP SERVERS are remote (https) servers the engine talks to on the app's
//     behalf, or local (stdio) programs the shell runs on this PC (mcp.rs).
//     Their tools are read when the server is added or started, offered to the
//     model under `mcp__<server>__<tool>`, and ask before they run.

interface Account {
  login: string;
  name?: string;
  avatarUrl?: string;
}

/** What the sign-in window's landing address says: `?gh=same&login=x` or nothing. */
export function landingNote(landed: string): { same: boolean; login: string } {
  const query = String(landed || '').split('?')[1] || '';
  const params = new URLSearchParams(query);
  return { same: params.get('gh') === 'same', login: params.get('login') || '' };
}

export const GITHUB_CHANGED_EVENT = 'freeai4u:github-changed';

/** Placeholder the language-server preset leaves for the person to replace; never a real package name. */
const LSP_PLACEHOLDER = '<package>';

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

export default function ConnectorsCard() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [canAddMore, setCanAddMore] = useState(true);
  const [githubNote, setGithubNote] = useState('');
  const [servers, setServers] = useState<McpServer[]>(() => tools.mcpServers());
  const [toolsOn, setToolsOn] = useState(() => tools.enabled());
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  // Local (stdio) servers.
  const [mode, setMode] = useState<'remote' | 'local'>('remote');
  const [command, setCommand] = useState('');
  const [argsLine, setArgsLine] = useState('');
  const [envText, setEnvText] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [running, setRunning] = useState<string[]>([]);
  const [failures, setFailures] = useState<Record<string, { message: string; stderr: string }>>({});
  const [lspHint, setLspHint] = useState(false);

  const refreshRunning = useCallback(() => {
    mcpStdioList().then(setRunning).catch(() => setRunning([]));
  }, []);
  useEffect(() => { refreshRunning(); }, [refreshRunning]);

  // `announce`: a click on Refresh says what it found, so "nothing happened"
  // and "nothing is connected" can no longer look the same.
  const refreshGithub = useCallback((announce = false): Promise<Account[]> => {
    setBusy((b) => b || 'gh:refresh');
    return api.raw('/api/github/status')
      .then((data: any) => {
        const list: Account[] = Array.isArray(data?.accounts) ? data.accounts : [];
        setAccounts(list);
        setCanAddMore(data?.canAddMore !== false);
        setGithubNote(data?.configured === false ? 'The engine has no GitHub app configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).' : '');
        setCheckedAt(Date.now());
        window.dispatchEvent(new Event(GITHUB_CHANGED_EVENT));
        if (announce) {
          pushToast(list.length ? 'ok' : 'info', list.length
            ? `GitHub: ${list.map((a) => a.login).join(', ')} connected.`
            : 'GitHub: no account connected yet.');
        }
        return list;
      })
      .catch((e: unknown) => {
        const message = ((e as Error).message || String(e)).split('\n')[0];
        setAccounts([]);
        setGithubNote(message);
        if (announce) pushToast('error', `GitHub status failed: ${message}`);
        return [] as Account[];
      })
      .finally(() => setBusy((b) => (b === 'gh:refresh' ? '' : b)));
  }, []);

  useEffect(() => {
    refreshGithub();
    const onTools = () => { setServers(tools.mcpServers()); setToolsOn(tools.enabled()); };
    window.addEventListener(tools.CHANGED_EVENT, onTools);
    let stop = () => {};
    // The sign-in window closes itself when GitHub hands back to the engine.
    onConnectFinished((landed) => {
      const note = landingNote(landed);
      refreshGithub().then((list) => {
        if (note.same) {
          pushToast('warn', `GitHub gave back ${note.login || 'the same account'}, which was already connected. Pick the other account in GitHub's chooser, or sign out of github.com in that window first.`);
        } else if (list.length) {
          pushToast('ok', `GitHub connected: ${list.map((a) => a.login).join(', ')}.`);
        } else {
          pushToast('warn', 'The GitHub window closed but the engine reports no account. Check that you are signed in to the engine, then try again.');
        }
      });
    }).then((off) => { stop = off; });
    return () => { window.removeEventListener(tools.CHANGED_EVENT, onTools); stop(); };
  }, [refreshGithub]);

  // `client=desktop` makes the engine issue a cookie this app's cross-site
  // requests can carry; `add=1` shows GitHub's account chooser instead of
  // silently reusing whoever is signed in at github.com.
  const connectGithub = () => {
    const adding = accounts.length > 0;
    const page = `${api.getServer().replace(/\/+$/, '')}/api/github/authorize?client=desktop${adding ? '&add=1' : ''}`;
    if (hasShell()) {
      authWindowOpen(page).catch((e: unknown) => pushToast('error', ((e as Error).message || String(e)).split('\n')[0]));
    } else {
      window.open(page, '_blank');
    }
  };

  const disconnect = (login: string) => {
    setBusy(`gh:${login}`);
    api.raw(`/api/github/disconnect?account=${encodeURIComponent(login)}`, { method: 'POST' })
      .then(() => pushToast('info', `${login} disconnected.`))
      .catch((e: unknown) => pushToast('error', ((e as Error).message || String(e)).split('\n')[0]))
      .finally(() => { setBusy(''); refreshGithub(); });
  };

  const readTools = (serverName: string, address: string) => {
    setBusy(`mcp:${serverName}`);
    return api.raw('/api/mcp/tools', { method: 'POST', body: JSON.stringify({ url: address }) })
      .then((data: any) => {
        const list = Array.isArray(data?.tools) ? data.tools : [];
        const result = tools.addMcpServer(serverName, address, list);
        if (!result.ok) throw new Error(result.reason);
        pushToast('ok', `${serverName}: ${list.length} tool${list.length === 1 ? '' : 's'}.`);
        setName('');
        setUrl('');
      })
      .catch((e: unknown) => pushToast('error', ((e as Error).message || String(e)).split('\n')[0]))
      .finally(() => setBusy(''));
  };

  const startLocal = (server: McpServer) => {
    setBusy(`mcp:${server.name}`);
    return startStdio(server)
      .then((list) => {
        setFailures((all) => without(all, server.name));
        pushToast('ok', `${server.name} is running: ${list.length} tool${list.length === 1 ? '' : 's'}.`);
      })
      .catch((e: unknown) => {
        const failure = tools.splitStderr((e as Error)?.message || String(e));
        setFailures((all) => ({ ...all, [server.name]: failure }));
        pushToast('error', `${server.name}: ${failure.message.split('\n')[0]}`);
      })
      .finally(() => { setBusy(''); refreshRunning(); });
  };

  const stopLocal = (server: McpServer) => {
    setBusy(`mcp:${server.name}`);
    return mcpStdioStop(stdioId(server))
      .catch(() => undefined)
      .finally(() => { setBusy(''); refreshRunning(); });
  };

  const removeServer = (server: McpServer) => {
    const stop = tools.isStdio(server) && running.includes(stdioId(server)) ? stopLocal(server) : Promise.resolve();
    stop.finally(() => {
      tools.removeMcpServer(server.name);
      setFailures((all) => without(all, server.name));
      pushToast('info', `${server.name} removed.`);
    });
  };

  const addLocal = () => {
    if (argsLine.includes(LSP_PLACEHOLDER) || argsLine.includes('<args>')) {
      pushToast('error', `Replace ${LSP_PLACEHOLDER} (and <args>) with the language-server MCP package you chose.`);
      return;
    }
    setLspHint(false);
    const parsedEnv = tools.parseEnvLines(envText);
    if (parsedEnv.bad.length) {
      pushToast('error', `Not a KEY=VALUE line: ${parsedEnv.bad[0]}`);
      return;
    }
    const row = { name: name.trim(), command: command.trim(), args: tools.splitArgs(argsLine), env: parsedEnv.env };
    const result = tools.addStdioServer(row);
    if (!result.ok) {
      pushToast('error', result.reason || 'That server could not be saved.');
      return;
    }
    setName('');
    setCommand('');
    setArgsLine('');
    setEnvText('');
    const saved = tools.mcpServers().find((s) => tools.slug(s.name) === tools.slug(row.name));
    if (saved && hasShell()) startLocal(saved);
    else pushToast('info', `${row.name} saved. Local servers run in the installed desktop app.`);
  };

  // Presets (roadmap 5.6): one click for a server the built-in agents use. The
  // browser one is Google's Chrome DevTools MCP, run through npx -- the
  // "browser" agent (Library -> Agents) is offered its tools as browser/*.
  // Stagehand is out of scope: it needs its own model key and runtime.
  const addPreset = (row: { name: string; command: string; args: string[] }) => {
    const result = tools.addStdioServer(row);
    if (!result.ok) { pushToast('error', result.reason || 'That server could not be saved.'); return; }
    const saved = tools.mcpServers().find((s) => tools.slug(s.name) === tools.slug(row.name));
    if (saved && hasShell()) startLocal(saved);
    else pushToast('info', `${row.name} saved. Local servers run in the installed desktop app (Node.js needed for npx).`);
  };

  // Language servers over MCP (phase 12e). There is no LSP-over-MCP npm
  // package this app can name with certainty, so this does not add one: it
  // fills the local form with placeholders the person replaces (see
  // docs/desktop.md), and addLocal refuses while a placeholder is left in.
  const prefillLanguageServer = () => {
    setMode('local');
    setName('lsp');
    setCommand('npx');
    setArgsLine(`-y ${LSP_PLACEHOLDER} <args>`);
    setLspHint(true);
  };

  // A pasted config is saved, not run: each local server starts on its own
  // Start, so nothing from a clipboard runs without a second look.
  const importConfig = () => {
    const parsed = tools.parseMcpConfig(pasteText);
    let added = 0;
    parsed.servers.forEach((server) => {
      if (tools.isStdio(server)) {
        if (tools.addStdioServer({ ...server, command: server.command || '' }).ok) added += 1;
      } else if (server.url) {
        readTools(server.name, server.url);
        added += 1;
      }
    });
    if (parsed.errors.length) pushToast('warn', parsed.errors.slice(0, 3).join(' '));
    if (added) {
      pushToast('ok', `Imported ${added} server${added === 1 ? '' : 's'}. Press Start on a local one to run it.`);
      setPasteText('');
      setPasteOpen(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Connectors</h2>
      <div className="settings-card">
        <label className="toggle">
          <input type="checkbox" checked={toolsOn} onChange={(e) => tools.setEnabled(e.target.checked)} />
          Let models in Chat use tools
        </label>
        <p className="settings-hint">
          Web search and reading a page are always offered. Anything that changes something — a file, a command, a
          commit, an MCP tool — shows an Allow / Deny card in the conversation first.
        </p>

        <h3 className="local-heading">GitHub</h3>
        {accounts.length ? (
          <div className="local-catalogue">
            {accounts.map((account) => (
              <div key={account.login} className="local-row">
                <div className="local-row-main">
                  <span className="local-row-name">
                    <span className="mono">{account.login}</span>
                    <span className="chip">connected</span>
                  </span>
                  {account.name && <span className="local-row-note">{account.name}</span>}
                </div>
                <button onClick={() => disconnect(account.login)} disabled={busy === `gh:${account.login}`}>Disconnect</button>
              </div>
            ))}
          </div>
        ) : (
          <p className="settings-hint">No account connected. A model can then list repositories, read and search code, and — with your OK each time — commit.</p>
        )}
        <div className="local-status-row">
          <button onClick={connectGithub} disabled={!canAddMore}>
            {accounts.length ? 'Connect another account' : 'Connect GitHub'}
          </button>
          <button onClick={() => refreshGithub(true)} disabled={busy === 'gh:refresh'}>{busy === 'gh:refresh' ? 'Checking…' : 'Refresh'}</button>
          {checkedAt && (
            <span className="settings-hint">
              {accounts.length} account{accounts.length === 1 ? '' : 's'} · checked {new Date(checkedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        {!canAddMore && <p className="settings-hint">That is the most accounts the engine keeps; disconnect one to add another.</p>}
        {githubNote && <div className="chip-note">{githubNote}</div>}

        <h3 className="local-heading">Hugging Face</h3>
        <p className="settings-hint">For the Hugging Face models in Chat (the Inference Providers router) and gated downloads.</p>
        <HfSignIn showClientId />

        <h3 className="local-heading">MCP servers</h3>
        {servers.length > 0 && (
          <div className="local-catalogue">
            {servers.map((server) => {
              const local = tools.isStdio(server);
              const isRunning = local && running.includes(stdioId(server));
              const failure = failures[server.name];
              const working = busy === `mcp:${server.name}`;
              return (
                <div key={server.name} className="local-row">
                  <div className="local-row-main">
                    <span className="local-row-name">
                      <span className="mono">{server.name}</span>
                      <span className="chip">{server.tools.length} tool{server.tools.length === 1 ? '' : 's'}</span>
                      {local && <span className={`chip ${isRunning ? 'mcp-running' : 'mcp-stopped'}`}>{isRunning ? 'running' : 'stopped'}</span>}
                    </span>
                    <span className="local-row-note mono">
                      {local ? `${server.command} ${tools.joinArgs(server.args || [])}`.trim() : server.url}
                    </span>
                    {failure && (
                      <>
                        <div className="chip-note">{failure.message}</div>
                        {failure.stderr && <pre className="mcp-stderr">{failure.stderr}</pre>}
                      </>
                    )}
                  </div>
                  {local ? (
                    isRunning ? (
                      <button onClick={() => stopLocal(server)} disabled={working}>Stop</button>
                    ) : (
                      <button onClick={() => startLocal(server)} disabled={working || !hasShell()}>{working ? 'Starting…' : 'Start'}</button>
                    )
                  ) : (
                    <button onClick={() => readTools(server.name, server.url || '')} disabled={working}>Refresh</button>
                  )}
                  <button onClick={() => removeServer(server)} disabled={working}>Remove</button>
                </div>
              );
            })}
          </div>
        )}
        <div className="mcp-mode" role="group" aria-label="Kind of MCP server">
          <button type="button" aria-pressed={mode === 'remote'} onClick={() => setMode('remote')}>Remote (https)</button>
          <button type="button" aria-pressed={mode === 'local'} onClick={() => setMode('local')}>On this PC (stdio)</button>
          <button type="button" aria-pressed={pasteOpen} onClick={() => setPasteOpen((o) => !o)}>Paste config JSON</button>
          <button
            type="button"
            onClick={() => addPreset({ name: 'browser', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] })}
            disabled={!!busy || servers.some((s) => tools.slug(s.name) === 'browser')}
            title="Adds npx -y chrome-devtools-mcp@latest as the local server “browser”, for the Browser agent. Passwords are typed by you in the browser, never sent to the model."
          >
            Browser (Chrome DevTools MCP)
          </button>
          <button
            type="button"
            onClick={prefillLanguageServer}
            disabled={!!busy}
            title="Fills in the 'On this PC' form for a language-server (LSP) MCP server. Replace <package> with the npm package you chose — no package is picked for you."
          >
            Language server (LSP) MCP
          </button>
        </div>
        {lspHint && mode === 'local' && (
          <p className="settings-hint">
            Replace <span className="mono">{LSP_PLACEHOLDER}</span> (and <span className="mono">{'<args>'}</span>) with the LSP-over-MCP
            package you want and its options, then Add and start. Its tools reach agents as <span className="mono">lsp/*</span>.
            See docs/desktop.md, "Language servers via MCP".
          </p>
        )}
        {pasteOpen && (
          <div className="mcp-paste">
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={'{"mcpServers": {"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\work"]}}}'}
              spellCheck={false}
              rows={5}
              aria-label="MCP config JSON"
            />
            <button type="button" onClick={importConfig} disabled={!pasteText.trim()}>Import</button>
          </div>
        )}
        {mode === 'remote' ? (
          <form className="local-add" onSubmit={(e) => { e.preventDefault(); readTools(name.trim(), url.trim()); }}>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="MCP server name" style={{ maxWidth: 140 }} />
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" spellCheck={false} aria-label="MCP server address" />
            <button type="submit" disabled={!name.trim() || !url.trim() || !!busy}>{busy.startsWith('mcp:') ? 'Reading…' : 'Add'}</button>
          </form>
        ) : (
          <form className="mcp-local-add" onSubmit={(e) => { e.preventDefault(); addLocal(); }}>
            <div className="local-add">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Local MCP server name" style={{ maxWidth: 140 }} />
              <input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Command (npx, uvx, C:\…\server.exe)" spellCheck={false} aria-label="Command" />
            </div>
            <div className="local-add">
              <input type="text" value={argsLine} onChange={(e) => setArgsLine(e.target.value)} placeholder='Arguments: -y @scope/server "C:\My Folder"' spellCheck={false} aria-label="Arguments" />
            </div>
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={'Environment, one KEY=VALUE per line (optional)'}
              spellCheck={false}
              rows={2}
              aria-label="Environment variables"
            />
            <button type="submit" disabled={!name.trim() || !command.trim() || !!busy}>{busy.startsWith('mcp:') ? 'Starting…' : 'Add and start'}</button>
          </form>
        )}
        <p className="settings-hint">
          {mode === 'remote'
            ? 'Remote (https) servers, reached through the engine.'
            : 'The program is started directly by this app — no shell in between — and stopped when you press Stop or quit. Environment values are stored on this PC with the server.'}
          {!hasShell() && mode === 'local' ? ' Local servers need the installed desktop app.' : ''}
        </p>
      </div>
    </section>
  );
}
