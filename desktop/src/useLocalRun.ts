// Live output of a local command, as a hook.
//
// The shell emits one `local-run` event per line while a command runs
// (src-tauri/src/local.rs). This subscribes once and hands each chunk to the
// caller; the dock routes chunks by runId, so two commands in flight can never
// deliver a line to the wrong entry.
//
// When there is no shell (vite dev, the web build) or the subscription is
// refused, this is a no-op: the settled result of the run still arrives, so the
// worst case is output that appears when the command finishes rather than as it
// goes.
import { useEffect, useRef } from 'react';
import { onLocalRun, type LocalRunChunk } from './bridge';

export function useLocalRun(handler: (chunk: LocalRunChunk) => void): void {
  // The handler is read through a ref so a re-render never re-subscribes --
  // a gap in the subscription would be lost output.
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    onLocalRun((chunk) => latest.current(chunk))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => { /* no events: the settled result carries the output */ });
    return () => {
      cancelled = true;
      if (stop) stop();
    };
  }, []);
}
