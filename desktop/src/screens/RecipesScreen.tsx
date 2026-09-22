import { useEffect, useRef, useState } from 'react';
import { pushToast } from '../components/Toasts';
import { NAVIGATE_EVENT } from '../Sidebar';
import { hasShell, mcpStdioList, notifyUser } from '../bridge';
import { streamChat } from '../api';
import { isSavedProvider, streamSaved } from '../run-model';
import { runTurn, type ToolEvent, type TurnOptions } from '../agent-turn';
import { executeTool, startStdio, stdioId } from '../tool-run';
import { newSession, PENDING_COMMAND_KEY, RUN_COMMAND_EVENT } from './ChatScreen';
import '../recipes.js';
import '../agents.js';
import '../chats.js';
import '../threads.js';
import '../tools.js';
import '../hf-auth.js';
import '../hf-inference.js';

const toolsLib: typeof import('../tools.js') = (globalThis as any).FreeAI4UTools;
const hfAuth: typeof import('../hf-auth.js') = (globalThis as any).FreeAI4UHfAuth;
const hfInference: typeof import('../hf-inference.js') = (globalThis as any).FreeAI4UHfInference;
const recipesLib: typeof import('../recipes.js') = (globalThis as any).FreeAI4URecipes;
const agentsLib: typeof import('../agents.js') = (globalThis as any).FreeAI4UAgents;
const chats: typeof import('../chats.js') = (globalThis as any).FreeAI4UChats;
const threads: typeof import('../threads.js') = (globalThis as any).FreeAI4UThreads;

type Recipe = import('../recipes.js').Recipe;
type RunEntry = import('../recipes.js').RunEntry;

// Recipes (roadmap 6.8), under Library: saved prompts with {{parameters}},
// the model and MCP servers they need, and an optional schedule.
//
//   * "Run in chat" hands `/recipe <id>` to Chat, which asks for consent the
//     first time a recipe's servers would start, and gives it their tools.
//   * "Run now" and the scheduler run it in the background, each into a new
//     chat titled "<recipe> · <time>", with a notification. They use Chat's
//     tool loop (runTurn + executeTool). A call that would ask pauses the
//     run (recipes.js backgroundGate): a notification, an approval card at
//     the top of this screen (Allow once / Deny / Always for this recipe),
//     and the answer resumes it; 30 minutes unanswered is the refusal it
//     always was (NEURA-036). Sub-agents and servers the recipe does not list
//     are still refused, and a local server starts only if this recipe
//     already has consent for it.

const RUN_TIMEOUT_MS = 180000;

type Target = { provider: string; model: string };

/** runTurn's stream for any model, with tools offered -- streamAny plus `offered`. */
const streamFor = (target: Target): TurnOptions['stream'] => (messages, offered, onFrame, signal) => {
  if (isSavedProvider(target.provider)) {
    return streamSaved(target.provider, target.model, messages as any, onFrame, signal, undefined, offered);
  }
  if (target.provider === 'hf') {
    return hfInference.streamChat(target.model, messages as any, onFrame, signal, hfAuth.accessToken()?.access_token || undefined, offered as any);
  }
  return streamChat(target.provider, { model: target.model, messages, ...(offered ? { tools: offered } : {}) }, onFrame, signal);
};

/**
 * Starts the recipe's local servers it already has consent for, and returns
 * the servers usable in this run plus notes for what was left out.
 */
async function prepareServers(recipe: Recipe): Promise<{ usable: string[]; notes: string[] }> {
  const servers = toolsLib.mcpServers();
  const running = hasShell() ? await mcpStdioList().catch(() => [] as string[]) : [];
  const plan = recipesLib.backgroundServers(recipe, servers.map((s) => ({
    name: s.name,
    stdio: toolsLib.isStdio(s),
    running: toolsLib.isStdio(s) && running.includes(stdioId(s)),
  })));
  const usable = plan.ready.slice();
  const notes: string[] = [];
  for (const name of plan.start) {
    const server = servers.find((s) => s.name === name);
    if (!server || !hasShell()) { notes.push(`${name} needs the installed desktop app to start.`); continue; }
    try {
      await startStdio(server);
      usable.push(name);
    } catch (e) {
      notes.push(`${name} did not start: ${toolsLib.splitStderr((e as Error).message || String(e)).message.split('\n')[0]}`);
    }
  }
  if (plan.skipped.length) {
    notes.push(`${plan.skipped.join(', ')} not started: this recipe has no consent to start ${plan.skipped.length > 1 ? 'them' : 'it'} yet. Run it from chat (\`/recipe ${recipe.id}\`) once to agree.`);
  }
  if (plan.missing.length) notes.push(`${plan.missing.join(', ')} ${plan.missing.length > 1 ? 'are' : 'is'} not in Settings → Connectors.`);
  return { usable, notes };
}

