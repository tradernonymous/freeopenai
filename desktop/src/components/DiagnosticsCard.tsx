// "Something is wrong" should not require a screenshot.
//
// The facts come from the shell (version, OS, WebView2, where the logs are) and
// from the app (which engine, what the last answer meant); the wording and the
// redaction come from src/diagnostics.js, which node:test checks. The bundle is
// safe to paste: no token, no key, no chat content.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { diagnosticsFacts, hasShell, type DiagnosticsFacts } from '../bridge';
import '../diagnostics.js';

const diagnostics: typeof import('../diagnostics.js') = (globalThis as any).FreeAI4UDiagnostics;

export default function DiagnosticsCard({ state }: { state?: string }) {
  const [facts, setFacts] = useState<DiagnosticsFacts | null>(null);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!hasShell()) return;
    let cancelled = false;
    diagnosticsFacts()
      .then((found) => { if (!cancelled) setFacts(found); })
      .catch(() => { if (!cancelled) setFacts(null); });
    return () => { cancelled = true; };
  }, []);

  // Cold start (NEURA-035): the marks main.tsx and App set on this launch.
  const startup = diagnostics.startupTimings();
  const startupLine = diagnostics.startupLabel(startup);

  const report = diagnostics.buildReport({
    shell: facts || {},
    client: { engine: api.getServer(), state, hasShell: hasShell(), startup },
  });

  const copy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      setOpen(true);
      setMessage('This window cannot copy for you — select the text below.');
      return;
    }
    clipboard.writeText(report).then(
      () => setMessage('Copied. Paste it wherever you are reporting the problem.'),
      () => {
        setOpen(true);
        setMessage('Copy was refused — select the text below instead.');
      },
    );
  };

  return (
    <section className="settings-section">
      <h2>Diagnostics</h2>
      <div className="settings-card">
        <p className="settings-hint">
          What this build is, where it points, and how it last answered. Safe to paste:
          addresses have their query strings removed, and anything shaped like a key is redacted.
        </p>
        {startupLine && (
          <p className="settings-hint" title="Milliseconds since the window started loading, on this launch">
            Start-up: {startupLine}
          </p>
        )}
        <div className="setting-row">
          <button type="button" onClick={copy}>Copy diagnostics</button>
          <button type="button" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
        {message && <p className="settings-hint">{message}</p>}
        {open && <pre className="diagnostics-report">{report}</pre>}
      </div>
    </section>
  );
}
