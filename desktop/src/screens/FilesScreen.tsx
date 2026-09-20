import { useState, useRef, useCallback } from 'react';
import { api } from '../api';
// UMD modules load for their side effect and are picked up off globalThis
// -- the same pattern the design engine uses (rollup cannot see named
// exports through a UMD wrapper).
// zip.js first: office.js and pdf.js take their deflate implementation from the
// global it publishes, and in a bundle that global must exist before they run.
import '../files/zip.js';
import '../files/office.js';
import '../files/pdf.js';
import { saveFile } from '../files/save';

const office: typeof import('../files/office.js') = (globalThis as any).FreeOffice;
const pdf: typeof import('../files/pdf.js') = (globalThis as any).FreePdf;

type Kind = 'docx' | 'xlsx' | 'pptx' | 'md';

interface Extract {
  name: string;
  kind: string;
  text: string;
}

interface GenCard {
  id: number;
  kind: Kind;
  title: string;
  spec: string;      // what the user asked for
  draft: string;     // current generated content
  status: 'drafting' | 'ready' | 'saving' | 'saved' | 'error';
  note?: string;
  result?: string;
}

const GEN_KINDS: Array<{ id: Kind; label: string }> = [
  { id: 'docx', label: 'Word (.docx)' },
  { id: 'xlsx', label: 'Spreadsheet (.xlsx)' },
  { id: 'pptx', label: 'Slides (.pptx)' },
  { id: 'md', label: 'Markdown (.md)' },
];

const DISPATCH: Record<Kind, string> = {
  docx: 'You are writing the body of a Word document. Reply with the document paragraphs only — no code fences, no commentary.',
  xlsx: 'You are filling a spreadsheet. Reply with TSV rows only: one row per line, cells separated by single tabs. No headings, no commentary.',
  pptx: 'You are writing presentation slides. Reply with one slide per paragraph; the first line of a paragraph is the slide title, following lines are bullets. No commentary.',
  md: 'You are writing a Markdown document. Reply with Markdown only, no commentary.',
};

function isKind(v: string): v is Kind {
  return v === 'docx' || v === 'xlsx' || v === 'pptx' || v === 'md';
}

async function extractAny(file: File): Promise<Extract> {
  const name = file.name;
  const lower = name.toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  if (lower.endsWith('.pdf')) return { name, kind: 'pdf', text: await pdf.extractPdfText(buf) };
  if (lower.endsWith('.docx')) return { name, kind: 'docx', text: await office.extractDocxText(buf) };
  if (lower.endsWith('.xlsx')) {
    const sheets = await office.extractXlsxSheets(buf);
    return { name, kind: 'xlsx', text: office.sheetToText(sheets[0]?.rows || []) };
  }
  if (lower.endsWith('.pptx')) return { name, kind: 'pptx', text: await office.extractPptxText(buf) };
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv')) {
    return { name, kind: 'text', text: new TextDecoder().decode(buf) };
  }
  throw new Error('Unsupported type — drop a PDF, DOCX, XLSX, PPTX, TXT, MD or CSV.');
}

function parseTsv(text: string): string[][] {
  return text.replace(/\r/g, '').split('\n').map((line) => line.split('\t'));
}

function buildBytes(kind: Kind, title: string, draft: string): Promise<Uint8Array> {
  if (kind === 'docx') return office.writeDocx(title, draft.replace(/\r/g, '').split('\n'));
  if (kind === 'xlsx') return office.writeXlsx(title, [{ name: title.slice(0, 28) || 'Sheet1', rows: parseTsv(draft) }]);
  if (kind === 'pptx') return office.writePptx(title, draft.replace(/\r/g, '').split(/\n{2,}/).filter((s) => s.trim()));
  return Promise.resolve(new TextEncoder().encode(draft));
}

const MIME: Record<Kind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
};

function slug(s: string): string {
  return (s.trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 40) || 'freeai4u').toLowerCase();
}

// The engine answers in the OpenAI shape ({ choices: [ { message: { content } }] });
// tolerate a bare string or a bare content in case a provider shape slips through.
function unwrapReply(res: any): string {
  const c = res?.choices?.[0]?.message?.content ?? res?.content ?? res;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => p?.text || '').join('');
  return String(c ?? '');
}