/**
 * One background run: the filled prompt to the recipe's model (or the most
 * recent chat's), the answer saved as a new chat. Records the run either way.
 */
export async function runRecipeInBackground(recipe: Recipe, values: Record<string, string> = {}, startedAt = Date.now()): Promise<RunEntry> {
  const done = (entry: Omit<RunEntry, 'at'>): RunEntry => {
    const row = { at: startedAt, ...entry };
    recipesLib.recordRun(recipe.id, row);
    return row;
  };
  const filled = recipesLib.fillTemplate(recipe.prompt, recipe.params, values);
  if (filled.missing.length) return done({ ok: false, error: `No value for ${filled.missing.join(', ')}; give the parameter a default.` });
  const recent = chats.byRecency(chats.readStore()).find((s: any) => s.provider && s.model);
  const target = recipe.model || (recent ? { provider: recent.provider, model: recent.model } : null);
  if (!target) return done({ ok: false, error: 'No model: set one on the recipe, or chat once so there is a model to use.' });
  const agent = recipesLib.asAgent(recipe);
  const controller = new AbortController();
  // The run's own clock stops while it waits for a person (NEURA-036); the
  // approval has its own, longer deadline (recipes.js APPROVAL_TIMEOUT_MS).
  let remaining = RUN_TIMEOUT_MS;
  let armedAt = Date.now();
  let clock: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(), remaining);
  const pauseClock = () => {
    if (clock === undefined) return;
    clearTimeout(clock);
    clock = undefined;
    remaining -= Date.now() - armedAt;
  };
  const resumeClock = () => {
    if (clock !== undefined) return;
    armedAt = Date.now();
    clock = setTimeout(() => controller.abort(), Math.max(remaining, 5000));
  };
  try {
    const toolsOn = toolsLib.enabled();
    const { usable, notes } = toolsOn ? await prepareServers(recipe) : { usable: [] as string[], notes: [] as string[] };
    // No folder is open for a background run, so the local file tools are
    // not offered. GitHub's reads are; its writes are too, and ask first.
    const offered = toolsOn
      ? recipesLib.backgroundOffer(recipe, toolsLib.catalogue({ github: true, localRoot: '', shell: false }), (n) => toolsLib.needsApproval(n), usable)
      : [];
    const usableFor = (name: string) => usable.some((s) => name.startsWith(`mcp__${toolsLib.slug(s)}__`));
    const gateFor = (name: string) => recipesLib.backgroundGate(recipe, { name, asks: toolsLib.needsApproval(name), usable: usableFor(name) });
    // What approve() decided for a call that asked: '' runs it, text is its
    // result instead (the refusal, when nobody answered in time).
    const verdicts = new Map<string, string>();
    const events: ToolEvent[] = [];
    let last = '';
    await runTurn({
      messages: agentsLib.messagesFor(agent, filled.text, []),
      tools: offered,
      stream: streamFor(target),
      // The one gate (recipes.js backgroundGate): 'refuse' gets the refusal as
      // its result, 'run' runs, and 'ask' runs only once approve() said yes.
      execute: (call, args) => {
        const verdict = verdicts.get(call.id);
        if (verdict !== undefined) return verdict ? Promise.resolve(verdict) : executeTool(call, args, { localRoot: '' });
        const gate = gateFor(call.name);
        return gate.action === 'run' ? executeTool(call, args, { localRoot: '' }) : Promise.resolve(gate.text);
      },
      // A call that would ask pauses the run: a notification, a card under
      // Library → Recipes, and the answer (or the timeout) resumes it.
      approve: async (event) => {
        const gate = gateFor(event.name);
        if (gate.action !== 'ask') return true; // execute() runs or refuses it
        pauseClock();
        const line = recipesLib.approvalText(recipe.name, event.summary || event.name);
        notifyUser(`${recipe.name} needs your approval`, line);
        pushToast('warn', `${line}. See Library → Recipes.`);
        const decision = await recipesLib.approvals.request({
          recipeId: recipe.id,
          recipeName: recipe.name,
          tool: event.name,
          summary: event.summary || event.name,
          asks: event.asks,
        });
        resumeClock();
        if (decision === 'deny') return false;
        verdicts.set(event.id, decision === 'timeout' ? gate.text : '');
        return true;
      },
      onText: (piece) => { last += piece; },
      onTool: (event) => {
        last = '';
        const at = events.findIndex((e) => e.id === event.id);
        if (at >= 0) events[at] = event; else events.push(event);
      },
      onNote: (note) => notes.push(note),
      signal: controller.signal,
    });
    const result = agentsLib.formatResult(agent, last);
    const note = notes.length ? `\n\n_${notes.join(' ')}_` : '';
    const session = {
      ...newSession(target.provider, target.model),
      title: recipesLib.runTitle(recipe, startedAt),
      messages: [
        { role: 'user' as const, content: filled.text, ts: startedAt },
        {
          role: 'assistant' as const,
          content: result.text + note,
          agent: recipe.name,
          model: target.model,
          provider: target.provider,
          providerLabel: target.provider,
          ts: Date.now(),
          ...(events.length ? { tools: events.map((e) => ({ ...e, startedAt, endedAt: Date.now() })) } : {}),
        },
      ],
    };
    chats.writeStore(null, [session, ...chats.readStore()]);
    window.dispatchEvent(new CustomEvent(chats.CHATS_CHANGED_EVENT));
    window.dispatchEvent(new Event(threads.CHANGED_EVENT));
    notifyUser(`${recipe.name} finished`, result.text.replace(/```[a-z]*|`|_/g, '').slice(0, 140));
    return done({ ok: true, chatId: session.id });
  } catch (e) {
    const message = (e as Error).name === 'AbortError' ? 'timed out' : ((e as Error).message || String(e)).split('\n')[0];
    notifyUser(`${recipe.name} failed`, message);
    return done({ ok: false, error: message });
  } finally {
    if (clock !== undefined) clearTimeout(clock);
  }
}

