import { useEffect, useRef, useState } from 'react';
import { pushToast } from '../components/Toasts';
import { NAVIGATE_EVENT } from '../Sidebar';
import { PENDING_COMMAND_KEY, RUN_COMMAND_EVENT } from './ChatScreen';
import '../agents.js';
import '../tools.js';
import '../chats.js';
import '../project-scout.js';

const agentsLib: typeof import('../agents.js') = (globalThis as any).FreeAI4UAgents;
const toolsLib: typeof import('../tools.js') = (globalThis as any).FreeAI4UTools;
const chats: typeof import('../chats.js') = (globalThis as any).FreeAI4UChats;
const scout: typeof import('../project-scout.js') = (globalThis as any).FreeAI4UProjectScout;

type Agent = import('../agents.js').Agent;
type ScoutStatus = import('../project-scout.js').ScoutStatus;

// Agents (roadmap 6.7), under Library: the definitions `/agent <id> <task>`
// runs and chat's spawn_agent delegates to. A definition is JSON and is edited
// as JSON -- the validator's errors are shown as you type, and nothing that
// fails it is saved. Built-ins can be edited (the edit is stored under the
// same id) and reset.

/** Whether spawn_agent runs without asking (tools.js keeps it with the MCP "always" answers). */
function spawnAlways(): boolean {
  try {
    const map = JSON.parse(localStorage.getItem(toolsLib.ALWAYS_KEY) || '{}');
    return !!(map && map[toolsLib.alwaysKey('spawn_agent')]);
  } catch { return false; }
}

/** When the map was built, in words a person reads faster than a timestamp. */
function agoLabel(at: number): string {
  if (!at) return '';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
}

/**
 * The project index (NEURA-056): built / stale / building, how much of the
 * folder it covers, and a Rebuild button. The index itself is built by whoever
 * holds the open folder -- this card only reads what was stored and asks, via
 * project-scout's REBUILD_EVENT, for a fresh map.
 */
function ProjectIndexCard() {
  const [index, setIndex] = useState(() => scout.load());
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    const onChanged = () => { setIndex(scout.load()); setBuilding(false); };
    window.addEventListener(scout.CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(scout.CHANGED_EVENT, onChanged);
  }, []);

  const state: ScoutStatus = scout.status(index, building);
  const rebuild = () => {
    setBuilding(true);
    scout.requestRebuild();
    pushToast('info', 'Rebuilding the project index.');
  };

  return (
    <div className="ar-index">
      <h3 className="local-heading">Project index</h3>
      <p className="settings-hint">
        <span className="chip">{state.label}</span>
        {state.state === 'none'
          ? ' No folder has been mapped yet. Open a folder in Code and rebuild.'
          : ` ${state.fileCount} files, ${state.symbolCount} symbols${state.builtAt ? `, built ${agoLabel(state.builtAt)}` : ''}.`}
      </p>
      {state.root && <p className="settings-hint mono">{state.root}</p>}
      {state.state === 'stale' && (
        <p className="settings-hint" role="status">
          The folder changed since this map was built ({state.reason}), so the scout says so instead of answering from it.
        </p>
      )}
      <div className="ar-actions">
        <button onClick={rebuild} disabled={building}>{building ? 'Rebuilding…' : 'Rebuild index'}</button>
      </div>
      <p className="settings-hint">
        The map is regex-level: it finds exported names, declarations and headings, and answers with paths and line
        numbers so the agent chooses what to read. It is not a parser, so anything indirect is missing.
      </p>
    </div>
  );
}

function setSpawnAlways(on: boolean) {
  if (on) { toolsLib.setAlways('spawn_agent'); return; }
  try {
    const map = JSON.parse(localStorage.getItem(toolsLib.ALWAYS_KEY) || '{}') || {};
    delete map[toolsLib.alwaysKey('spawn_agent')];
    localStorage.setItem(toolsLib.ALWAYS_KEY, JSON.stringify(map));
  } catch { /* the toggle just will not stick */ }
}

