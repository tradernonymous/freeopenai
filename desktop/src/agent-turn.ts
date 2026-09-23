// One turn of Chat, with tools: stream, act on what the model asked for, stream
// again -- until it answers in words or the round limit stops it.
//
// The loop owns no transport and no UI. It is given a `stream` (any provider:
// engine, Hugging Face, Ollama, llama-server), an `execute` (tool-run.ts), and
// an `approve` that resolves when the person clicks Allow or Deny on the card.
// Everything a person should see goes out through `onText` and `onTool`.
//
// Two decisions worth knowing:
//
//   * a DENIED call is not an error. The model is told "the user declined", so
//     it can answer without the tool instead of stalling;
//   * a provider that REFUSES tools outright (a 400 about `tools`) gets the turn
//     again without them, once, and the person is told -- a model that cannot
//     call tools should still be able to talk.
//
// And one rule that outranks both: a turn never ends in silence. Two ways it
// used to. A model that streams only its reasoning (`reasoning_content`, kept
// as <think> so the chat can fold it) left a "Thought" block and no answer. A
// research-shaped request ran out of rounds and left a pile of tool cards and
// no plan. Both now get one closing pass with the tools withheld, which is the
// only thing the model can do with it: answer.
import './tools.js';
import type { StreamFrame } from './api';

const tools: typeof import('./tools.js') = (globalThis as any).FreeAI4UTools;

type ToolCall = import('./tools.js').ToolCall;
type ToolDef = import('./tools.js').ToolDef;

export type Message = { role: string; content: any; tool_calls?: any[]; tool_call_id?: string; name?: string };

export type ToolStatus = 'asking' | 'running' | 'done' | 'denied' | 'error';

export interface ToolEvent {
  id: string;
  name: string;
  args: Record<string, any>;
  summary: string;
  /** Why it asks first; empty when it simply runs. */
  asks: string;
  status: ToolStatus;
  result?: string;
  /** Stamped by the screen, for the elapsed timer. */
  startedAt?: number;
  endedAt?: number;
}

export interface TurnOptions {
  messages: Message[];
  tools: ToolDef[];
  stream: (messages: Message[], tools: ToolDef[] | undefined, onFrame: (frame: StreamFrame) => void, signal?: AbortSignal) => Promise<void>;
  execute: (call: ToolCall, args: Record<string, any>) => Promise<string>;
  approve: (event: ToolEvent) => Promise<boolean>;
  onText: (piece: string) => void;
  onTool: (event: ToolEvent) => void;
  onNote?: (note: string) => void;
  signal?: AbortSignal;
}

/** What the person would actually read: the answer without its reasoning. */
export function visibleAnswer(text: string): string {
  return String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

/** The nudge that closes a turn the model left open. */
const CLOSING_NUDGE =
  'Answer now, in words, using what you already have. Do not call any more tools.';

export async function runTurn(options: TurnOptions): Promise<void> {
  const messages = options.messages.slice();
  let offered: ToolDef[] | undefined = options.tools.length ? options.tools : undefined;

  // One closing pass, at most, per turn: stream once more with no tools on
  // offer and an explicit ask for the answer. `why` is what the person is
  // told, so the app never just goes quiet on them.
  let closed = false;
  const closeOut = async (why: string, history: Message[]): Promise<void> => {
    if (closed) return;
    closed = true;
    options.onNote?.(why);
    const asked = history.concat([{ role: 'user', content: CLOSING_NUDGE }]);
    let said = '';
    await options.stream(asked, undefined, (frame: StreamFrame) => {
      if (frame.content) { said += frame.content; options.onText(frame.content); }
    }, options.signal);
    if (!visibleAnswer(said)) {
      options.onNote?.('The model had nothing more to say. Ask again, or try another model.');
    }
  };

  for (let round = 0; round < tools.MAX_ROUNDS; round += 1) {
    let text = '';
    let pending: any[] = [];
    const onFrame = (frame: StreamFrame) => {
      if (frame.content) {
        text += frame.content;
        options.onText(frame.content);
      }
      if (frame.toolCalls) pending = tools.collect(pending, frame.toolCalls);
    };

    try {
      await options.stream(messages, offered, onFrame, options.signal);
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      // Only before anything was said, only once, and only when the refusal
      // reads like it is about tools.
      if (offered && !text && round === 0 && (err as Error)?.name !== 'AbortError' && tools.isToolsRefusal(message)) {
        offered = undefined;
        options.onNote?.('This model does not take tools, so it is answering without them.');
        round -= 1;
        continue;
      }
      throw err;
    }

    const calls = tools.finish(pending);
    if (!calls.length) {
      // Reasoning is not an answer. A model that thought out loud and stopped
      // gets one chance to say the thing it was thinking about.
      if (!visibleAnswer(text) && !options.signal?.aborted) {
        await closeOut('That reply was only the model thinking. Asking it for the answer.', messages);
      }
      return;
    }

    messages.push(tools.assistantMessage(text, calls));
    for (const call of calls) {
      if (options.signal?.aborted) return;
      const args = tools.parseArgs(call.arguments);
      const event: ToolEvent = {
        id: call.id,
        name: call.name,
        args,
        summary: tools.summarise(call.name, args),
        asks: tools.needsApproval(call.name),
        status: 'running',
      };
      let result: string;
      if (event.asks) {
        event.status = 'asking';
        options.onTool({ ...event });
        const allowed = await options.approve({ ...event });
        if (!allowed) {
          event.status = 'denied';
          event.result = 'The user declined this action.';
          options.onTool({ ...event });
          messages.push(tools.toolMessage(call, event.result));
          continue;
        }
        event.status = 'running';
      }
      options.onTool({ ...event });
      try {
        result = await options.execute(call, args);
        event.status = 'done';
      } catch (err) {
        result = `Error: ${(err as Error)?.message || String(err)}`;
        event.status = 'error';
      }
      event.result = tools.clip(result);
      options.onTool({ ...event });
      messages.push(tools.toolMessage(call, result));
    }
  }
  if (!options.signal?.aborted) {
    await closeOut(
      `That is ${tools.MAX_ROUNDS} rounds of tool calls. Asking for the answer with what it has.`,
      messages,
    );
  }
}