/**
 * The paused background runs' questions (NEURA-036), from recipes.js
 * approvals: one card each, Allow once / Deny / Always for this recipe.
 */
function RecipeApprovals() {
  const [pending, setPending] = useState(() => recipesLib.approvals.pending());
  useEffect(() => recipesLib.approvals.subscribe(setPending), []);
  if (!pending.length) return null;
  const minutesLeft = (at: number) => Math.max(1, Math.ceil((at - Date.now()) / 60000));
  return (
    <section className="recipe-approvals" aria-label="Recipes waiting for approval">
      {pending.map((p) => (
        <div key={p.id} className="recipe-approval" role="group" aria-label={`${p.recipeName} wants approval`}>
          <div className="recipe-approval-text">
            <span><strong>{p.recipeName}</strong> wants to {p.summary.charAt(0).toLowerCase() + p.summary.slice(1)}</span>
            <span className="recipe-approval-meta">
              {p.asks ? `It ${p.asks}. ` : ''}Denied automatically in {minutesLeft(p.expiresAt)} min.
            </span>
          </div>
          <div className="recipe-approval-actions">
            <button type="button" className="primary" onClick={() => recipesLib.approvals.answer(p.id, 'once')}>Allow once</button>
            <button type="button" onClick={() => recipesLib.approvals.answer(p.id, 'deny')}>Deny</button>
            <button type="button" onClick={() => recipesLib.approvals.answer(p.id, 'always')} title={`Always allow ${p.tool} for ${p.recipeName}`}>Always for this recipe</button>
          </div>
        </div>
      ))}
    </section>
  );
}

// The scheduler that calls runRecipeInBackground lives in ../schedulers.ts, so
// App can run it at start without pulling this screen into the first bundle.

interface Form {
  id: string;
  name: string;
  systemPrompt: string;
  prompt: string;
  params: string;
  extensions: string;
  provider: string;
  model: string;
  responseSchema: string;
  everyMinutes: string;
  dailyAt: string;
  enabled: boolean;
}

