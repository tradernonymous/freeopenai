import { useCallback, useEffect, useState } from 'react';
import { pushToast } from './Toasts';
import { api } from '../api';
import { authWindowOpen, hasShell, onConnectFinished } from '../bridge';
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
//     behalf. Their tools are read once when the server is added, offered to
//     the model under `mcp__<server>__<tool>`, and ask before they run.

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
        <HfSignIn />

        <h3 className="local-heading">MCP servers</h3>
        {servers.length > 0 && (
          <div className="local-catalogue">
            {servers.map((server) => (
              <div key={server.name} className="local-row">
                <div className="local-row-main">
                  <span className="local-row-name">
                    <span className="mono">{server.name}</span>
                    <span className="chip">{server.tools.length} tool{server.tools.length === 1 ? '' : 's'}</span>
                  </span>
                  <span className="local-row-note mono">{server.url}</span>
                </div>
                <button onClick={() => readTools(server.name, server.url)} disabled={busy === `mcp:${server.name}`}>Refresh</button>
                <button onClick={() => { tools.removeMcpServer(server.name); pushToast('info', `${server.name} removed.`); }}>Remove</button>
              </div>
            ))}
          </div>
        )}
        <form className="local-add" onSubmit={(e) => { e.preventDefault(); readTools(name.trim(), url.trim()); }}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="MCP server name" style={{ maxWidth: 140 }} />
          <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" spellCheck={false} aria-label="MCP server address" />
          <button type="submit" disabled={!name.trim() || !url.trim() || !!busy}>{busy.startsWith('mcp:') ? 'Reading…' : 'Add'}</button>
        </form>
        <p className="settings-hint">
          Remote (https) servers, reached through the engine. A server on this PC (stdio) is a later step — see docs/adr/0001.
        </p>
      </div>
    </section>
  );
}
