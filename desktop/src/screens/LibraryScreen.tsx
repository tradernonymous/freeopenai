import { useState, useEffect, useCallback } from 'react';
import HfSignIn from '../components/HfSignIn';
import { api } from '../api';
import Icon from '../components/Icon';
import { writeLocalFile } from '../bridge';
import { OPEN_CHAT_EVENT, type ChatSession } from './ChatScreen';
// UMD modules: loaded for their side effect, read off globalThis.
import '../chats.js';
import '../hf-auth.js';
import '../hf-models.js';
import '../hf-skills.js';

const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;
const hfModels: typeof import('../hf-models.js') = (globalThis as any).FreeAI4UHfModels;
const hfSkills: typeof import('../hf-skills.js') = (globalThis as any).FreeAI4UHfSkills;

// Named for the store, not `chats`: this screen already has a `chats` state.
const chatStore: typeof import('../chats.js') = (globalThis as any).FreeAI4UChats;

interface Skill {
  source: string;
  name: string;
  description: string;
}

// The folder the local surfaces work in. App.tsx owns the state behind this
// key; the Library only ever reads it, because a skill has to land in a real
// folder and this screen is not the one that chooses which.
const LOCAL_ROOT_KEY = 'freeai4u.localRoot';

function readLocalRoot(): string {
  try {
    return localStorage.getItem(LOCAL_ROOT_KEY) || '';
  } catch {
    return '';
  }
}

/** What an install is doing right now, for the one row the user clicked. */
interface InstallState {
  phase: 'working' | 'done' | 'error';
  text: string;
}

interface HfModel {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  siblings?: Array<{ rfilename?: string; name?: string; size?: number }>;
  cardData?: { license?: string };
  license?: string;
  gated?: boolean | string;
}