export default function AgentsScreen() {
  const [agents, setAgents] = useState<Agent[]>(() => agentsLib.list());
  const [selected, setSelected] = useState<string>(() => agents[0]?.id || '');
  const [text, setText] = useState('');
  const [task, setTask] = useState('');
  const [always, setAlways] = useState(spawnAlways);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onChanged = () => setAgents(agentsLib.list());
    window.addEventListener(agentsLib.CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(agentsLib.CHANGED_EVENT, onChanged);
  }, []);

  const current = agents.find((a) => a.id === selected) || null;
  // The editor follows the selection; unsaved text is dropped on switching.
  useEffect(() => { setText(current ? JSON.stringify(current, null, 2) : ''); }, [selected, current?.id]);

  let parsed: unknown = null;
  let parseError = '';
  try { parsed = text.trim() ? JSON.parse(text) : null; } catch (e) { parseError = `Not valid JSON: ${(e as Error).message}`; }
  const checked = parsed ? agentsLib.validate(parsed) : null;
  const errors = parseError ? [parseError] : (checked?.errors || []);
  const dirty = !!current && text !== JSON.stringify(current, null, 2);

  const save = () => {
    const result = agentsLib.save(parsed);
    if (!result.ok || !result.agent) { pushToast('error', result.errors[0] || 'Not saved.'); return; }
    setAgents(agentsLib.list());
    setSelected(result.agent.id);
    setText(JSON.stringify(result.agent, null, 2));
    pushToast('ok', `Saved ${result.agent.name}.${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`);
  };

  const create = () => {
    let draft = agentsLib.template();
    let n = 2;
    while (agents.some((a) => a.id === draft.id)) draft = { ...draft, id: `my-agent-${n++}` };
    const result = agentsLib.save(draft);
    if (result.ok && result.agent) { setAgents(agentsLib.list()); setSelected(result.agent.id); }
  };

  const remove = () => {
    if (!current) return;
    const builtin = agentsLib.isBuiltin(current.id);
    agentsLib.remove(current.id);
    const next = agentsLib.list();
    setAgents(next);
    if (!builtin) setSelected(next[0]?.id || '');
    else setText(JSON.stringify(next.find((a) => a.id === current.id), null, 2));
    pushToast('info', builtin ? `${current.name} is back to the shipped definition.` : `${current.name} deleted.`);
  };

  const download = (name: string, body: string) => {
    if (chats.downloadJson(name, body)) pushToast('ok', `Saved ${name}.`);
    else pushToast('warn', 'This window has no download surface.');
  };

  const importFile = (file: File) => {
    file.text().then((body) => {
      const result = agentsLib.parseImport(body);
      result.agents.forEach((a) => agentsLib.save(a));
      setAgents(agentsLib.list());
      if (result.agents.length) { setSelected(result.agents[0].id); pushToast('ok', `Imported ${result.agents.length} agent${result.agents.length === 1 ? '' : 's'}.`); }
      if (result.errors.length) pushToast('warn', result.errors.slice(0, 3).join(' '));
    });
  };

  const runInChat = () => {
    if (!current) return;
    try { sessionStorage.setItem(PENDING_COMMAND_KEY, `/agent ${current.id} ${task}`.trim()); } catch { pushToast('warn', 'Could not hand the task to Chat.'); return; }
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { view: 'chat' } }));
    setTimeout(() => window.dispatchEvent(new Event(RUN_COMMAND_EVENT)), 50);
    setTask('');
  };

  return (
    <div className="screen agents">
      <header className="screen-header">
        <h1>Agents</h1>
        <div className="header-actions">
          <button onClick={create}>New agent</button>
          <button onClick={() => fileRef.current?.click()}>Import</button>
          <button onClick={() => download('neuraos-agents.json', agentsLib.exportJson(agents))} disabled={!agents.length}>Export all</button>
        </div>
      </header>
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".json,application/json"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }}
      />
      <div className="ar-body">
        <nav className="ar-list" aria-label="Agents">
          {agents.map((a) => (
            <button key={a.id} className={`ar-item ${a.id === selected ? 'active' : ''}`} onClick={() => setSelected(a.id)} aria-current={a.id === selected ? 'true' : undefined}>
              <span className="ar-item-name">{a.name}</span>
              <span className="ar-item-meta mono">{a.id}{agentsLib.isBuiltin(a.id) ? (agentsLib.isOverridden(a.id) ? ' · edited' : ' · built-in') : ''}</span>
            </button>
          ))}
          <label className="toggle ar-always" title="spawn_agent normally shows an Allow / Deny card. The agent's own tools still ask either way.">
            <input type="checkbox" checked={always} onChange={(e) => { setSpawnAlways(e.target.checked); setAlways(e.target.checked); }} />
            Let chat start agents without asking
          </label>
        </nav>
        {current ? (
          <section className="ar-detail settings-card">
            <div className="ar-detail-head">
              <h2>{current.name}</h2>
              <span className="chip">{current.outputMode === 'structured' ? 'structured JSON' : 'last message'}</span>
              <span className="chip">{current.model ? `${current.model.provider} · ${current.model.model}` : "chat's model"}</span>
              {current.includeMessageHistory && <span className="chip">sees the chat</span>}
            </div>
            {current.description && <p className="settings-hint">{current.description}</p>}
            <p className="settings-hint">
              Tools: {current.toolNames.length ? current.toolNames.map((t) => <code key={t} className="ar-tool">{t}</code>) : 'none'}
              {current.toolNames.some((t) => t.includes('/')) ? ' — server/tool names come from Settings → Connectors.' : ''}
            </p>

            <div className="ar-run">
              <input
                type="text"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runInChat(); }}
                placeholder={current.spawnerPrompt || 'The task for this agent'}
                aria-label="Task for the agent"
              />
              <button className="primary" onClick={runInChat}>Run in chat</button>
            </div>

            {current.id === agentsLib.SCOUT_ID && <ProjectIndexCard />}

            <h3 className="local-heading">Definition</h3>
            <textarea
              className="ar-json mono"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={18}
              aria-label="Agent definition JSON"
              aria-invalid={errors.length > 0}
            />
            {errors.length > 0 && (
              <ul className="ar-errors" role="alert">
                {errors.map((err) => <li key={err}>{err}</li>)}
              </ul>
            )}
            {!errors.length && checked?.warnings.length ? <p className="settings-hint">{checked.warnings.join(' ')}</p> : null}
            <div className="ar-actions">
              <button className="primary" onClick={save} disabled={!dirty || errors.length > 0}>Save</button>
              <button onClick={() => setText(JSON.stringify(current, null, 2))} disabled={!dirty}>Revert</button>
              <button onClick={() => download(`${current.id}.agent.json`, JSON.stringify(current, null, 2))}>Export</button>
              {(!agentsLib.isBuiltin(current.id) || agentsLib.isOverridden(current.id)) && (
                <button onClick={remove}>{agentsLib.isBuiltin(current.id) ? 'Reset to built-in' : 'Delete'}</button>
              )}
            </div>
            <p className="settings-hint">
              Definitions are data only: fields such as <code>handleSteps</code> or any code are refused, so an imported agent can
              never run anything by itself. Unknown fields are dropped. In chat: <code>/agent {current.id} &lt;task&gt;</code>.
            </p>
          </section>
        ) : (
          <section className="ar-detail settings-card"><p className="settings-hint">No agent selected.</p></section>
        )}
      </div>
    </div>
  );
}
