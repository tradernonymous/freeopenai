// Remote build sessions: a plan written somewhere else (the phone's Plan mode,
// the web page, the desktop app) carried out on this server, one approved change
// at a time.
//
// The contract, as the Android app speaks it:
//   POST /api/build/sessions               { chatId, plan, repo?, branch? } -> { id, status, steps }
//   GET  /api/build/sessions               -> { enabled, reason, runEnabled, sessions[] }
//   GET  /api/build/sessions/:id           -> the session view
//   GET  /api/build/sessions/:id/events    -> SSE, one numbered event per frame
//   POST /api/build/sessions/:id/input     { text } | { requestId, decision, text? }
//   POST /api/build/sessions/:id/cancel
//
// What makes this safe to leave running is the approval gate, not the prompt.
// Every write, edit and command stops the loop and waits for an answer about
// that exact call -- the arguments are frozen when the question is asked, so
// what runs is what was shown. An answer for an older question is refused, a
// question nobody answers expires closed, and a path that leaves the session's
// own folder is refused before anyone is asked. Weak free models are the norm
// here, so the loop also parses tool calls written as text, stops a model that
// repeats itself, and keeps old tool output short.
//
// No dependencies, and nothing here knows about HTTP providers: the server
// injects how to call a model, search, fetch and run, which is what lets the
// tests drive the whole loop with a scripted model.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseToolCallText, stripToolCallText } = require('./tool-call-text');

const MAX_STEPS = 20;
const MAX_PLAN_CHARS = 20000;
const MAX_EVENTS = 500;
const MAX_SESSIONS = 30;
const MAX_ACTIVE_PER_OWNER = 2;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 30 * 60 * 1000;
// A real change to a real repository is a long run: clone, read the files that
// matter, edit, run the tests, read the failure, edit again, commit. The old
// ceilings (30 turns, 60 calls) ended ordinary work part-way, so these are set
// where a runaway is the only thing they stop. The last few turns before the
// ceiling are announced so a run ends with a summary instead of a cut.
const MAX_ROUNDS = 120;
const MAX_TOOL_CALLS = 300;
const MAX_CALLS_PER_ROUND = 8;
const WRAP_UP_ROUNDS = 3;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_NOTES_CHARS = 6000;
const REPEAT_WARN = 3;
const REPEAT_STOP = 5;
const MAX_FILE_WRITE_BYTES = 256 * 1024;
const MAX_FILE_READ_CHARS = 60000;
const MAX_TOOL_RESULT_CHARS = 8000;
const KEEP_FULL_TOOL_RESULTS = 6;
const TRIMMED_TOOL_RESULT_CHARS = 400;
const MAX_LIST_FILES = 200;
const HEARTBEAT_MS = 15000;

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'expired']);
const STEP_STATUSES = new Set(['pending', 'in_progress', 'done', 'failed', 'skipped']);

// --- The tools a build may use ---

const BUILD_TOOLS = [
  {
    name: 'step_update',
    description: 'Mark a plan step in_progress when you start it, and done, failed or skipped (with a short note) when it ends.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The step id, e.g. "1".' },
        status: { type: 'string', enum: ['in_progress', 'done', 'failed', 'skipped'] },
        note: { type: 'string' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in the build folder (or a subfolder of it), with sizes. .git and node_modules are skipped. Use find_files for a pattern and search_files for text.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder to list; omit for the whole build folder.' } } },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the build folder. Read a file before editing it. For a long file pass offset and limit (line numbers, 1-based) instead of reading it whole again.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', description: 'First line to return (1-based). Omit to start at the top.' },
        limit: { type: 'integer', description: 'How many lines to return. Omit for the whole file (capped).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search the text of every file in the build folder (or a subfolder) and return "path:line: text" for each match, so you find where something lives before reading whole files. Case-insensitive. Plain text by default; set regex to true for a regular expression. Use glob to limit which files are searched, e.g. "*.kt" or "src/**/*.js".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text or pattern to look for.' },
        path: { type: 'string', description: 'Folder to search inside; omit for the whole build folder.' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
        glob: { type: 'string', description: 'Only files whose path matches this glob, e.g. "*.ts" or "app/**/*.kt".' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_files',
    description: 'Find files by name pattern, e.g. "**/*.test.js", "src/**/Main*.kt" or "README.md". Returns matching paths. Use it instead of listing folder by folder.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'write_file',
    description: 'Create or replace a file in the build folder with the full new content. Waits for the user to approve.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace one exact piece of text in an existing file. Read the file first and copy old_text from it exactly, including indentation. old_text must appear exactly once unless all is true, so an edit can never land somewhere you did not mean; if it is not unique, include more surrounding lines. Prefer this over write_file for an existing file. Waits for the user to approve.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'The exact text to replace, copied from the file.' },
        new_text: { type: 'string', description: 'What to put in its place. An empty string deletes old_text.' },
        all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete one file from the build folder. Waits for the user to approve.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file inside the build folder. Waits for the user to approve.',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the build folder and read stdout, stderr and the exit code: install, build, run the tests, git. Use the file tools for reading, searching and editing files rather than cat, grep, sed or heredocs. Commands must not need input: pass non-interactive flags (npm init -y, --yes) and never use -i. git push works when the user has connected GitHub; force pushes and history rewrites are refused. Waits for the user to approve.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, cwd: { type: 'string', description: 'Subfolder to run in.' } },
      required: ['command'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'web_fetch',
    description: 'Read a public web page as text.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'ask_user',
    description: 'Ask the user one short question and wait for the answer.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
];

const BUILD_TOOL_NAMES = BUILD_TOOLS.map((t) => t.name);
const APPROVAL_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'move_file', 'run_command']);

const OPENAI_TOOLS = BUILD_TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

// Names weak models reach for instead of ours. Only these: a name that merely
// resembles a tool is refused rather than guessed at, because a guess that lands
// on run_command is a guess that runs something.
const TOOL_ALIASES = {
  bash: 'run_command', shell: 'run_command', exec: 'run_command', execute: 'run_command',
  run: 'run_command', command: 'run_command', terminal: 'run_command',
  cat: 'read_file', read: 'read_file', open_file: 'read_file', view_file: 'read_file',
  write: 'write_file', create_file: 'write_file', save_file: 'write_file',
  edit: 'edit_file', replace: 'edit_file', str_replace: 'edit_file', patch_file: 'edit_file',
  ls: 'list_files', list: 'list_files', list_dir: 'list_files', list_directory: 'list_files',
  grep: 'search_files', rg: 'search_files', grep_search: 'search_files', search_code: 'search_files', search_text: 'search_files',
  glob: 'find_files', find: 'find_files', file_search: 'find_files', find_file: 'find_files',
  rm: 'delete_file', remove: 'delete_file', remove_file: 'delete_file', unlink: 'delete_file',
  mv: 'move_file', rename: 'move_file', rename_file: 'move_file',
  search: 'web_search', websearch: 'web_search', google: 'web_search',
  fetch: 'web_fetch', browse: 'web_fetch', open_url: 'web_fetch',
  ask: 'ask_user', question: 'ask_user',
  update_step: 'step_update', task_update: 'step_update', todo_update: 'step_update',
};

function squash(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchToolName(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  if (BUILD_TOOL_NAMES.includes(raw)) return raw;
  const flat = squash(raw);
  const direct = BUILD_TOOL_NAMES.find((n) => squash(n) === flat);
  if (direct) return direct;
  const alias = Object.keys(TOOL_ALIASES).find((a) => squash(a) === flat);
  return alias ? TOOL_ALIASES[alias] : null;
}

// --- Plans ---

// A plan is prose with a list in it. Numbered lines win; bullets are the
// fallback; a plan with neither is one step, so the session still has something
// to tick off.
function planSteps(plan) {
  const lines = String(plan || '').split(/\r?\n/);
  const numbered = [];
  const bullets = [];
  for (const line of lines) {
    const n = /^\s*(?:step\s*)?(\d{1,3})[.):]\s+(.+?)\s*$/i.exec(line);
    if (n) { numbered.push(n[2]); continue; }
    const b = /^\s*[-*+]\s+(?:\[[ xX]?\]\s*)?(.+?)\s*$/.exec(line);
    if (b) bullets.push(b[1]);
  }
  const titles = (numbered.length ? numbered : bullets)
    .map((t) => t.replace(/\*\*/g, '').trim().slice(0, 200))
    .filter(Boolean);
  const chosen = titles.length ? titles.slice(0, MAX_STEPS) : ['Carry out the plan'];
  return chosen.map((title, i) => ({ id: String(i + 1), title, status: 'pending', note: '' }));
}

// --- Tool calls written as text ---

// Every balanced {...} in a string, scanning past braces inside JSON strings.
function jsonObjectsIn(text) {
  const out = [];
  const src = String(text || '');
  for (let start = src.indexOf('{'); start !== -1 && out.length < 8; start = src.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            out.push(JSON.parse(src.slice(start, i + 1)));
            start = i;
          } catch { /* not JSON; keep scanning from the next brace */ }
          break;
        }
      }
    }
  }
  return out;
}

function callFromObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : null;
  const rawName = fn ? fn.name : (obj.tool || obj.name || (typeof obj.function === 'string' ? obj.function : ''));
  const name = matchToolName(rawName);
  if (!name) return null;
  let args = fn ? fn.arguments : (obj.arguments !== undefined ? obj.arguments : obj.args !== undefined ? obj.args : obj.parameters !== undefined ? obj.parameters : obj.input);
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { id: 'text_' + crypto.randomBytes(4).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// Tagged shapes first (<tool_call>, <function=…>, <invoke>, [TOOL_CALLS]): a
// model that writes those meant every one of them, so all are kept, in order.
// Then fenced ```json blocks and any bare object, where one call per reply is
// what the text protocol asks for, so only the first usable one is taken.
function parseTextToolCalls(content) {
  const text = String(content || '');
  const tagged = parseToolCallText(text)
    .map((c) => ({ name: matchToolName(c.name), args: c.arguments }))
    .filter((c) => c.name)
    .map((c) => ({ id: 'text_' + crypto.randomBytes(4).toString('hex'), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  if (tagged.length) return tagged;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  for (const source of [...fences, text]) {
    for (const obj of jsonObjectsIn(source)) {
      const found = callFromObject(obj);
      if (found) return [found];
    }
  }
  return [];
}

// --- Small helpers ---

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashCall(name, args) {
  return crypto.createHash('sha256').update(name + '\n' + stableStringify(args)).digest('hex');
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

function cap(text, limit) {
  const value = String(text == null ? '' : text);
  return value.length <= limit ? value : value.slice(0, limit) + '\n…[' + (value.length - limit) + ' more characters]';
}

// A short line diff for the approval card: common head and tail kept as
// context, the changed middle shown as removed and added lines.
function lineDiff(before, after, maxLines = 160) {
  const a = before ? String(before).split('\n') : [];
  const b = String(after == null ? '' : after).split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out = [];
  for (let i = Math.max(0, head - 2); i < head; i++) out.push(' ' + a[i]);
  for (let i = head; i < a.length - tail; i++) out.push('-' + a[i]);
  for (let i = head; i < b.length - tail; i++) out.push('+' + b[i]);
  for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + 2); i++) out.push(' ' + a[i]);
  if (out.length > maxLines) return out.slice(0, maxLines).join('\n') + '\n…[' + (out.length - maxLines) + ' more lines]';
  return out.join('\n');
}

// Resolve a model-supplied path inside `dir`, or null. Absolute paths, drive
// letters, NUL bytes and climbs are refused outright; for a path that exists (or
// whose nearest existing ancestor does), the real path is checked too, so a
// symlink cannot carry a write outside.
function resolveInside(dir, rel) {
  const wanted = String(rel == null ? '' : rel).trim().replace(/\\/g, '/');
  if (wanted.includes('\0')) return null;
  if (path.isAbsolute(wanted) || /^[a-zA-Z]:/.test(wanted)) return null;
  const resolved = path.resolve(dir, wanted || '.');
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  let probe = resolved;
  while (!fs.existsSync(probe) && probe !== dir) probe = path.dirname(probe);
  try {
    const realDir = fs.realpathSync(dir);
    const realProbe = fs.realpathSync(probe);
    if (realProbe !== realDir && !realProbe.startsWith(realDir + path.sep)) return null;
  } catch {
    return null;
  }
  return resolved;
}

function relativeTo(dir, file) {
  return path.relative(dir, file).split(path.sep).join('/') || '.';
}

// Files a build must not change even with approval: git's own internals and
// anything shaped like a secrets file.
function protectedPath(rel) {
  const parts = rel.split('/');
  if (parts.includes('.git')) return 'Files inside .git are managed by git; use run_command with git instead.';
  const base = parts[parts.length - 1].toLowerCase();
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return 'Secrets files (.env) are never written by a build.';
  return '';
}

// Every file under root, depth first and sorted, skipping what no search
// wants (.git, node_modules). `visit` returns false to stop the walk.
function walkFiles(root, visit) {
  let going = true;
  const walk = (dir) => {
    if (!going) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const entry of entries) {
      if (!going) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && visit(full) === false) going = false;
    }
  };
  walk(root);
}

// Every line under `target` (a folder inside `dir`) that contains the query,
// as { path, line, text } with paths relative to `dir`. Case-insensitive
// text, or the caller's own RegExp; binaries and very large files skipped.
function searchFolder(dir, target, { query, matcher, glob } = {}) {
  const needle = String(query == null ? '' : query).toLowerCase();
  const only = glob ? globToRegExp(String(glob)) : null;
  const matches = [];
  let files = 0;
  walkFiles(target, (file) => {
    const rel = relativeTo(dir, file);
    if (only && !only.test(rel)) return true;
    files++;
    let content;
    try {
      if (fs.statSync(file).size > MAX_SEARCH_FILE_BYTES) return true;
      content = fs.readFileSync(file, 'utf8');
    } catch { return true; }
    if (content.includes('\0')) return true;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_RESULTS; i++) {
      const line = lines[i];
      if (matcher ? matcher.test(line) : line.toLowerCase().includes(needle)) {
        matches.push({ path: rel, line: i + 1, text: line.trim().slice(0, 300) });
      }
    }
    return matches.length < MAX_SEARCH_RESULTS;
  });
  return { matches, files, truncated: matches.length >= MAX_SEARCH_RESULTS };
}

