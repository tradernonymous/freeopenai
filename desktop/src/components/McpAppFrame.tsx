import { useEffect, useRef, useState } from 'react';
import { executeTool, mcpAppFor, mcpCallResult, readMcpApp } from '../tool-run';
import { hasShell, openUrl } from '../bridge';
import { pushToast } from './Toasts';
import '../tools.js';

// An MCP App, drawn under the tool call that produced it.
//
// The server hands over a `ui://` HTML resource (tool-run.ts readMcpApp); it is
// somebody else's code, so it runs in an iframe sandboxed to `allow-scripts`
// ONLY -- never allow-same-origin -- which gives it an opaque origin: no app
// storage, no cookies, no reaching into this window. Everything it may do goes
// through postMessage JSON-RPC, and this component is the other end:
//
//   view -> host  ui/initialize                  reply with hostContext (theme...)
//                 ui/notifications/initialized   host sends tool-input, tool-result
//                 tools/call                     same server only, same approval as Chat
//                 ui/open-link                   http(s) only, after the person says yes
//                 ui/message                     into the composer draft, never sent
//                 ui/notifications/size-changed  height, clamped
//   host -> view  ui/notifications/tool-input, ui/notifications/tool-result,
//                 ui/notifications/host-context-changed (theme)
//
// A message counts only when `event.source` is this frame's own window.

const tools: typeof import('../tools.js') = (globalThis as any).FreeAI4UTools;

/**
 * ui/message lands here: `detail: { text }`, cancelable. The composer should
 * append `text` to its draft (not send it) and call preventDefault(); when no
 * listener does, the text is copied to the clipboard instead.
 */
export const COMPOSER_INSERT_EVENT = 'freeai4u:composer-insert';

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 900;
const PROTOCOL = '2026-01-26';

export function clampHeight(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(n)));
}

