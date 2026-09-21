import { useState } from 'react';
import Icon from './Icon';
import type { ToolEvent } from '../agent-turn';

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

export default function ToolCards({ events, onDecide }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!events.length) return null;
  return (
    <div className="tool-cards">
      {events.map((event) => {
        const asking = event.status === 'asking' && !!onDecide;
        const shown = open[event.id] || asking;
        const canAlways = event.name.startsWith('mcp__');
        return (
          <div key={event.id} className={`tool-card is-${event.status}`}>
            <button
              className="tool-card-head"
              onClick={() => setOpen((o) => ({ ...o, [event.id]: !o[event.id] }))}
              aria-expanded={shown}
            >
              <Icon name={ICON[event.status]} size={13} />
              <span className="tool-card-summary">{event.summary}</span>
              <span className="tool-card-status">{WORD[event.status]}</span>
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