// "src/**/*.kt" as a regular expression over a forward-slash relative path.
// ** crosses folders, * stays inside one, ? is one character.
function globToRegExp(glob) {
  const clean = String(glob || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '*') {
      if (clean[i + 1] === '*') {
        out += '(?:.*/)?';
        i++;
        if (clean[i + 1] === '/') i++;
        // "**" alone at the end matches everything below.
        if (i + 1 >= clean.length) out += '.*';
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$', 'i');
}

function listFiles(root, limit = MAX_LIST_FILES) {
  const out = [];
  const walk = (dir, prefix) => {
    if (out.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), rel); continue; }
      if (entry.isFile()) {
        try { out.push(rel + ' (' + fs.statSync(path.join(dir, entry.name)).size + ' bytes)'); } catch { /* vanished */ }
      }
    }
  };
  walk(root, '');
  return out;
}

// --- Prompts ---

function describeToolsAsText() {
  return BUILD_TOOLS.map((t) => {
    const props = Object.keys((t.parameters && t.parameters.properties) || {});
    return '- ' + t.name + '(' + props.join(', ') + '): ' + t.description;
  }).join('\n');
}

// Notes the project keeps for agents, read fresh each turn so a clone that
// lands mid-build is picked up. AGENTS.md is the cross-tool convention;
// CLAUDE.md is what most repositories actually have.
function projectNotes(dir) {
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md']) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8').trim();
      if (text) return { name, text: cap(text, MAX_PROJECT_NOTES_CHARS) };
    } catch { /* not there */ }
  }
  return null;
}

// Git that would hang waiting for an editor, or rewrite history nobody can get
// back. Every command is shown to the user first, but a hung command wastes
// their approval and a force push cannot be un-approved.
function refusedGit(command) {
  const text = String(command || '');
  if (!/\bgit\b/.test(text)) return '';
  if (/\bgit\b[^|;&\n]*\b(?:-i|--interactive)\b/.test(text)) return 'interactive git (-i) cannot be answered here.';
  if (/\bgit\s+push\b[^|;&\n]*(?:\s-f\b|--force(?!-with-lease)|--force-with-lease|\s\+\w)/.test(text)) return 'force pushes are refused; push a new commit instead.';
  if (/\bgit\s+(?:rebase|filter-branch|filter-repo)\b/.test(text) || /\bgit\s+commit\b[^|;&\n]*--amend/.test(text)) return 'history rewrites (rebase, amend, filter-branch) are refused; add a new commit instead.';
  if (/\bgit\s+(?:config\s+--global|config\s+--system)\b/.test(text)) return 'git config outside the repository is refused.';
  return '';
}

function systemPrompt(session, { runReason, textProtocol }) {
  const lines = [
    'You are the FreeAI4U build agent. You carry out an approved plan inside a private build folder on the server, working until the plan is done or you are truly blocked.',
    'All paths are relative to that folder. It starts empty unless you clone a repository into it.',
    'How to work:',
    '- Work through the steps in order. Call step_update with in_progress when a step starts, and done, failed or skipped (with a short note) when it ends. Exactly one step is in progress at a time.',
    '- Understand before changing: use find_files and search_files to locate what matters, then read_file. Read a file before editing it, and read it again after a failed edit.',
    '- Make several independent lookups in one turn (reads, searches, listings). Never put two edits to the same file in one turn.',
    '- Use edit_file for changes to an existing file, with old_text copied exactly and unique. Use write_file only for a new file or a full rewrite. Never create documentation or README files unless the plan asks.',
    '- Follow the code around you: match its style, imports and libraries; never assume a library is present, check how the project already does it.',
    '- Verify: find the project\'s own test, lint or build commands (README, package.json, build files) and run them after substantive changes. Do not mark a step done while tests fail or the work is partial. If you cannot find the command, ask once.',
    '- Fix the cause, not the symptom. Do not fix unrelated problems; mention them in the summary instead.',
    '- write_file, edit_file, delete_file, move_file and run_command each wait for the user to approve that exact call. Make each one a complete, reviewable change.',
    '- If the user rejects a call, read their reason and change your approach. Never repeat a rejected call unchanged. If the same fix fails three times, stop and ask_user.',
    '- If something is unclear and you cannot find out with the tools, call ask_user with one short question. Otherwise decide and continue.',
    '- Git: commit only when the plan asks for it, with a short message in the repository\'s style; never force push, amend, rebase or use -i; never commit .env or key files; do not push unless the plan says so.',
    '- You have no access to the server\'s keys or secrets. Never write secrets into files or print environment variables.',
    '- Keep replies short. Do not restate the plan or narrate each tool. When every step is finished, reply with a short summary (what changed, what you verified, what is left) and no tool call.',
  ];
  lines.push(runReason
    ? '- run_command is NOT available on this server (' + runReason + '). Do not plan around running commands.'
    : '- run_command is available (with approval). Commands run with a clean environment and a time limit, and must not wait for input.');
  if (session.repo) {
    const branch = session.branch ? ' --branch ' + session.branch : '';
    lines.push('- The user named the repository ' + session.repo + (session.branch ? ' (branch ' + session.branch + ')' : '') +
      '. To work on it, first run: git clone --depth 1' + branch + ' https://github.com/' + session.repo + '.git .');
  }
  if (session.ctx && session.ctx.git && session.ctx.git.login) {
    lines.push('- git push and private clones work as the connected GitHub account (' + session.ctx.git.login + '); the credential is supplied for you, never write a token into a URL.');
  } else {
    lines.push('- GitHub is not connected for this session, so git push and private clones will fail; public clones work. Say so in the summary if the plan needs a push.');
  }
  const notes = projectNotes(session.dir);
  if (notes) lines.push('', 'Project notes from ' + notes.name + ' (follow them):', notes.text);
  if (textProtocol) {
    lines.push('',
      'TOOLS: this model is called without native tool support. To use a tool, reply with ONLY one JSON object in a ```json fence, like:',
      '```json',
      '{"tool": "read_file", "arguments": {"path": "README.md"}}',
      '```',
      'One tool per reply. Available tools:',
      describeToolsAsText(),
      'When everything is finished, reply with the summary and no JSON.');
  }
  return lines.join('\n');
}