function toForm(r: Partial<Recipe>): Form {
  return {
    id: r.id || '',
    name: r.name || '',
    systemPrompt: r.systemPrompt || '',
    prompt: r.prompt || '',
    params: (r.params || []).map((p) => [p.name, p.label, p.default].join(' | ')).join('\n'),
    extensions: (r.extensions || []).join(', '),
    provider: r.model?.provider || '',
    model: r.model?.model || '',
    responseSchema: r.responseSchema ? JSON.stringify(r.responseSchema, null, 2) : '',
    everyMinutes: r.schedule?.everyMinutes ? String(r.schedule.everyMinutes) : '',
    dailyAt: r.schedule?.dailyAt || '',
    enabled: r.schedule ? r.schedule.enabled !== false : true,
  };
}

/** The form as raw recipe JSON (validated by recipes.js on save). */
function fromForm(f: Form): { raw: Record<string, any>; error: string } {
  const raw: Record<string, any> = {
    id: f.id.trim(),
    name: f.name.trim(),
    systemPrompt: f.systemPrompt,
    prompt: f.prompt,
    params: f.params.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
      const [name, label, ...rest] = line.split('|').map((s) => s.trim());
      return { name, label: label || name, default: rest.join(' | ') };
    }),
    extensions: f.extensions.split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (f.provider.trim() || f.model.trim()) raw.model = { provider: f.provider.trim(), model: f.model.trim() };
  if (f.responseSchema.trim()) {
    try { raw.responseSchema = JSON.parse(f.responseSchema); } catch { return { raw, error: 'Response schema is not valid JSON.' }; }
  }
  if (f.everyMinutes.trim() || f.dailyAt.trim()) {
    raw.schedule = { enabled: f.enabled };
    if (f.everyMinutes.trim()) raw.schedule.everyMinutes = Number(f.everyMinutes);
    if (f.dailyAt.trim()) raw.schedule.dailyAt = f.dailyAt.trim();
  }
  return { raw, error: '' };
}

