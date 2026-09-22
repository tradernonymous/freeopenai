// Mermaid, loaded only when a diagram is first drawn: the library is large and
// most chats never need it. securityLevel 'strict' makes mermaid sanitise the
// labels and refuse click handlers, so a model's diagram cannot run script.
let loaded: Promise<any> | null = null;
let seq = 0;

function mermaid(): Promise<any> {
  if (!loaded) {
    loaded = import('mermaid').then((mod) => {
      const m = mod.default;
      const dark = document.documentElement.dataset.theme !== 'light';
      m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'Inter Variable, sans-serif' });
      return m;
    });
  }
  return loaded;
}

/** Mermaid source -> SVG markup. Rejects with mermaid's parse message. */
export async function renderMermaid(source: string): Promise<string> {
  const m = await mermaid();
  seq += 1;
  const { svg } = await m.render(`mmd-${Date.now()}-${seq}`, String(source || '').trim());
  return svg;
}