function userPrompt(session) {
  const steps = session.steps.map((s) => s.id + '. ' + s.title).join('\n');
  return 'Plan to carry out:\n\n' + session.plan + '\n\nSteps (use these ids with step_update):\n' + steps;
}

// Old tool output is what fills a small model's context. Keep the latest few
// results whole and shorten the rest; the model can always read a file again.
function compactMessages(messages) {
  const toolIdx = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool' || (m.role === 'user' && m.fromTool)) toolIdx.push(i);
  });
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_FULL_TOOL_RESULTS))) {
    const m = messages[i];
    if (typeof m.content === 'string' && m.content.length > TRIMMED_TOOL_RESULT_CHARS) {
      m.content = m.content.slice(0, TRIMMED_TOOL_RESULT_CHARS) + '\n…[older output trimmed]';
    }
  }
}

// What goes to the provider: our bookkeeping flag stripped.
function wireMessages(messages) {
  return messages.map((m) => {
    if (!m.fromTool) return m;
    const rest = { ...m };
    delete rest.fromTool;
    return rest;
  });
}

const APPROVE_WORDS = /^\s*(y|yes|yep|ok|okay|approve|approved|allow|go|go ahead|do it|run it|confirm|lgtm)\b[\s.!]*$/i;
const REJECT_WORDS = /^\s*(n|no|nope|reject|rejected|deny|denied|stop|cancel|skip)\b/i;

// --- The store ---