/** Library: the engine's skill catalogue plus the chats saved on this machine. */
export default function LibraryScreen() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [open, setOpen] = useState<Skill | null>(null);
  const [content, setContent] = useState<string>('');
  const [error, setError] = useState('');
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(false);

  // --- HF Skills state ---
  const [hfCatalog, setHfCatalog] = useState<any[]>([]);
  const [hfCatalogLoading, setHfCatalogLoading] = useState(false);
  // Keyed by slug, so two rows installing at once cannot show each other's
  // progress or each other's failure.
  const [installState, setInstallState] = useState<Record<string, InstallState>>({});
  const [installed, setInstalled] = useState<import('../hf-skills.js').InstalledRecords>(
    () => hfSkills.readInstalled(),
  );
  const [localRoot] = useState<string>(readLocalRoot);

  // --- HuggingFace state ---
  const [hfSignedIn, setHfSignedIn] = useState(false);
  const [hfUser, setHfUser] = useState<any>(null);
  const [hfQuery, setHfQuery] = useState('');
  const [hfResults, setHfResults] = useState<HfModel[]>([]);
  const [hfLoading, setHfLoading] = useState(false);
  const [hfError, setHfError] = useState('');

  useEffect(() => {
    const onAuth = () => setHfSignedIn(hfAuth.signedIn());
    window.addEventListener(hfAuth.AUTH_CHANGED_EVENT, onAuth);
    setHfSignedIn(hfAuth.signedIn());
    if (hfAuth.signedIn()) {
      hfAuth.fetchUser().then(u => { if (u) setHfUser(u); });
    }
  }, []);

  const hfSearch = useCallback(async () => {
    const q = hfQuery.trim();
    if (!q) return;
    setHfLoading(true);
    setHfError('');
    try {
      const headers = hfAuth.authHeaders();
      const results = await hfModels.searchModels(q, { limit: 20, authHeaders: headers });
      setHfResults(Array.isArray(results) ? results : []);
    } catch (err) {
      setHfError((err as Error).message);
    } finally {
      setHfLoading(false);
    }
  }, [hfQuery]);

  const hfSignOut = useCallback(() => {
    hfAuth.signOut();
    setHfSignedIn(false);
    setHfUser(null);
    setHfResults([]);
  }, []);

  // Nothing here runs on its own: this is what the user's click on Install
  // does. The screen supplies the two things hf-skills.js refuses to invent --
  // the token (as a header, never written into a file) and a writer bound to
  // the open folder, which local.rs confines -- and hf-skills.js decides what
  // may be written and where.
  const installSkill = useCallback(async (skill: any) => {
    const slug = hfSkills.skillSlug(skill?.name || '');
    if (!slug) return;
    setInstallState((s) => ({ ...s, [slug]: { phase: 'working', text: 'Starting…' } }));
    try {
      const result = await hfSkills.installSkill(skill, {
        token: hfAuth.accessToken()?.access_token,
        writeFile: (path: string, text: string) => writeLocalFile(localRoot, path, text),
        onProgress: (p) => setInstallState((s) => ({
          ...s,
          [slug]: {
            phase: 'working',
            text: p.phase === 'done'
              ? 'Finishing…'
              : `${p.phase === 'fetch' ? 'Downloading' : 'Writing'} ${p.file} (${p.index + 1}/${p.total})`,
          },
        })),
      });
      setInstalled(hfSkills.rememberInstalled(skill, result));
      setInstallState((s) => ({
        ...s,
        [slug]: { phase: 'done', text: `Installed ${result.files.length} file${result.files.length === 1 ? '' : 's'} into ${result.dir}` },
      }));
    } catch (err) {
      // The whole point of the error path: say what failed, in the words
      // hf-skills.js already chose, instead of a silent no-op.
      setInstallState((s) => ({ ...s, [slug]: { phase: 'error', text: (err as Error).message } }));
    }
  }, [localRoot]);

  const load = () => {
    setLoading(true);
    setError('');
    api.skills()
      .then((rows: any) => setSkills(Array.isArray(rows) ? rows : []))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
    setChats(chatStore.byRecency(chatStore.readStore()) as ChatSession[]);

    // Load HF skills catalog.
    setHfCatalogLoading(true);
    const hfToken = hfAuth.accessToken()?.access_token;
    hfSkills.loadCatalog(hfToken || undefined)
      .then((rows: any) => setHfCatalog(Array.isArray(rows) ? rows : []))
      .catch(() => setHfCatalog([]))
      .finally(() => setHfCatalogLoading(false));
  };

  useEffect(() => { load(); }, []);

  const show = (s: Skill) => {
    setOpen(s);
    setContent('Loading…');
    api.skillContent(s.name)
      .then((data: any) => setContent(typeof data === 'string' ? data : data.content || data.body || JSON.stringify(data)))
      .catch((err) => setContent('Could not load: ' + (err as Error).message));
  };

  const openChat = (id: string) => window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: id }));

  return (
    <div className="screen library">
      <header className="screen-header">
        <h1>Library</h1>
        <div className="header-actions">
          <button onClick={load} disabled={loading} title="Re-read the engine's skills and this machine's chats">
            <Icon name="refresh" size={13} /> Refresh
          </button>
        </div>
      </header>

      {/* --- HuggingFace section --- */}
      <section className="hf-section">
        <h3 className="col-title">
          <Icon name="image" size={14} /> Hugging Face
          {hfSignedIn && hfUser && (
            <span className="hf-user"> · {hfUser.name || hfUser.fullname}
              <button className="hf-link" onClick={hfSignOut}>sign out</button>
            </span>
          )}
        </h3>
        {!hfSignedIn ? (
          <div>
            <p>Sign in to browse and download GGUF models (including gated repos).</p>
            <HfSignIn onSignedIn={(who) => { setHfSignedIn(true); setHfUser(who); }} />
          </div>
        ) : (
          <div className="hf-browser">
            <div className="hf-search-bar">
              <input
                value={hfQuery}
                onChange={(e) => setHfQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') hfSearch(); }}
                placeholder="Search GGUF models (e.g. Qwen3-Coder, Llama-3, Unsloth)"
              />
              <button onClick={hfSearch} disabled={hfLoading || !hfQuery.trim()}>
                {hfLoading ? 'Searching…' : 'Search'}
              </button>
            </div>
            {hfError && <div className="stream-error">{hfError}</div>}
            <div className="hf-results">
              {hfResults.map((m) => {
                const ggufCount = (m.siblings || []).filter((s: any) => /\.gguf$/i.test(s.rfilename || s.name || '')).length;
                const gated = hfModels.isGated(m);
                return (
                  <div key={m.id} className="hf-model-card">
                    <div className="hf-model-header">
                      <span className="hf-model-name">{m.id}</span>
                      {gated && <span className="hf-badge gated">gated</span>}
                      {ggufCount > 0 && <span className="hf-badge gguf">{ggufCount} GGUF</span>}
                    </div>
                    <div className="hf-model-meta">
                      {m.downloads != null && <span>{(m.downloads || 0).toLocaleString()} downloads</span>}
                      {m.likes != null && <span>{m.likes} likes</span>}
                      {hfModels.licenseShort(m) && <span>{hfModels.licenseShort(m)}</span>}
                    </div>
                    {ggufCount > 0 && (
                      <div className="hf-model-files">
                        {hfModels.ggufFiles(m).slice(0, 5).map((f: any) => (
                          <div key={f.name} className="hf-file">
                            <span className="hf-file-name">{f.name}</span>
                            <span className="hf-file-meta">{f.quant} · {hfModels.formatSize(f.size)}{f.fitsRam ? ` · fits ${f.fitsRam}` : ''}</span>
                          </div>
                        ))}
                        {ggufCount > 5 && <div className="hf-file more">…and {ggufCount - 5} more</div>}
                      </div>
                    )}
                  </div>
                );
              })}
              {hfResults.length === 0 && !hfLoading && !hfError && (
                <div className="empty">Search for GGUF models to see available quants and sizes.</div>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="library-layout">
        <section className="library-col">
          <h3 className="col-title">HF Skills ({hfCatalog.length})</h3>
          {hfCatalogLoading && <div className="empty">Loading HF skills…</div>}
          <div className="skill-list">
            {hfCatalog.map((s: any) => {
              const slug = hfSkills.skillSlug(s.name || '');
              const state = installState[slug];
              const status = hfSkills.installStatus(s, installed);
              const busy = state?.phase === 'working';
              const record = installed[slug];
              return (
                <div key={s.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <button className={`skill-item ${open?.name === s.name ? 'active' : ''}`} onClick={() => { setOpen({ name: s.name, description: s.description, source: s.repo || 'hf' }); setContent(s.content); }}>
                    <div className="skill-name">
                      {s.name}
                      {status !== 'install' && (
                        <span className="hf-badge"> {status === 'update' ? 'update available' : 'installed'}</span>
                      )}
                    </div>
                    <div className="skill-desc">{s.description}</div>
                    <div className="skill-src">{s.repo}{s.tags?.length ? ' · ' + s.tags.join(', ') : ''}</div>
                  </button>
                  <div className="skill-src" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={() => installSkill(s)}
                      disabled={busy || !localRoot}
                      title={localRoot
                        ? `Write this skill into ${hfSkills.SKILLS_DIR}/${slug} in the open folder`
                        : 'Open a folder first — a skill installs into the folder you are working in'}
                    >
                      <Icon name="download" size={12} />{' '}
                      {busy ? 'Installing…' : status === 'update' ? 'Update' : status === 'installed' ? 'Reinstall' : 'Install'}
                    </button>
                    {!localRoot && <span>Open a folder to install</span>}
                    {localRoot && state?.phase === 'working' && <span>{state.text}</span>}
                    {localRoot && state?.phase === 'done' && <span>{state.text}</span>}
                    {localRoot && !state && record?.dir && <span>{record.dir}</span>}
                  </div>
                  {state?.phase === 'error' && <div className="stream-error">{state.text}</div>}
                </div>
              );
            })}
            {!hfCatalog.length && !hfCatalogLoading && <div className="empty">No HF skills loaded — sign in to Hugging Face for the full catalog.</div>}
          </div>
        </section>

        <section className="library-col">
          <h3 className="col-title">Skills on this engine ({skills.length})</h3>
          {error && <div className="stream-error">{error}</div>}
          <div className="skill-list">
            {skills.map((s) => (
              <button key={s.source + '/' + s.name} className={`skill-item ${open?.name === s.name ? 'active' : ''}`} onClick={() => show(s)}>
                <div className="skill-name">{s.name}</div>
                <div className="skill-desc">{s.description}</div>
                <div className="skill-src">{s.source}</div>
              </button>
            ))}
            {!skills.length && !loading && <div className="empty">No skills reported yet — refresh once the engine is reachable.</div>}
          </div>
        </section>

        <section className="library-col">
          {open ? (
            <>
              <h3 className="col-title">{open.name}</h3>
              <pre className="skill-content">{content}</pre>
            </>
          ) : (
            <>
              <h3 className="col-title">Chats on this machine ({chats.length})</h3>
              <div className="skill-list">
                {chats.map((c) => (
                  <button key={c.id} className="skill-item" onClick={() => openChat(c.id)}>
                    <div className="skill-name">{c.title || 'Untitled'}</div>
                    <div className="skill-src">{c.messages.length} messages · {new Date(c.updatedAt).toLocaleString()}</div>
                  </button>
                ))}
                {!chats.length && <div className="empty">Chats you start appear here, saved on this device only.</div>}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