export default function RecipesScreen() {
  const [recipes, setRecipes] = useState<Recipe[]>(() => recipesLib.list());
  const [runs, setRuns] = useState(() => recipesLib.lastRuns());
  const [selected, setSelected] = useState<string>(() => recipes[0]?.id || '');
  const [form, setForm] = useState<Form>(() => toForm(recipes[0] || recipesLib.template()));
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onChanged = () => { setRecipes(recipesLib.list()); setRuns(recipesLib.lastRuns()); };
    window.addEventListener(recipesLib.CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(recipesLib.CHANGED_EVENT, onChanged);
  }, []);

  const current = recipes.find((r) => r.id === selected) || null;
  const pick = (r: Recipe | null) => {
    setSelected(r?.id || '');
    setForm(toForm(r || recipesLib.template()));
    setJsonMode(false);
    setErrors([]);
  };
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const save = (raw: unknown) => {
    const result = recipesLib.save(raw);
    if (!result.ok || !result.recipe) { setErrors(result.errors); return null; }
    setErrors([]);
    const saved = result.recipe;
    // A schedule switched on starts counting now, not from "never run".
    if (saved.schedule?.enabled && saved.schedule.everyMinutes && !recipesLib.lastRuns()[saved.id]) {
      recipesLib.recordRun(saved.id, { at: Date.now(), ok: true, baseline: true });
    }
    setRecipes(recipesLib.list());
    setSelected(saved.id);
    setForm(toForm(saved));
    pushToast('ok', `Saved ${saved.name}.${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`);
    return saved;
  };

  const saveForm = () => {
    if (jsonMode) {
      try { save(JSON.parse(jsonText)); } catch (e) { setErrors([`Not valid JSON: ${(e as Error).message}`]); }
      return;
    }
    const { raw, error } = fromForm(form);
    if (error) { setErrors([error]); return; }
    save(raw);
  };

  const toggleJson = () => {
    if (!jsonMode) {
      const { raw } = fromForm(form);
      setJsonText(JSON.stringify(raw, null, 2));
      setJsonMode(true);
      return;
    }
    try {
      const checked = recipesLib.validate(JSON.parse(jsonText));
      if (!checked.ok || !checked.recipe) { setErrors(checked.errors); return; }
      setForm(toForm(checked.recipe));
      setErrors([]);
      setJsonMode(false);
    } catch (e) { setErrors([`Not valid JSON: ${(e as Error).message}`]); }
  };

  const toggleSchedule = (r: Recipe) => {
    if (!r.schedule) { pick(r); pushToast('info', 'Set "every N minutes" or "daily at" first, then save.'); return; }
    const on = r.schedule.enabled === false;
    const result = recipesLib.save({ ...r, schedule: { ...r.schedule, enabled: on } });
    if (result.ok && on && r.schedule.everyMinutes) recipesLib.recordRun(r.id, { at: Date.now(), ok: true, baseline: true });
    setRecipes(recipesLib.list());
    if (r.id === selected && result.recipe) setForm(toForm(result.recipe));
  };

  const runNow = (r: Recipe) => {
    setBusy(r.id);
    runRecipeInBackground(r)
      .then((row) => pushToast(row.ok ? 'ok' : 'error', row.ok ? `${r.name}: saved as a new chat.` : `${r.name}: ${row.error}`))
      .finally(() => setBusy(''));
  };

  const runInChat = (r: Recipe) => {
    try { sessionStorage.setItem(PENDING_COMMAND_KEY, `/recipe ${r.id}`); } catch { pushToast('warn', 'Could not hand the recipe to Chat.'); return; }
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { view: 'chat' } }));
    setTimeout(() => window.dispatchEvent(new Event(RUN_COMMAND_EVENT)), 50);
  };

  const remove = (r: Recipe) => {
    recipesLib.remove(r.id);
    const next = recipesLib.list();
    setRecipes(next);
    pick(next[0] || null);
    pushToast('info', `${r.name} deleted.`);
  };

  const download = (name: string, body: string) => {
    if (chats.downloadJson(name, body)) pushToast('ok', `Saved ${name}.`);
    else pushToast('warn', 'This window has no download surface.');
  };

  const importFile = (file: File) => {
    file.text().then((body) => {
      const result = recipesLib.parseImport(body);
      result.recipes.forEach((r) => recipesLib.save(r));
      const next = recipesLib.list();
      setRecipes(next);
      if (result.recipes.length) { pick(next.find((r) => r.id === result.recipes[0].id) || null); pushToast('ok', `Imported ${result.recipes.length} recipe${result.recipes.length === 1 ? '' : 's'}. Servers they name are asked about before they first start.`); }
      if (result.errors.length) pushToast('warn', result.errors.slice(0, 3).join(' '));
    });
  };

  const lastRunText = (id: string) => {
    const row = runs[id];
    if (!row) return 'never run';
    const when = new Date(row.at).toLocaleString();
    if (row.baseline) return `scheduled from ${when}`;
    return row.ok ? `last run ${when}` : `failed ${when}: ${row.error || ''}`;
  };

  const placeholders = recipesLib.placeholders(form.prompt);
  const undeclared = placeholders.filter((p) => !form.params.split(/\r?\n/).some((l) => l.split('|')[0].trim() === p));

  return (
    <div className="screen recipes">
      <header className="screen-header">
        <h1>Recipes</h1>
        <div className="header-actions">
          <button onClick={() => pick(null)}>New recipe</button>
          <button onClick={() => fileRef.current?.click()}>Import</button>
          <button onClick={() => download('neuraos-recipes.json', recipesLib.exportJson(recipes))} disabled={!recipes.length}>Export all</button>
        </div>
      </header>
      <RecipeApprovals />
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".json,application/json"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }}
      />
      <div className="ar-body">
        <nav className="ar-list" aria-label="Recipes">
          {recipes.map((r) => (
            <div key={r.id} className={`ar-item ar-recipe ${r.id === selected ? 'active' : ''}`}>
              <button className="ar-item-open" onClick={() => pick(r)} aria-current={r.id === selected ? 'true' : undefined}>
                <span className="ar-item-name">{r.name}</span>
                <span className="ar-item-meta">{recipesLib.scheduleLabel(r)} · {lastRunText(r.id)}</span>
              </button>
              <label className="toggle ar-sched" title={r.schedule ? 'Run on its schedule while the app is open' : 'No schedule set'}>
                <input type="checkbox" checked={!!r.schedule && r.schedule.enabled !== false} onChange={() => toggleSchedule(r)} aria-label={`Schedule ${r.name}`} />
              </label>
            </div>
          ))}
          {!recipes.length && <p className="settings-hint">No recipes yet. Fill in the form and save.</p>}
        </nav>

        <section className="ar-detail settings-card">
          <div className="ar-detail-head">
            <h2>{current ? current.name : 'New recipe'}</h2>
            {current && <span className="chip">{recipesLib.scheduleLabel(current)}</span>}
            <button className="linkish" onClick={toggleJson}>{jsonMode ? 'Back to the form' : 'Edit as JSON'}</button>
          </div>

          {jsonMode ? (
            <textarea className="ar-json mono" value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} rows={20} aria-label="Recipe JSON" />
          ) : (
            <div className="ar-form">
              <label>Id <input type="text" value={form.id} onChange={(e) => set({ id: e.target.value })} placeholder="daily-brief" spellCheck={false} /></label>
              <label>Name <input type="text" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Daily brief" /></label>
              <label className="ar-wide">System prompt <textarea value={form.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} rows={2} /></label>
              <label className="ar-wide">Prompt — <code>{'{{name}}'}</code> for a parameter
                <textarea value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={4} />
              </label>
              <label className="ar-wide">Parameters — one per line: <code>name | label | default</code>
                <textarea className="mono" value={form.params} onChange={(e) => set({ params: e.target.value })} rows={2} spellCheck={false} />
              </label>
              {undeclared.length > 0 && <p className="settings-hint ar-wide">Not declared (they will need a value each run): {undeclared.join(', ')}</p>}
              <label>Model service <input type="text" value={form.provider} onChange={(e) => set({ provider: e.target.value })} placeholder="the chat's" spellCheck={false} /></label>
              <label>Model <input type="text" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="the chat's" spellCheck={false} /></label>
              <label className="ar-wide">MCP servers it needs (comma-separated, names from Settings → Connectors)
                <input type="text" value={form.extensions} onChange={(e) => set({ extensions: e.target.value })} placeholder="browser, files" spellCheck={false} />
              </label>
              <label className="ar-wide">Response schema (optional JSON schema: the answer is checked and pretty-printed)
                <textarea className="mono" value={form.responseSchema} onChange={(e) => set({ responseSchema: e.target.value })} rows={2} spellCheck={false} />
              </label>
              <label>Every N minutes <input type="number" min={1} max={10080} value={form.everyMinutes} onChange={(e) => set({ everyMinutes: e.target.value })} /></label>
              <label>Daily at <input type="time" value={form.dailyAt} onChange={(e) => set({ dailyAt: e.target.value })} /></label>
              <label className="toggle ar-wide">
                <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                Schedule on (runs while NeuraOS is open; each run becomes a new chat)
              </label>
            </div>
          )}

          {errors.length > 0 && (
            <ul className="ar-errors" role="alert">
              {errors.map((err) => <li key={err}>{err}</li>)}
            </ul>
          )}
          <div className="ar-actions">
            <button className="primary" onClick={saveForm}>Save</button>
            {current && <button onClick={() => runInChat(current)}>Run in chat</button>}
            {current && <button onClick={() => runNow(current)} disabled={busy === current.id}>{busy === current.id ? 'Running…' : 'Run now'}</button>}
            {current && <button onClick={() => download(`${current.id}.recipe.json`, JSON.stringify(current, null, 2))}>Export</button>}
            {current && <button onClick={() => remove(current)}>Delete</button>}
          </div>
          {current && <p className="settings-hint">{lastRunText(current.id)}. In chat: <code>/recipe {current.id}{current.params.map((p) => ` ${p.name}=…`).join('')}</code></p>}
          <p className="settings-hint">
            Run in chat gives the recipe its servers' tools, and asks before a server is started for it the first time. Run
            now and scheduled runs answer in the background, into a new chat, using only tools that never ask: web and
            GitHub reads, and its servers' tools you set to "always allow" (a local server starts only once you agreed in chat).
          </p>
        </section>
      </div>
    </div>
  );
}