function createBuildSessions(deps) {
  const opts = {
    approvalTtlMs: APPROVAL_TTL_MS,
    maxRounds: MAX_ROUNDS,
    maxToolCalls: MAX_TOOL_CALLS,
    maxSessions: MAX_SESSIONS,
    maxActivePerOwner: MAX_ACTIVE_PER_OWNER,
    sessionTtlMs: SESSION_TTL_MS,
    now: () => Date.now(),
    ...deps,
  };
  const sessions = new Map();
  const buildsRoot = path.join(opts.rootDir, 'builds');

  function emit(session, type, data = {}) {
    const event = { ...data, seq: ++session.seq, type, ts: opts.now() };
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) session.events.shift();
    session.updatedAt = event.ts;
    for (const listener of [...session.listeners]) {
      try { listener(event); } catch { /* a broken listener must not stop the build */ }
    }
    return event;
  }

  function setStatus(session, status) {
    if (session.status === status) return;
    session.status = status;
    emit(session, 'status', { status });
  }

  function view(session) {
    const p = session.pending;
    return {
      id: session.id,
      chatId: session.chatId,
      status: session.status,
      steps: session.steps.map((s) => ({ ...s })),
      plan: session.plan,
      repo: session.repo,
      branch: session.branch,
      provider: session.provider,
      model: session.model,
      dir: 'builds/' + session.id,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      finishedAt: session.finishedAt,
      summary: session.summary,
      error: session.error,
      lastSeq: session.seq,
      pending: p ? {
        requestId: p.requestId,
        kind: p.kind,
        tool: p.tool,
        summary: p.summary,
        preview: p.preview,
        question: p.question,
        expiresAt: p.expiresAt,
      } : null,
    };
  }

  function summaryView(session) {
    const v = view(session);
    delete v.plan;
    return v;
  }

  function sweep() {
    const now = opts.now();
    for (const [id, s] of sessions) {
      if (TERMINAL.has(s.status) && now - (s.finishedAt || s.updatedAt) > opts.sessionTtlMs) sessions.delete(id);
    }
  }

  function makeRoom() {
    if (sessions.size < opts.maxSessions) return true;
    const finished = [...sessions.values()].filter((s) => TERMINAL.has(s.status))
      .sort((a, b) => (a.finishedAt || a.updatedAt) - (b.finishedAt || b.updatedAt));
    if (!finished.length) return false;
    sessions.delete(finished[0].id);
    return true;
  }

  // Returns the session, or { error, status } when one cannot be started.
  function tryCreate(input) {
    sweep();
    const body = input && typeof input === 'object' ? input : {};
    const plan = String(body.plan || '').trim();
    if (!plan) return { status: 400, error: 'plan is required' };
    if (plan.length > MAX_PLAN_CHARS) return { status: 400, error: 'That plan is too long (max ' + MAX_PLAN_CHARS + ' characters)' };
    const repo = String(body.repo || '').trim();
    if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { status: 400, error: 'repo must look like owner/name' };
    const branch = String(body.branch || '').trim();
    if (branch && !/^[A-Za-z0-9._/-]{1,100}$/.test(branch)) return { status: 400, error: 'That branch name is not valid' };
    const owner = body.owner == null ? null : String(body.owner);
    const active = [...sessions.values()].filter((s) => s.owner === owner && !TERMINAL.has(s.status)).length;
    if (active >= opts.maxActivePerOwner) {
      return { status: 429, error: 'You already have ' + active + ' builds running. Finish or cancel one first.' };
    }
    const choice = opts.pickModel({ provider: body.provider, model: body.model });
    if (!choice) return { status: 503, error: 'No chat provider is configured that can run a build. Add a provider key on the server.' };
    if (!makeRoom()) return { status: 429, error: 'Too many builds are running on this server right now.' };

    const id = crypto.randomBytes(12).toString('hex');
    const dir = path.join(buildsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    const now = opts.now();
    const session = {
      id,
      owner,
      chatId: String(body.chatId || '').slice(0, 200),
      plan,
      repo,
      branch,
      provider: choice.provider,
      model: choice.model,
      steps: planSteps(plan),
      status: 'queued',
      startedAt: now,
      updatedAt: now,
      finishedAt: 0,
      summary: '',
      error: '',
      dir,
      seq: 0,
      events: [],
      listeners: new Set(),
      pending: null,
      settlePending: null,
      pendingTimer: null,
      cancelled: false,
      ctx: body.ctx || null,
    };
    sessions.set(id, session);
    emit(session, 'status', { status: 'queued' });
    setTimeout(() => {
      run(session).catch((err) => finish(session, 'failed', { error: 'The build stopped unexpectedly: ' + (err && err.message) }));
    }, 0);
    return session;
  }

  function create(input) {
    const result = tryCreate(input);
    if (result && result.error) {
      const err = new Error(result.error);
      err.statusCode = result.status;
      throw err;
    }
    return result;
  }

  function get(id, owner) {
    const s = sessions.get(String(id || ''));
    if (!s) return null;
    if (s.owner !== (owner == null ? null : String(owner))) return null;
    return s;
  }

  function list(owner) {
    sweep();
    const who = owner == null ? null : String(owner);
    return [...sessions.values()]
      .filter((s) => s.owner === who)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(summaryView);
  }

  function subscribe(session, afterSeq, listener) {
    const after = Number(afterSeq) || 0;
    const first = session.events.length ? session.events[0].seq : session.seq + 1;
    if (after > 0 && after < first - 1) listener({ type: 'gap', seq: after, from: first, ts: opts.now() });
    for (const event of session.events) {
      if (event.seq > after) listener(event);
    }
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  function clearPending(session) {
    if (session.pendingTimer) clearTimeout(session.pendingTimer);
    session.pendingTimer = null;
    const settle = session.settlePending;
    session.pending = null;
    session.settlePending = null;
    if (settle) settle({ decision: 'cancelled' });
  }

  function finish(session, status, data = {}) {
    if (TERMINAL.has(session.status)) return;
    session.finishedAt = opts.now();
    if (data.summary) session.summary = String(data.summary).slice(0, 8000);
    if (data.error) session.error = String(data.error).slice(0, 2000);
    setStatus(session, status);
    if (status === 'done') emit(session, 'done', { status, summary: session.summary });
    else emit(session, 'failed', { status, error: session.error || status });
    clearPending(session);
  }

  // Ask, and wait. Resolves with { decision: approve|reject|answer|expired|cancelled, text }.
  function waitFor(session, pending) {
    return new Promise((resolve) => {
      const requestId = crypto.randomBytes(12).toString('hex');
      const now = opts.now();
      session.pending = { ...pending, requestId, createdAt: now, expiresAt: now + opts.approvalTtlMs };
      session.settlePending = (outcome) => resolve(outcome);
      session.pendingTimer = setTimeout(() => {
        const settle = session.settlePending;
        session.pending = null;
        session.settlePending = null;
        session.pendingTimer = null;
        if (settle) settle({ decision: 'expired' });
      }, opts.approvalTtlMs);
      if (session.pendingTimer.unref) session.pendingTimer.unref();
      if (pending.kind === 'question') {
        setStatus(session, 'awaiting_input');
        emit(session, 'question', { requestId, question: pending.question });
      } else {
        setStatus(session, 'awaiting_approval');
        emit(session, 'approval', { requestId, tool: pending.tool, summary: pending.summary, preview: pending.preview });
      }
    });
  }

  function input(session, body) {
    const b = body && typeof body === 'object' ? body : {};
    if (TERMINAL.has(session.status)) return { status: 409, error: 'This build has already finished.' };
    const p = session.pending;
    if (!p) return { status: 409, error: 'Nothing is waiting for an answer right now.' };
    if (b.requestId && String(b.requestId) !== p.requestId) {
      return { status: 409, error: 'That answer is for an earlier request. Reload the build and answer the current one.' };
    }
    const text = typeof b.text === 'string' ? b.text.trim().slice(0, 4000) : '';
    let decision = '';
    if (p.kind === 'question') {
      if (!text) return { status: 400, error: 'An answer is required.' };
      decision = 'answer';
    } else if (b.decision === 'approve' || b.decision === 'reject') {
      decision = b.decision;
    } else if (text) {
      decision = APPROVE_WORDS.test(text) ? 'approve' : 'reject';
    } else {
      return { status: 400, error: 'Send decision "approve" or "reject", or a text answer.' };
    }
    const settle = session.settlePending;
    if (session.pendingTimer) clearTimeout(session.pendingTimer);
    session.pending = null;
    session.settlePending = null;
    session.pendingTimer = null;
    // "no" on its own is a decision, not feedback worth passing to the model.
    const feedback = decision === 'reject' && REJECT_WORDS.test(text) && text.length < 12 ? '' : text;
    emit(session, 'answer', { requestId: p.requestId, decision, text: feedback });
    setStatus(session, 'running');
    settle({ decision, text: feedback });
    return { status: 200, decision };
  }

  function cancel(session) {
    if (TERMINAL.has(session.status)) return view(session);
    session.cancelled = true;
    finish(session, 'cancelled', { error: 'Cancelled by the user.' });
    return view(session);
  }

  // --- Running tools ---

  function currentStepId(session) {
    const active = session.steps.find((s) => s.status === 'in_progress') || session.steps.find((s) => s.status === 'pending');
    return active ? active.id : '';
  }

  async function approvalFor(session, tool, summary, preview) {
    const outcome = await waitFor(session, { kind: 'approval', tool, summary, preview: cap(preview, 12000) });
    if (outcome.decision === 'approve') return { approved: true };
    if (outcome.decision === 'expired') {
      finish(session, 'expired', { error: 'No one approved "' + summary + '" within ' + Math.max(1, Math.round(opts.approvalTtlMs / 60000)) + ' minutes, so the build stopped.' });
      return { approved: false, stop: true };
    }
    if (outcome.decision === 'cancelled') return { approved: false, stop: true };
    return {
      approved: false,
      result: 'The user rejected this ' + tool + ' call' + (outcome.text ? ': "' + outcome.text + '"' : '.') +
        ' Nothing was changed. Do not repeat the same call; adjust your approach, ask_user, or finish.',
    };
  }

  async function executeTool(session, name, args) {
    const dir = session.dir;
    switch (name) {
      case 'step_update': {
        const step = session.steps.find((s) => s.id === String(args.id == null ? '' : args.id).trim());
        if (!step) return 'Unknown step id "' + args.id + '". Valid ids: ' + session.steps.map((s) => s.id).join(', ');
        const status = String(args.status || '');
        if (!STEP_STATUSES.has(status) || status === 'pending') return 'status must be in_progress, done, failed or skipped';
        step.status = status;
        step.note = String(args.note || '').slice(0, 500);
        emit(session, 'step', { id: step.id, phase: status === 'in_progress' ? 'started' : status, title: step.title, text: step.note });
        const open = session.steps.filter((s) => s.status === 'pending' || s.status === 'in_progress').length;
        return 'Step ' + step.id + ' is now ' + status + '. ' + open + ' step(s) still open.';
      }
      case 'list_files': {
        const target = resolveInside(dir, args.path || '.');
        if (!target) return 'Refused: that path is outside the build folder.';
        const files = listFiles(target);
        return files.length ? files.join('\n') : '(no files yet)';
      }
      case 'read_file': {
        const target = resolveInside(dir, args.path);
        if (!target || target === dir) return 'Refused: that path is outside the build folder.';
        let text;
        try {
          text = fs.readFileSync(target, 'utf8');
        } catch (err) {
          return 'Could not read ' + args.path + ': ' + (err.code === 'ENOENT' ? 'no such file' : err.message);
        }
        const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
        const limit = Math.floor(Number(args.limit) || 0);
        if (offset > 1 || limit > 0) {
          const all = text.split('\n');
          const slice = all.slice(offset - 1, limit > 0 ? offset - 1 + limit : undefined);
          const head = 'Lines ' + offset + '-' + (offset + slice.length - 1) + ' of ' + all.length + ':\n';
          return cap(head + slice.join('\n'), MAX_FILE_READ_CHARS);
        }
        return cap(text, MAX_FILE_READ_CHARS);
      }
      case 'search_files': {
        const query = String(args.query == null ? '' : args.query);
        if (!query.trim()) return 'search_files needs a query.';
        const target = resolveInside(dir, args.path || '.');
        if (!target) return 'Refused: that path is outside the build folder.';
        let matcher;
        try {
          matcher = args.regex ? new RegExp(query, 'i') : null;
        } catch (err) {
          return 'That regular expression is not valid: ' + err.message;
        }
        const found = searchFolder(dir, target, { query, matcher, glob: args.glob });
        if (!found.matches.length) return 'No matches for "' + query + '" in ' + found.files + ' file(s).';
        const hits = found.matches.map((m) => m.path + ':' + m.line + ': ' + m.text);
        const more = found.truncated ? '\n…[stopped at ' + MAX_SEARCH_RESULTS + ' matches; narrow the query or path]' : '';
        return cap(hits.join('\n') + more, MAX_TOOL_RESULT_CHARS * 2);
      }
      case 'find_files': {
        const pattern = String(args.pattern || '').trim();
        if (!pattern) return 'find_files needs a pattern.';
        const re = globToRegExp(pattern);
        const found = [];
        walkFiles(dir, (file) => {
          const rel = relativeTo(dir, file);
          if (re.test(rel) || re.test(rel.split('/').pop())) found.push(rel);
          return found.length < MAX_LIST_FILES;
        });
        return found.length ? found.join('\n') : 'No files match "' + pattern + '".';
      }
      case 'delete_file': {
        const target = resolveInside(dir, args.path);
        if (!target || target === dir) return 'Refused: that path is outside the build folder.';
        const rel = relativeTo(dir, target);
        const blocked = protectedPath(rel);
        if (blocked) return 'Refused: ' + blocked;
        let stat;
        try { stat = fs.statSync(target); } catch { return 'No such file: ' + rel; }
        if (!stat.isFile()) return 'Refused: ' + rel + ' is not a file. Delete files one at a time.';
        const verdict = await approvalFor(session, name, 'Delete ' + rel, 'Delete ' + rel + ' (' + stat.size + ' bytes)');
        if (verdict.stop) return null;
        if (!verdict.approved) return verdict.result;
        fs.unlinkSync(target);
        emit(session, 'diff', { path: rel, patch: '', bytes: 0, created: false, deleted: true });
        return 'Deleted ' + rel + '.';
      }
      case 'move_file': {
        const from = resolveInside(dir, args.from);
        const to = resolveInside(dir, args.to);
        if (!from || from === dir || !to || to === dir) return 'Refused: both paths must stay inside the build folder.';
        const relFrom = relativeTo(dir, from);
        const relTo = relativeTo(dir, to);
        const blocked = protectedPath(relFrom) || protectedPath(relTo);
        if (blocked) return 'Refused: ' + blocked;
        if (!fs.existsSync(from)) return 'No such file: ' + relFrom;
        if (fs.existsSync(to)) return 'Refused: ' + relTo + ' already exists. Delete it first if you mean to replace it.';
        const verdict = await approvalFor(session, name, 'Move ' + relFrom + ' → ' + relTo, 'Move ' + relFrom + '\n  to ' + relTo);
        if (verdict.stop) return null;
        if (!verdict.approved) return verdict.result;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        emit(session, 'diff', { path: relTo, patch: '', bytes: 0, created: false, movedFrom: relFrom });
        return 'Moved ' + relFrom + ' to ' + relTo + '.';
      }
      case 'write_file':
      case 'edit_file': {
        const target = resolveInside(dir, args.path);
        if (!target || target === dir) return 'Refused: that path is outside the build folder. Use a relative path inside it.';
        const rel = relativeTo(dir, target);
        const blocked = protectedPath(rel);
        if (blocked) return 'Refused: ' + blocked;
        let before = '';
        const exists = fs.existsSync(target);
        if (exists) {
          try { before = fs.readFileSync(target, 'utf8'); } catch (err) { return 'Could not read ' + rel + ': ' + err.message; }
        }
        let after;
        if (name === 'write_file') {
          if (typeof args.content !== 'string') return 'write_file needs content (the whole file as a string).';
          after = args.content;
        } else {
          if (!exists) return 'edit_file needs an existing file; use write_file to create ' + rel + '.';
          const oldText = String(args.old_text == null ? '' : args.old_text);
          if (!oldText) return 'edit_file needs old_text: the exact text to replace.';
          const count = before.split(oldText).length - 1;
          const newText = String(args.new_text == null ? '' : args.new_text);
          if (count === 0) return 'old_text was not found in ' + rel + '. Read the file and copy the text exactly.';
          if (count > 1 && !args.all) return 'old_text appears ' + count + ' times in ' + rel + '. Include more surrounding lines so it is unique, or set all to true.';
          after = args.all ? before.split(oldText).join(newText) : before.replace(oldText, () => newText);
        }
        if (Buffer.byteLength(after, 'utf8') > MAX_FILE_WRITE_BYTES) return 'Refused: files over ' + (MAX_FILE_WRITE_BYTES / 1024) + ' KB are not written by a build.';
        if (exists && after === before) return 'No change: ' + rel + ' already has that content.';
        const patch = lineDiff(before, after);
        const verdict = await approvalFor(session, name, (exists ? 'Change ' : 'Create ') + rel, patch);
        if (verdict.stop) return null;
        if (!verdict.approved) return verdict.result;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, after);
        emit(session, 'diff', { path: rel, patch: cap(patch, 12000), bytes: Buffer.byteLength(after, 'utf8'), created: !exists });
        return (exists ? 'Updated ' : 'Created ') + rel + ' (' + Buffer.byteLength(after, 'utf8') + ' bytes).';
      }
      case 'run_command': {
        const refusal = opts.runRefusal();
        if (refusal) return 'run_command is not available: ' + refusal;
        const command = String(args.command || '').trim();
        if (!command) return 'run_command needs a command.';
        if (command.length > 4000) return 'Refused: that command is too long.';
        const gitRefusal = refusedGit(command);
        if (gitRefusal) return 'Refused: ' + gitRefusal;
        const cwd = resolveInside(dir, args.cwd || '.');
        if (!cwd) return 'Refused: cwd is outside the build folder.';
        const where = relativeTo(dir, cwd);
        const git = /\bgit\b/.test(command) && session.ctx && session.ctx.git ? session.ctx.git : null;
        const preview = '$ ' + command + (where !== '.' ? '\n(in ' + where + ')' : '') + (git && git.login ? '\n(git runs as your GitHub account ' + git.login + ')' : '');
        const verdict = await approvalFor(session, name, 'Run: ' + command.slice(0, 200), preview);
        if (verdict.stop) return null;
        if (!verdict.approved) return verdict.result;
        const stepId = currentStepId(session);
        let result;
        try {
          result = await opts.runCommand({ command, cwd, git });
        } catch (err) {
          result = { stdout: '', stderr: String(err && err.message), exitCode: -1 };
        }
        if (session.cancelled || TERMINAL.has(session.status)) return null;
        const exit = result.timedOut ? 'timed out' : 'exit ' + (result.exitCode == null ? '?' : result.exitCode);
        const output = ((result.stdout || '') + (result.stderr ? '\n[stderr]\n' + result.stderr : '')).trim();
        emit(session, 'step', { id: stepId, phase: 'output', title: '$ ' + command.slice(0, 200), text: cap(exit + '\n' + output, 12000), exitCode: result.exitCode });
        return cap('$ ' + command + '\n' + exit + '\n' + output, MAX_TOOL_RESULT_CHARS);
      }
      case 'web_search': {
        const query = String(args.query || '').trim();
        if (!query) return 'web_search needs a query.';
        try {
          const found = await opts.webSearch(query);
          const rows = (found && found.results) || [];
          if (!rows.length) return 'No results for "' + query + '".';
          return rows.slice(0, 8).map((r, i) => (i + 1) + '. ' + r.title + ' — ' + r.url + (r.snippet ? '\n   ' + r.snippet : '')).join('\n');
        } catch (err) {
          return 'Search failed: ' + (err && err.message);
        }
      }
      case 'web_fetch': {
        const url = String(args.url || '').trim();
        if (!url) return 'web_fetch needs a url.';
        try {
          const page = await opts.webFetch(url);
          return cap((page.title ? page.title + '\n\n' : '') + (page.text || ''), MAX_TOOL_RESULT_CHARS);
        } catch (err) {
          return 'Could not read that page: ' + (err && err.message);
        }
      }
      case 'ask_user': {
        const question = String(args.question || '').trim().slice(0, 1000);
        if (!question) return 'ask_user needs a question.';
        const outcome = await waitFor(session, { kind: 'question', question });
        if (outcome.decision === 'expired') {
          finish(session, 'expired', { error: 'The question "' + question.slice(0, 120) + '" was not answered in time, so the build stopped.' });
          return null;
        }
        if (outcome.decision !== 'answer') return null;
        return 'The user answered: ' + outcome.text;
      }
      default:
        return 'Unknown tool. Available: ' + BUILD_TOOL_NAMES.join(', ');
    }
  }

  // --- The loop ---

  async function run(session) {
    if (session.cancelled) return;
    setStatus(session, 'running');
    let textProtocol = false;
    let reminders = 0;
    let calls = 0;
    const repeats = new Map();
    const promptFor = () => systemPrompt(session, { runReason: opts.runRefusal(), textProtocol });
    const messages = [
      { role: 'system', content: promptFor() },
      { role: 'user', content: userPrompt(session) },
    ];

    let warned = false;
    for (let round = 1; round <= opts.maxRounds; round++) {
      if (session.cancelled || TERMINAL.has(session.status)) return;
      messages[0].content = promptFor();
      // The ceiling is announced before it lands, so the run ends with the
      // summary it owes rather than a cut mid-step.
      const roundsLeft = opts.maxRounds - round;
      const callsLeft = opts.maxToolCalls - calls;
      if (!warned && (roundsLeft < WRAP_UP_ROUNDS || callsLeft < MAX_CALLS_PER_ROUND * WRAP_UP_ROUNDS)) {
        warned = true;
        messages.push({
          role: 'user',
          content: 'You are almost out of turns (' + roundsLeft + ' left, ' + Math.max(0, callsLeft) + ' tool calls). Finish the current step if one call does it, mark the rest with step_update, then reply with the summary: what changed, what was verified, what is left and how to continue.',
        });
      }
      let reply;
      try {
        reply = await opts.callModel({
          provider: session.provider,
          model: session.model,
          messages: wireMessages(messages),
          tools: textProtocol ? undefined : OPENAI_TOOLS,
          ctx: session.ctx,
        });
      } catch (err) {
        reply = { ok: false, error: err && err.message };
      }
      if (session.cancelled || TERMINAL.has(session.status)) return;
      if (!reply || !reply.ok) {
        if (reply && reply.toolsRejected && !textProtocol) {
          textProtocol = true;
          emit(session, 'message', { text: 'This model refused native tools, so the build continues with tool calls written as JSON.' });
          round--;
          continue;
        }
        finish(session, 'failed', { error: (reply && reply.error) || 'The model did not answer.' });
        return;
      }

      const message = reply.message || {};
      const content = textOf(message.content).trim();
      let toolCalls = !textProtocol && Array.isArray(message.tool_calls) ? message.tool_calls.filter((c) => c && c.function) : [];
      if (!toolCalls.length) toolCalls = parseTextToolCalls(content);
      // A call written as text is shown as the step it became, not as markup.
      const shown = toolCalls.length ? stripToolCallText(content) : content;
      if (shown) emit(session, 'message', { text: cap(shown, 4000) });

      if (!toolCalls.length) {
        const open = session.steps.filter((s) => s.status === 'pending' || s.status === 'in_progress');
        if (open.length && reminders < 2) {
          reminders++;
          messages.push({ role: 'assistant', content: content || '(no reply)' });
          messages.push({
            role: 'user',
            content: 'These steps are still open: ' + open.map((s) => s.id + '. ' + s.title).join('; ') +
              '. Continue with tool calls, or call step_update to mark a step done or skipped with a reason, then give the final summary.',
          });
          continue;
        }
        finish(session, 'done', { summary: content || 'The build finished.' });
        return;
      }

      const batch = toolCalls.slice(0, MAX_CALLS_PER_ROUND).map((c, i) => ({
        id: c.id || 'call_' + round + '_' + i,
        type: 'function',
        function: {
          name: String(c.function.name || ''),
          arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}),
        },
      }));
      if (textProtocol) messages.push({ role: 'assistant', content });
      else messages.push({ role: 'assistant', content: content || null, tool_calls: batch });

      for (const call of batch) {
        calls++;
        if (calls > opts.maxToolCalls) {
          finish(session, 'failed', { error: 'The build used its budget of ' + opts.maxToolCalls + ' tool calls without finishing.' });
          return;
        }
        const name = matchToolName(call.function.name);
        const args = parseArgs(call.function.arguments);
        let result;
        if (!name) {
          result = 'Unknown tool "' + call.function.name + '". Available: ' + BUILD_TOOL_NAMES.join(', ');
        } else {
          const key = hashCall(name, args);
          const count = (repeats.get(key) || 0) + 1;
          repeats.set(key, count);
          if (count >= REPEAT_STOP) {
            finish(session, 'failed', { error: 'The model kept repeating the same ' + name + ' call, so the build was stopped.' });
            return;
          }
          result = count >= REPEAT_WARN
            ? 'You already made this exact ' + name + ' call ' + (count - 1) + ' times. Do something different, or finish with a summary.'
            : await executeTool(session, name, args);
        }
        if (result === null || session.cancelled || TERMINAL.has(session.status)) return;
        const text = cap(result, MAX_TOOL_RESULT_CHARS);
        if (textProtocol) messages.push({ role: 'user', content: 'Result of ' + (name || call.function.name) + ':\n' + text, fromTool: true });
        else messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
      compactMessages(messages);
    }
    finish(session, 'failed', { error: 'The build stopped after ' + opts.maxRounds + ' model turns without finishing.' });
  }

  return { create, tryCreate, get, list, view, subscribe, input, cancel, sessions };
}

