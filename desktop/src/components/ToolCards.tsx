import { useEffect, useState } from 'react';
import Icon from './Icon';
import McpAppFrame from './McpAppFrame';
import type { ToolEvent } from '../agent-turn';
import { mcpAppFor } from '../tool-run';

// What a model did, under the reply it did it for.
//
// A card is one line when nothing needs the person: "Search the web for ...",
// a tick, done. It opens to the arguments and the result on a click. The one
// time it demands attention is when the tool changes something -- a file, a
// command, a commit, somebody's MCP server -- and then it is Allow / Deny right
// there in the conversation, not in a panel somewhere else.

interface Props {
  events: ToolEvent[];
  /** Present only while the turn is live and a card is asking. */
  onDecide?: (id: string, allow: boolean, always: boolean) => void;
  /** Ctrl+T: every card open (true), every card folded (false), or each its own. */
  expandAll?: boolean;
}

/** 0.4s, 12s, 1m 05s: how long a tool has been (or was) at it. */
export function elapsed(ms: number): string {
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

const ICON: Record<ToolEvent['status'], 'activity' | 'check' | 'close' | 'alert' | 'shield'> = {
  asking: 'shield',
  running: 'activity',
  done: 'check',
  denied: 'close',
  error: 'alert',
};

const WORD: Record<ToolEvent['status'], string> = {
  asking: 'needs your OK',
  running: 'running…',
  done: 'done',
  denied: 'declined',
  error: 'failed',
};

export default function ToolCards({ events, onDecide, expandAll }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // An MCP App under its call is shown unless the person hides it.
  const [appHidden, setAppHidden] = useState<Record<string, boolean>>({});
  // A running tool's timer ticks; nothing re-renders once they are all done.
  const live = events.some((e) => e.status === 'running');
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [live]);
  useEffect(() => { if (expandAll !== undefined) setOpen({}); }, [expandAll]);
  if (!events.length) return null;
  return (
    <div className="tool-cards">
      {events.map((event) => {
        const asking = event.status === 'asking' && !!onDecide;
        const shown = (open[event.id] ?? !!expandAll) || asking;
        const canAlways = event.name.startsWith('mcp__');
        const app = canAlways && event.status === 'done' ? mcpAppFor(event.name) : null;
        const appShown = !!app && !appHidden[event.id];
        return (
          <div key={event.id} className={`tool-card is-${event.status}`}>
            <button
              className="tool-card-head"
              onClick={() => setOpen((o) => ({ ...o, [event.id]: !(o[event.id] ?? !!expandAll) }))}
              aria-expanded={shown}
            >
              <Icon name={ICON[event.status]} size={13} />
              <span className="tool-card-summary">{event.summary}</span>
              <span className="tool-card-status">{WORD[event.status]}</span>
              {event.startedAt && event.status !== 'asking' && (
                <span className="tool-card-time mono">{elapsed((event.endedAt || Date.now()) - event.startedAt)}</span>
              )}
              <Icon name={shown ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
            {shown && (
              <div className="tool-card-body">
                <div className="tool-card-label">{event.name}</div>
                <pre className="tool-card-pre">{JSON.stringify(event.args, null, 2)}</pre>
                {event.result != null && (
                  <>
                    <div className="tool-card-label">Result</div>
                    <pre className="tool-card-pre">{event.result}</pre>
                  </>
                )}
              </div>
            )}
            {app && (
              <div className="mcp-app-bar">
                <Icon name="activity" size={12} />
                <span>App</span>
                <button
                  className="mcp-app-toggle"
                  onClick={() => setAppHidden((h) => ({ ...h, [event.id]: !h[event.id] }))}
                  aria-expanded={appShown}
                >
                  {appShown ? 'Hide' : 'Show'}
                </button>
              </div>
            )}
            {app && appShown && (
              <McpAppFrame toolName={event.name} callId={event.id} args={event.args} result={event.result} />
            )}
            {asking && (
              <div className="tool-card-ask">
                <span>This {event.asks}.</span>
                <div className="tool-card-actions">
                  {canAlways && <button onClick={() => onDecide!(event.id, true, true)}>Always for this server</button>}
                  <button onClick={() => onDecide!(event.id, false, false)}>Deny</button>
                  <button className="primary" onClick={() => onDecide!(event.id, true, false)}>Allow</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