/** Only http(s) links leave the app. */
export function isWebLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function messageText(params: any): string {
  if (typeof params?.text === 'string') return params.text;
  const content = Array.isArray(params?.content) ? params.content : params?.content ? [params.content] : [];
  return content.filter((c: any) => c && c.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n');
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

type Answer = 'allow' | 'always' | 'deny';

interface Ask {
  text: string;
  always: boolean;
  resolve: (answer: Answer) => void;
}

interface Props {
  /** The mcp__ name of the call the app belongs to. */
  toolName: string;
  callId: string;
  args: Record<string, any>;
  /** The call's text result (what the model was told). */
  result?: string;
}

export default function McpAppFrame({ toolName, callId, args, result }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState('');
  const [problem, setProblem] = useState('');
  const [height, setHeight] = useState(240);
  const [ask, setAsk] = useState<Ask | null>(null);
  const latest = useRef({ toolName, callId, args, result });
  latest.current = { toolName, callId, args, result };
  const sent = useRef({ initialized: false, input: false, result: false });
  const askRef = useRef<Ask | null>(null);
  const flush = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    setHtml('');
    setProblem('');
    readMcpApp(toolName).then(
      (text) => { if (!cancelled) setHtml(text); },
      (err) => { if (!cancelled) setProblem((err as Error)?.message || String(err)); },
    );
    return () => { cancelled = true; };
  }, [toolName]);

  useEffect(() => {
    if (!html) return undefined;
    sent.current = { initialized: false, input: false, result: false };
    let fallback: ReturnType<typeof setTimeout> | undefined;

    const post = (message: Record<string, any>) => {
      // An opaque-origin frame can only be addressed with '*'; `source` is
      // checked on the way in, and nothing secret goes out.
      frame.current?.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*');
    };
    const reply = (id: string | number, value: any) => post({ id, result: value });
    const fail = (id: string | number, code: number, message: string) => post({ id, error: { code, message } });

    const sendToolData = () => {
      const now = latest.current;
      if (!sent.current.input) {
        sent.current.input = true;
        post({ method: 'ui/notifications/tool-input', params: { arguments: now.args || {} } });
      }
      if (!sent.current.result && now.result != null) {
        sent.current.result = true;
        const raw = mcpCallResult(now.callId);
        post({
          method: 'ui/notifications/tool-result',
          params: raw ?? { content: [{ type: 'text', text: now.result }], isError: now.result.startsWith('Error:') },
        });
      }
    };
    flush.current = sendToolData;

    const askPerson = (text: string, always: boolean) => new Promise<Answer>((resolve) => {
      const row: Ask = {
        text,
        always,
        resolve: (answer) => { askRef.current = null; setAsk(null); resolve(answer); },
      };
      askRef.current?.resolve('deny');
      askRef.current = row;
      setAsk(row);
    });

    const callTool = async (id: string | number, params: any) => {
      const app = mcpAppFor(latest.current.toolName);
      const name = typeof params?.name === 'string' ? params.name : '';
      if (!app || !name) return fail(id, -32602, 'tools/call needs a tool name.');
      // Only a tool of the same server, found in its registered list.
      const full = tools.mcpToolName(app.server.name, name);
      const target = tools.mcpTarget(full);
      if (!target || tools.slug(target.server.name) !== tools.slug(app.server.name)) {
        return fail(id, -32602, `${name} is not a tool of ${app.server.name}.`);
      }
      const callArgs = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
      // The same approval rule a model's call goes through (agent-turn.ts).
      const why = tools.needsApproval(full);
      if (why) {
        const answer = await askPerson(`The app wants to run ${name} on ${app.server.name}: it ${why}.`, true);
        if (answer === 'deny') return fail(id, -32000, 'The user declined this action.');
        if (answer === 'always') tools.setAlways(full);
      }
      const runId = `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      try {
        const text = await executeTool({ id: runId, name: full, arguments: JSON.stringify(callArgs) }, callArgs, { localRoot: '' });
        return reply(id, mcpCallResult(runId) ?? { content: [{ type: 'text', text }], isError: text.startsWith('Error:') });
      } catch (err) {
        return fail(id, -32000, (err as Error)?.message || String(err));
      }
    };

    const openLink = async (id: string | number, params: any) => {
      const url = typeof params?.url === 'string' ? params.url.trim() : '';
      if (!isWebLink(url)) return fail(id, -32602, 'Only http(s) links can be opened.');
      const answer = await askPerson(`The app wants to open ${url}`, false);
      if (answer === 'deny') return fail(id, -32000, 'The user declined to open the link.');
      if (!hasShell()) return fail(id, -32000, 'Opening links needs the installed desktop app.');
      try {
        await openUrl(url);
        return reply(id, {});
      } catch (err) {
        return fail(id, -32000, (err as Error)?.message || String(err));
      }
    };

    const insertMessage = async (id: string | number, params: any) => {
      const text = messageText(params).trim();
      if (!text) return fail(id, -32602, 'ui/message needs text.');
      const event = new CustomEvent(COMPOSER_INSERT_EVENT, { detail: { text }, cancelable: true });
      const handled = !window.dispatchEvent(event);
      if (!handled) {
        try {
          await navigator.clipboard.writeText(text);
          pushToast('info', 'The app suggested a message; it is copied, ready to paste.');
        } catch {
          pushToast('warn', 'The app suggested a message, but it could not be copied.');
        }
      }
      return reply(id, {});
    };

    const onRequest = (id: string | number, method: string, params: any) => {
      if (method === 'ui/initialize') {
        reply(id, {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
          hostInfo: { name: 'NeuraOS', version: '1' },
          hostCapabilities: { openLinks: {}, serverTools: {}, message: {} },
          hostContext: {
            theme: currentTheme(),
            displayMode: 'inline',
            availableDisplayModes: ['inline'],
            platform: 'desktop',
            locale: navigator.language || 'en',
            toolInfo: { tool: { name: latest.current.toolName } },
          },
        });
        // A view that never says "initialized" still gets its data.
        fallback = setTimeout(() => { if (!sent.current.initialized) { sent.current.initialized = true; sendToolData(); } }, 1000);
        return;
      }
      if (method === 'tools/call') { void callTool(id, params); return; }
      if (method === 'ui/open-link') { void openLink(id, params); return; }
      if (method === 'ui/message') { void insertMessage(id, params); return; }
      if (method === 'ping') { reply(id, {}); return; }
      fail(id, -32601, `${method} is not supported by this host.`);
    };

    const onNotification = (method: string, params: any) => {
      if (method === 'ui/notifications/initialized') {
        sent.current.initialized = true;
        sendToolData();
      } else if (method === 'ui/notifications/size-changed') {
        const next = clampHeight(params?.height);
        if (next != null) setHeight(next);
      }
    };

    const onMessage = (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
      const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
      if (typeof msg.id === 'string' || typeof msg.id === 'number') onRequest(msg.id, msg.method, params);
      else if (msg.id === undefined) onNotification(msg.method, params);
    };
    window.addEventListener('message', onMessage);

    const themeWatch = new MutationObserver(() => {
      if (sent.current.initialized) post({ method: 'ui/notifications/host-context-changed', params: { theme: currentTheme() } });
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      window.removeEventListener('message', onMessage);
      themeWatch.disconnect();
      if (fallback) clearTimeout(fallback);
      askRef.current?.resolve('deny');
    };
  }, [html]);

  // A result that arrives after the view is up.
  useEffect(() => {
    if (result != null && sent.current.initialized && !sent.current.result) flush.current();
  }, [result]);

  if (problem) return <div className="mcp-app"><div className="mcp-app-note">{problem}</div></div>;
  if (!html) return <div className="mcp-app"><div className="mcp-app-note">Loading the app…</div></div>;
  return (
    <div className="mcp-app">
      <iframe
        ref={frame}
        className="mcp-app-frame"
        title={`App: ${tools.summarise(toolName, {})}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={html}
        style={{ height }}
      />
      {ask && (
        <div className="tool-card-ask mcp-app-ask">
          <span>{ask.text}</span>
          <div className="tool-card-actions">
            {ask.always && <button onClick={() => ask.resolve('always')}>Always for this server</button>}
            <button onClick={() => ask.resolve('deny')}>Deny</button>
            <button className="primary" onClick={() => ask.resolve('allow')}>Allow</button>
          </div>
        </div>
      )}
    </div>
  );
}