// --- HTTP ---

function sseFrame(event) {
  return 'id: ' + event.seq + '\nevent: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
}

// The routes, as one handler the server hooks in before its static files.
// `helpers` supplies what only the server knows: who is signed in, whether the
// login gate is on, whether commands may run, how to read a JSON body and send
// JSON, and what a model call needs from the original request.
function handleBuildRoute(req, res, urlPath, store, helpers) {
  const parts = urlPath.replace(/\/+$/, '').split('/').slice(4); // after /api/build/sessions
  const [id, action, extra] = parts;
  const owner = helpers.currentUser(req);
  const method = req.method;
  const send = helpers.sendJson;
  if (extra) return send(res, 404, { error: 'Not found' });

  if (method === 'POST') {
    // A JSON body is required even where none is read: a cross-site HTML form
    // cannot send application/json, so this keeps the cookie from being enough.
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return send(res, 415, { error: 'Send JSON (Content-Type: application/json).' });
  }

  if (!id) {
    const gateReason = helpers.gateOn() ? '' : 'Builds need a login: set AUTH_USER_1 and AUTH_PASS_1 on the server first.';
    if (method === 'GET') {
      const runReason = helpers.runRefusal();
      return send(res, 200, {
        enabled: !gateReason,
        reason: gateReason,
        runEnabled: !runReason,
        runReason,
        tools: BUILD_TOOLS.map((t) => ({ name: t.name, description: t.description, approval: APPROVAL_TOOLS.has(t.name) })),
        sessions: gateReason ? [] : store.list(owner),
      });
    }
    if (method === 'POST') {
      if (gateReason) return send(res, 403, { error: gateReason });
      return helpers.readJsonBody(req, 64 * 1024, (err, body) => {
        if (err) return send(res, 400, { error: 'Invalid request' });
        const clean = body && typeof body === 'object' ? body : {};
        const result = store.tryCreate({
          chatId: clean.chatId,
          plan: clean.plan,
          repo: clean.repo,
          branch: clean.branch,
          provider: clean.provider,
          model: clean.model,
          owner,
          ctx: helpers.contextFor(req, clean.repo),
        });
        if (result.error) return send(res, result.status, { error: result.error });
        return send(res, 201, store.view(result));
      });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  const session = store.get(id, owner);
  if (!session) return send(res, 404, { error: 'No such build' });

  if (!action && method === 'GET') return send(res, 200, store.view(session));

  if (action === 'events' && method === 'GET') {
    const header = req.headers['last-event-id'];
    const query = new URL(req.url, 'http://x').searchParams.get('after');
    const after = Number(header != null ? header : query) || 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let closed = false;
    let unsubscribe = () => {};
    let heartbeat = null;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (heartbeat) clearTimeout(heartbeat);
      if (!res.writableEnded) res.end();
    };
    let ended = false;
    unsubscribe = store.subscribe(session, after, (event) => {
      if (closed) return;
      res.write(sseFrame(event));
      if (event.type === 'done' || event.type === 'failed') {
        ended = true;
        setTimeout(close, 0);
      }
    });
    if (ended || ['done', 'failed', 'cancelled', 'expired'].includes(session.status)) {
      setTimeout(close, 0);
      return undefined;
    }
    // A comment line now and then, so a proxy does not close a quiet stream
    // while the build waits on an approval.
    const beat = () => {
      if (closed) return;
      res.write(': ping\n\n');
      heartbeat = setTimeout(beat, HEARTBEAT_MS);
      if (heartbeat.unref) heartbeat.unref();
    };
    heartbeat = setTimeout(beat, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();
    req.socket.on('close', close);
    return undefined;
  }

  if (action === 'input' && method === 'POST') {
    return helpers.readJsonBody(req, 16 * 1024, (err, body) => {
      if (err) return send(res, 400, { error: 'Invalid request' });
      const result = store.input(session, body);
      if (result.error) return send(res, result.status, { error: result.error });
      return send(res, 200, { ok: true, decision: result.decision, session: store.view(session) });
    });
  }

  if (action === 'cancel' && method === 'POST') {
    req.resume();
    return send(res, 200, store.cancel(session));
  }

  return send(res, 404, { error: 'Not found' });
}

module.exports = {
  BUILD_TOOLS,
  BUILD_TOOL_NAMES,
  APPROVAL_TOOLS,
  planSteps,
  parseTextToolCalls,
  matchToolName,
  lineDiff,
  resolveInside,
  globToRegExp,
  refusedGit,
  projectNotes,
  protectedPath,
  searchFolder,
  hashCall,
  createBuildSessions,
  handleBuildRoute,
};