export default function FilesScreen() {
  const [extract, setExtract] = useState<Extract | null>(null);
  const [extractErr, setExtractErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [gen, setGen] = useState<GenCard | null>(null);
  const [genKind, setGenKind] = useState<Kind>('docx');
  const [genAsk, setGenAsk] = useState('');
  const [imgMsg, setImgMsg] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setBusy(true);
    setExtractErr('');
    try {
      setExtract(await extractAny(file));
    } catch (err) {
      setExtract(null);
      setExtractErr((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const sendToChat = () => {
    if (!extract) return;
    const header = `From ${extract.name} (${extract.kind}):\n\n`;
    const body = header + extract.text.slice(0, 60_000);
    try {
      sessionStorage.setItem('freeai4u.pendingAttachment', body);
      window.dispatchEvent(new CustomEvent('freeai4u-attach'));
      setExtractErr('');
    } catch (err) {
      setExtractErr('Could not stage the text: ' + (err as Error).message);
    }
  };

  const startGenerate = async () => {
    if (!genAsk.trim()) return;
    const id = Date.now();
    setGen({ id, kind: genKind, title: genAsk.trim(), spec: genAsk.trim(), draft: '', status: 'drafting' });
    try {
      const messages = [
        { role: 'system', content: DISPATCH[genKind] },
        { role: 'user', content: genAsk.trim() },
      ];
      const text = unwrapReply(await api.chat(messages as any));
      setGen((g) => (g && g.id === id ? { ...g, draft: text.trim(), status: 'ready' } : g));
    } catch (err) {
      setGen((g) => (g && g.id === id ? { ...g, status: 'error', note: (err as Error).message } : g));
    }
  };

  const saveGenerated = async () => {
    if (!gen || !gen.draft) return;
    setGen({ ...gen, status: 'saving' });
    try {
      const ext = gen.kind;
      const bytes = await buildBytes(ext, gen.title, gen.draft);
      const result = await saveFile({ name: `${slug(gen.title)}.${ext}`, bytes, mime: MIME[ext] });
      setGen({ ...gen, status: 'saved', result });
    } catch (err) {
      const msg = (err as Error).message;
      setGen({ ...gen, status: msg.includes('cancel') ? 'ready' : 'error', note: msg });
    }
  };

  const discardGenerated = () => setGen(null);

  const describeImage = async (file: File) => {
    setImgBusy(true);
    setImgMsg('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('could not read the file'));
        r.readAsDataURL(file);
      });
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image for use as a prompt reference. Cover subject, style, colors, composition and any text visible.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ];
      const out = unwrapReply(await api.chat(messages as any)).trim();
      if (!out) throw new Error('the engine returned an empty description');
      try {
        sessionStorage.setItem('freeai4u.pendingAttachment', out);
        window.dispatchEvent(new CustomEvent('freeai4u-attach'));
        setImgMsg('Description staged — open Chat to use it with any model.');
      } catch {
        setImgMsg(out.slice(0, 2000));
      }
    } catch (err) {
      setImgMsg('Could not describe the image: ' + (err as Error).message);
    } finally {
      setImgBusy(false);
    }
  };

  return (
    <div className="files-screen">
      <header className="screen-head">
        <h2>Files</h2>
        <p className="muted">Drop a document to read it, or generate a real file from a prompt. Everything runs on your machine.</p>
      </header>

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
        onClick={() => fileInput.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') fileInput.current?.click(); }}
      >
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.currentTarget.value = ''; }}
        />
        {busy ? <span>Reading…</span> : <span>Drop a PDF, DOCX, XLSX or PPTX — or click to choose</span>}
      </div>
      {extractErr && <div className="files-error">{extractErr}</div>}

      {extract && (
        <section className="extract-card">
          <div className="extract-head">
            <strong>{extract.name}</strong>
            <span className="limit-badge">{extract.kind}</span>
            <span className="muted">{extract.text.length.toLocaleString()} chars</span>
            <div className="extract-actions">
              <button className="primary" onClick={sendToChat}>Send to Chat</button>
              <button onClick={() => setExtract(null)}>Clear</button>
            </div>
          </div>
          <pre className="extract-preview">{extract.text.slice(0, 8000)}{extract.text.length > 8000 ? '\n…' : ''}</pre>
        </section>
      )}

      <section className="gen-card">
        <h3>Generate a file</h3>
        <div className="gen-row">
          <select value={genKind} onChange={(e) => isKind(e.target.value) && setGenKind(e.target.value)}>
            {GEN_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <input
            value={genAsk}
            onChange={(e) => setGenAsk(e.target.value)}
            placeholder="e.g. a project status one-pager for the parking-lot sensor rollout"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) startGenerate(); }}
          />
          <button className="primary" onClick={startGenerate} disabled={gen?.status === 'drafting'}>
            {gen?.status === 'drafting' ? 'Drafting…' : 'Draft'}
          </button>
        </div>

        {gen && (
          <div className={`approval-card status-${gen.status}`}>
            <div className="approval-head">
              <strong>{gen.kind.toUpperCase()} · {gen.title}</strong>
              <span className={`approval-status s-${gen.status}`}>{gen.status}</span>
            </div>
            {gen.status === 'drafting' && <p className="muted">The model is drafting the content…</p>}
            {(gen.status === 'ready' || gen.status === 'error' || gen.status === 'saved') && (
              <pre className="extract-preview">{gen.draft.slice(0, 6000) || '(empty draft)'}</pre>
            )}
            {gen.note && <p className="files-error">{gen.note}</p>}
            {gen.result && <p className="muted">{gen.result}</p>}
            <div className="approval-actions">
              <button className="primary" onClick={saveGenerated} disabled={!gen.draft || gen.status === 'saving'}>
                {gen.status === 'saving' ? 'Saving…' : 'Approve & save'}
              </button>
              <button onClick={discardGenerated}>Discard</button>
            </div>
          </div>
        )}
      </section>

      <section className="gen-card">
        <h3>Describe an image</h3>
        <p className="muted">Turn a picture into a text prompt any model can use — no vision model needed.</p>
        <div className="gen-row">
          <input
            ref={imgInput}
            type="file"
            hidden
            accept="image/*"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) describeImage(f); e.currentTarget.value = ''; }}
          />
          <button onClick={() => imgInput.current?.click()} disabled={imgBusy}>
            {imgBusy ? 'Describing…' : 'Choose an image…'}
          </button>
          {imgMsg && <span className={imgMsg.startsWith('Could') ? 'files-error' : 'muted'}>{imgMsg}</span>}
        </div>
      </section>
    </div>
  );
}
