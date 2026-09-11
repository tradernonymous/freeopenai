// Shared pure logic used by index.html (browser) and the test suite (Node).
// No DOM/Node APIs here so it can run in either environment unmodified.

// Curated subset of the models Puter.js supports for puter.ai.chat(); see
// https://developer.puter.com/tutorials/free-unlimited-openai-api/#list-of-supported-text-generation-models
// for the full list (several dozen ids across the GPT-5.x/4.1/o-series/Codex lines).
// Build modes, opencode-style. Chat is the default assistant; Plan reasons
// about an implementation before anything changes; Build executes with the
// full skill library riding along. The mode shapes the system prompt and
// which auto-skills are allowed to trigger — never the tool surface, which
// stays capability-based (GitHub connected, model supports tools).
const MODES = [
  { id: 'chat', label: 'Chat', desc: 'Ask anything — default assistant' },
  { id: 'plan', label: 'Plan', desc: 'Design first: read-only thinking, no changes' },
  { id: 'build', label: 'Build', desc: 'Execute with the skill library active' },
];

const DEFAULT_MODE = 'chat';

function isValidMode(id) {
  return MODES.some((m) => m.id === id);
}

// Per-mode instructions appended to the base system prompt. Plan is the
// opencode /plan contract: investigate, propose, wait — never edit. Build
// is its /build: carry out an agreed approach with the discipline skills
// (TDD, verification, lean scope) watching over every step.
const MODE_PROMPTS = {
  chat: '',
  plan: [
    'MODE: PLAN. The user wants an implementation plan, not changes.',
    'Investigate first (read files via the GitHub tools, search the web for unknowns), then answer with:',
    'a short goal statement, what you found in the code (file paths), a numbered step-by-step plan, risks, and open decisions.',
    'Do not write or commit code in this mode. End by asking the user to switch to Build mode to execute.',
  ].join('\n'),
  build: [
    'MODE: BUILD. You are executing agreed work. Be disciplined about it:',
    '- Prefer the smallest change that fully solves the request; reuse what the repo already has.',
    '- For behavior changes, write or adjust a test first when the repo has tests to attach to.',
    '- Verify before claiming done: run what the repo offers (tests, build, lint) and report actual results.',
    '- Summarize what changed, what you verified, and what you deliberately did not do.',
    '- Commits still require the user\'s explicit approval through the app\'s commit confirmation.',
  ].join('\n'),
};

function modePrompt(mode) {
  return MODE_PROMPTS[mode] || MODE_PROMPTS.chat;
}

// --- Agent skills (SKILL.md catalogues) ---
//
// Skills are markdown files with a YAML-ish frontmatter (name, description).
// The description's "Use when ..." clause is what the auto-router matches
// against the user's request, the same trigger language Claude Code uses.

// Parses the `--- ... ---` frontmatter block of a SKILL.md into an object.
// Tolerates CRLF, blank values and missing blocks; never throws.
function parseSkillFrontmatter(markdown) {
  const text = String(markdown || '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { name: '', description: '' };
  const out = { name: '', description: '' };
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(lines[i].trim());
    if (!m) continue;
    let value = m[2].trim();
    // YAML block scalars ("description: >" / "|") put the real text on the
    // following indented lines — fold them into one string, or the router
    // would score a bare ">" and never match the skill.
    if (/^[>|][+-]?\d*$/.test(value)) {
      const chunk = [];
      let j = i + 1;
      while (j < lines.length) {
        const line = lines[j];
        if (!line.trim()) { chunk.push(' '); j++; continue; }
        if (/^\s/.test(line)) { chunk.push(line.trim()); j++; continue; }
        break;
      }
      value = chunk.join(' ').replace(/\s+/g, ' ').trim();
      i = j - 1;
    }
    out[m[1]] = value.replace(/^"|"$/g, '');
  }
  return out;
}

// Curated sources. anthropics/skills is the full official library,
// obra/superpowers is the development-methodology set, and caveman is
// included lite: five of its skills that earn their tokens on top of the
// other two (its compress/engine machinery is a separate product).
const SKILL_SOURCES = [
  { repo: 'anthropics/skills', branch: 'main', dir: 'skills', pick: 'all' },
  { repo: 'obra/superpowers', branch: 'main', dir: 'skills', pick: 'all' },
  {
    repo: 'JuliusBrussee/caveman',
    branch: 'main',
    dir: 'skills',
    pick: ['caveman', 'lean-build', 'surgical-patch', 'verify-and-stop', 'caveman-commit'],
  },
];

// Skill names whose whole job is process discipline during Build mode. The
// router seeds these into every build turn so the methodology applies even
// when the request text doesn't name it.
const BUILD_CORE_SKILLS = ['test-driven-development', 'verification-before-completion', 'lean-build'];

// Mode → which auto-skill sets may fire.
//   chat: none (skills are noise for plain questions)
//   plan: planning/process skills (writing-plans, brainstorming, lean-build…)
//   build: everything — methodology plus the capability library
function skillsAllowedForMode(mode) {
  if (mode === 'plan') return 'process';
  if (mode === 'build') return 'all';
  return 'none';
}

// Token overlap between the request and a skill's name + description.
// Deliberately shallow: the descriptions are written as triggers ("Use when
// implementing any feature"), so word overlap is the signal, not semantics.
// The name counts too — "write tests" triggers test-driven-development
// through its name, whose description alone never says "test". Filler words
// are stopped and a trailing 's' is stemmed, so "and"-heavy descriptions
// can't outscore real matches and "tests" meets "test".
const SKILL_STOP = new Set(['free', 'new', 'latest', 'preview', 'instruct', 'the',
  'use', 'using', 'used', 'when', 'writing', 'write', 'writes', 'create', 'creates',
  'creating', 'created', 'add', 'adds', 'adding', 'build', 'builds', 'building', 'make',
  'making', 'help', 'helps', 'helping', 'guide', 'guides', 'guidance', 'set', 'sets',
  'edit', 'edits', 'editing', 'update', 'updating', 'change', 'changing', 'run', 'runs',
  'running', 'get', 'gets', 'getting', 'let', 'lets', 'one', 'two', 'also', 'based',
  'skill', 'skills', 'claude', 'agent', 'agents', 'model', 'models', 'resource', 'resources',
  'use', 'using', 'used', 'when', 'writing',
  'creating', 'helps', 'help', 'guidance', 'skill', 'claude', 'user', 'code', 'works', 'work',
  'working', 'worked', 'and', 'with', 'for', 'from', 'this', 'that', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'all', 'can', 'will', 'into', 'over', 'any', 'before',
  'after', 'between', 'through', 'where', 'while', 'more', 'most', 'other', 'some', 'such',
  'only', 'same', 'than', 'too', 'very', 'just', 'also', 'then', 'they', 'them', 'its',
  'need', 'needs', 'want', 'wants', 'per', 'via', 'your', 'you', 'our', 'their', 'these',
  'those', 'been', 'being', 'does', 'doing', 'did', 'done', 'like', 'well', 'way', 'new']);

function stemSkillToken(t) {
  // Bounded light stemmer: strip common suffixes and a doubled final
  // consonant (debugging → debug, planning → plan, tests → test). Two passes
  // max, never below 3 chars — enough for trigger matching, not a linguistics
  // project.
  for (let i = 0; i < 2 && t.length > 3; i++) {
    const next = t.replace(/(ing|ed|es|s)$/, '');
    if (next === t) break;
    t = /(.)\1$/.test(next) ? next.slice(0, -1) : next;
  }
  return t;
}

function skillTokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9.]+/)
    .filter((t) => t.length > 2 && !SKILL_STOP.has(t))
    .map(stemSkillToken);
}

function skillTriggerScore(requestText, skill) {
  const want = new Set(skillTokens(requestText));
  if (!want.size) return 0;
  // Name hits count triple: a skill's own name is its strongest signal
  // ("write tests" → test-driven-development; "make a poster" → canvas-design).
  // Description-only overlap is the weak signal and cannot outrank it.
  const nameHits = new Set([...skillTokens(skill && skill.name)].filter((t) => want.has(t))).size;
  const desc = new Set(skillTokens(skill && skill.description));
  let descHits = 0;
  for (const t of want) if (desc.has(t)) descHits += 1;
  return nameHits * 3 + descHits;
}

// The auto-pick router. Given the user's request, the current mode, and the
// loaded catalogue ({ source, name, description } rows), returns the skills
// to inject, best match first:
//   - core build skills seed every build turn (when present in the catalogue)
//   - process skills fire in plan mode on trigger-word overlap
//   - everything fires in build mode on trigger-word overlap
//   - always capped, so a vague request can't stuff the prompt with ten skills
function pickSkills(requestText, mode, skills, limit = 3) {
  if (skillsAllowedForMode(mode) === 'none' || !Array.isArray(skills) || !skills.length) return [];
  const processOnly = skillsAllowedForMode(mode) === 'process';
  // Superpowers' process skills — the ones about how to work rather than
  // what to make. In plan mode only these may trigger.
  const PROCESS_HINT = /debug|plan|brainstorm|review|worktree|subagent|TDD|test-driven|verif/i;
  const pool = skills.filter((s) => s && s.name && s.description)
    .filter((s) => !processOnly || PROCESS_HINT.test(s.description));
  const scored = pool
    .map((s) => ({ s, score: skillTriggerScore(requestText, s) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  const picked = [];
  const seen = new Set();
  const push = (name) => {
    if (seen.has(name) || picked.length >= limit) return;
    const row = pool.find((s) => s.name === name);
    if (row) { seen.add(name); picked.push(row); }
  };
  // Strongest signal first: actual matches outrank the seeded methodology,
  // which only fills the slots left over. A UI request therefore gets
  // frontend-design alongside the core, not instead of it.
  for (const { s } of scored) push(s.name);
  if (mode === 'build') for (const name of BUILD_CORE_SKILLS) push(name);
  return picked;
}

// Renders picked skills as extra system context. Bounded excerpts: the
// overview carries the method; the model can ask for the full text via
// use_skill if it needs the detailed sections.
function renderSkillsPrompt(picked, excerptLength = 1200) {
  if (!Array.isArray(picked) || !picked.length) return '';
  const parts = picked.map((s) =>
    `### Skill: ${s.name} (from ${s.source})\n${(s.description || '').trim()}\n\n${String(s.body || '').slice(0, excerptLength).trim()}`
  );
  return [
    'ACTIVE SKILLS — follow these methods for this request:',
    '(If a skill references scripts or files that are not available here, apply its approach manually.)',
    '',
    parts.join('\n\n---\n\n'),
  ].join('\n');
}

// The use_skill tool spec the model can call to pull a skill's full text
// mid-turn (OpenAI function schema, same shape as the GitHub/web tools).
const USE_SKILL_TOOL = {
  type: 'function',
  function: {
    name: 'use_skill',
    description: 'Load the complete instructions of an installed skill by name. Use it when the active skill excerpts are not detailed enough to follow the method precisely.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name, e.g. "test-driven-development".' },
      },
      required: ['name'],
    },
  },
};

// The catalogue lives server-side; the client asks once per session (and on
// entering Build mode) for the id list, then fetches full text on demand.
function isUseSkillTool(name) {
  return name === 'use_skill';
}

const MODELS = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', desc: 'Newest, most capable' },
  { id: 'gpt-6-astra-pro', name: 'GPT-6 Astra Pro', desc: 'Astra, pro reasoning' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', desc: 'Flagship' },
  { id: 'gpt-5.6-sol-pro', name: 'GPT-5.6 Sol Pro', desc: 'Sol, pro reasoning' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', desc: 'Mid-tier' },
  { id: 'gpt-5.6-terra-pro', name: 'GPT-5.6 Terra Pro', desc: 'Terra, pro reasoning' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', desc: 'Small, cheap' },
  { id: 'gpt-5.6-luna-pro', name: 'GPT-5.6 Luna Pro', desc: 'Luna, pro reasoning' },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', desc: 'Fast, cheap' },
  { id: 'gpt-4o', name: 'GPT-4o', desc: 'Balanced' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', desc: 'Fast' },
  // Codex models require the "openai/" prefix on Puter.js — see
  // https://developer.puter.com/tutorials/free-unlimited-codex-api/
  { id: 'openai/gpt-5.3-codex', name: 'GPT-5.3 Codex', desc: 'Coding, latest' },
  { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex', desc: 'Coding' },
  { id: 'openai/gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', desc: 'Coding, max context' },
  // Claude models take their id directly, no prefix — see
  // https://developer.puter.com/tutorials/free-unlimited-claude-35-sonnet-api/
  { id: 'claude-opus-5', name: 'Claude Opus 5', desc: 'Anthropic, most capable' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', desc: 'Anthropic, balanced' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', desc: 'Anthropic, fast' },
];

const DEFAULT_MODEL = 'gpt-5.4-nano';

function isValidModel(id) {
  return MODELS.some((m) => m.id === id);
}

// Curated models confirmed (via developer.puter.com's per-model spec pages) to
// accept image input. Not every model in MODELS supports vision, so image
// attachments fall back to DEFAULT_VISION_MODEL when the user's selected
// model isn't one of these.
const VISION_MODEL_IDS = ['gpt-5.6-luna', 'gpt-5.4-nano', 'gpt-4o'];
const DEFAULT_VISION_MODEL = 'gpt-5.4-nano';

function isVisionCapable(id) {
  return VISION_MODEL_IDS.includes(id);
}

// Extensions handled by each attach menu option. "document" files are parsed
// client-side (PDF via pdf.js, DOCX via mammoth.js) into plain text; "file"
// covers the original plain-text attach behavior.
const DOCUMENT_EXTENSIONS = ['.pdf', '.docx'];

function isDocumentFile(filename) {
  const lower = String(filename).toLowerCase();
  return DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ATTACHABLE_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.js', '.ts', '.log', '.yml', '.yaml'];

function isAttachableFile(filename) {
  const lower = String(filename).toLowerCase();
  return ATTACHABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Catches plain-language image requests ("generate an image of a fox",
// "draw me a logo") typed into normal chat, without requiring the user to
// notice the dedicated image-mode toggle first. Deliberately conservative —
// requires an image-ish noun right after the verb (optionally through
// "me"/"us"/"a"/"an") — so it doesn't fire on prose that merely mentions
// "image" elsewhere, e.g. "make a plan for my image website".
const IMAGE_INTENT_PATTERN =
  /^(?:please\s+)?(generate|create|draw|make|design|paint|render)\s+(?:me\s+|us\s+)?(?:an?\s+)?(image|picture|photo|photograph|illustration|graphic|logo|icon|artwork|drawing|sketch|wallpaper|poster|banner|avatar)\b/i;

function detectsImageIntent(text) {
  return IMAGE_INTENT_PATTERN.test(String(text).trim());
}

// Applies **bold**, *italic*, `inline code`, fenced code blocks, and -/1. lists
// to already-HTML-escaped text. Only ever emits a small fixed set of tags
// (strong/em/code/pre/ul/ol/li) around text that was escaped up front, so
// markdown syntax can never smuggle in a live tag.
function inlineFormat(s) {
  return s
    .replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^\n_]+?)__/g, '<strong>$1</strong>')
    .replace(/\*([^\n*]+?)\*/g, '<em>$1</em>')
    .replace(/(?<![\w])_([^\n_]+?)_(?![\w])/g, '<em>$1</em>');
}

const CODE_BLOCK_TOKEN = 'CODEBLOCKTOKEN';
const CODE_SPAN_TOKEN = 'CODESPANTOKEN';

function renderMarkdownLite(rawText) {
  const escaped = escapeHtml(rawText);

  const codeBlocks = [];
  let text = escaped.replace(/```[ \t]*(\w*)\r?\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `@@${CODE_BLOCK_TOKEN}${idx}@@`;
  });

  const codeSpans = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${code}</code>`);
    return `@@${CODE_SPAN_TOKEN}${idx}@@`;
  });

  const htmlParts = [];
  let listBuffer = [];
  let listType = null;
  const textLines = [];

  function flushList() {
    if (!listBuffer.length) return;
    const items = listBuffer.map((item) => `<li>${inlineFormat(item)}</li>`).join('');
    htmlParts.push(`<${listType}>${items}</${listType}>`);
    listBuffer = [];
    listType = null;
  }

  function flushText() {
    if (!textLines.length) return;
    htmlParts.push(inlineFormat(textLines.join('\n')).replace(/\n/g, '<br>'));
    textLines.length = 0;
  }

  for (const line of text.split('\n')) {
    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    const olMatch = line.match(/^\d+\.\s+(.*)$/);
    if (ulMatch) {
      flushText();
      if (listType !== 'ul') flushList();
      listType = 'ul';
      listBuffer.push(ulMatch[1]);
    } else if (olMatch) {
      flushText();
      if (listType !== 'ol') flushList();
      listType = 'ol';
      listBuffer.push(olMatch[1]);
    } else {
      flushList();
      textLines.push(line);
    }
  }
  flushList();
  flushText();

  const blockTokenPattern = new RegExp(`@@${CODE_BLOCK_TOKEN}(\\d+)@@`, 'g');
  const spanTokenPattern = new RegExp(`@@${CODE_SPAN_TOKEN}(\\d+)@@`, 'g');

  return htmlParts
    .join('')
    .replace(spanTokenPattern, (_m, i) => codeSpans[Number(i)])
    .replace(blockTokenPattern, (_m, i) => codeBlocks[Number(i)]);
}

// Tools the model can call when a GitHub account is connected. OpenAI-style
// function specs, which is what puter.ai.chat() expects for its `tools`
// option. Each one maps to an /api/github/* route on our own server, so the
// access token stays in its httpOnly cookie and never reaches the model.
const GITHUB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'github_list_repos',
      description: "List the public repositories of every connected GitHub account. Each result carries the account that can reach it. Call this first when you don't know the exact repo name, or which account owns it.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_files',
      description: 'List the files and folders at a path in a repository. Use it to find a file before reading it. Leave path empty for the repository root.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name", e.g. "octocat/hello-world".' },
          path: { type: 'string', description: 'Folder path inside the repo. Empty string for the root.' },
          account: { type: 'string', description: 'Which connected GitHub account to act as. Only needed when the repo is not owned by one of them, e.g. an organisation repo; github_list_repos reports the right value.' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_read_file',
      description: 'Read the full text of one file in a repository. Always read a file before rewriting it, so you keep the parts you are not changing.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name".' },
          path: { type: 'string', description: 'Path to the file inside the repo, e.g. "src/index.js".' },
          account: { type: 'string', description: 'Which connected GitHub account to act as. Only needed when the repo is not owned by one of them, e.g. an organisation repo; github_list_repos reports the right value.' },
        },
        required: ['repo', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_commit_file',
      description: 'Write a file to a repository and commit it. The content replaces the whole file, so send the complete new text, not a diff. The user is asked to approve every commit before it happens.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name".' },
          path: { type: 'string', description: 'Path to the file inside the repo.' },
          content: { type: 'string', description: 'The complete new contents of the file.' },
          message: { type: 'string', description: 'Commit message.' },
          account: { type: 'string', description: 'Which connected GitHub account to act as. Only needed when the repo is not owned by one of them, e.g. an organisation repo; github_list_repos reports the right value.' },
        },
        required: ['repo', 'path', 'content', 'message'],
      },
    },
  },
];

// Stop the tool loop from running away if a model keeps calling tools forever.
// Real work crosses more steps than it looks: finding a repo, listing a folder,
// reading two files and committing one is already five. Six was low enough that
// ordinary requests hit the ceiling, and every round is a billed call, so this
// is a ceiling rather than a budget -- the number to keep down is how many
// rounds a request needs, not how many it may have.
const MAX_TOOL_ROUNDS = 12;

// Asked of the model when the ceiling is reached, so an expensive run ends with
// an answer about what it found rather than being thrown away.
// Sent when a model finishes its tool work and then returns nothing. Some
// models stop after the last tool result without writing the answer; asking
// plainly recovers it, which beats reporting an empty reply to the user.
const EMPTY_REPLY_NUDGE =
  'You did not write an answer. Using what you found above, answer the original ' +
  'question now in plain text. Do not call any more tools.';

const TOOL_ROUNDS_EXHAUSTED_PROMPT =
  'Stop using tools now and answer directly. Summarise what you found, what you ' +
  'changed if anything, and what is still left to do. Be specific about file ' +
  'paths so the next request can pick up from here.';

const GITHUB_TOOL_NAMES = GITHUB_TOOLS.map((t) => t.function.name);

function isGithubTool(name) {
  return GITHUB_TOOL_NAMES.includes(name);
}

// Web research, available in every chat with no account needed. The model
// otherwise answers from training data or, with GitHub connected, only what
// the repos contain -- so a question about the outside world gets searched,
// not guessed.
const WEB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current or external facts: docs, releases, prices, news, anything past training. Returns titles, URLs and snippets. Use it instead of guessing, then cite the sources as [title](url) in the answer.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query, specific rather than conversational.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Read one page as plain text: a search result, docs URL, or any link the user pasted. Returns the title and up to ~8000 characters. Prefer it over quoting a URL blind.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full http(s) URL to read.' },
        },
        required: ['url'],
      },
    },
  },
];

const WEB_TOOL_NAMES = WEB_TOOLS.map((t) => t.function.name);

function isWebTool(name) {
  return WEB_TOOL_NAMES.includes(name);
}

// Response bodies are JSON until a proxy, edge, or gateway hands back an
// HTML/text error page instead (mid-restart deploys do this routinely).
// Parsing that raw throws SyntaxError, which reads as gibberish to the user,
// so normalize it here into a retryable message at every call site. A parse
// failure is marked so callers can tell it apart from a real error body.
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return {
      error: 'The server answered with something unreadable (often a proxy page while redeploying) — wait a moment and retry.',
      parseFailed: true,
    };
  }
}

// Allowlist matching for provider pickers. An entry is either a plain string
// (exact model id, e.g. "nvidia/nemotron-3.5-lightning") or { label } for
// human names ("Nemotron 3.5 Lightning"), matched token-wise against both the
// model id and its display name. Provider catalogues rename models often
// enough that exact strings alone go stale; token matching survives the
// renames without letting lookalikes in.
const LIST_NOISE = new Set(['free', 'new', 'latest', 'preview', 'instruct', 'the']);

function modelTokens(s) {
  return String(s || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9.]+/i)
    .map((t) => t.toLowerCase())
    .filter((t) => t && !LIST_NOISE.has(t));
}

function matchListEntry(model, entry) {
  if (!model || !model.id) return false;
  if (typeof entry === 'string') return model.id === entry;
  if (!entry || typeof entry.label !== 'string') return false;
  const wanted = modelTokens(entry.label);
  if (!wanted.length) return false;
  const have = new Set([...modelTokens(model.id), ...modelTokens(model.name)]);
  return wanted.every((t) => have.has(t));
}

// Decides whether a failed tools call deserves one plain retry. Parse
// failures and shape rejections (400/422, tool-worded messages) mean the
// endpoint can't do tools; anything else (auth, billing, missing model,
// rate limits, aborts) must keep its original handling.
function isToolsRejection(err) {
  if (!err || err.name === 'AbortError') return false;
  if (err.parseFailed) return true;
  if (typeof err.statusCode === 'number') return err.statusCode === 400 || err.statusCode === 422;
  return /tool|function|unknown field/i.test(err.message || '');
}

// Tool arguments arrive as a JSON string from the model, and a model can emit
// malformed JSON. Never throw on it — an empty object lets the tool itself
// report the missing argument back to the model, which can then retry.
function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// One plain line describing what the model is about to do, used both in the
// transcript and in the commit confirmation dialog.
function describeToolCall(name, args = {}) {
  const repo = args.repo || 'a repo';
  const as = args.account ? ` as ${args.account}` : '';
  switch (name) {
    case 'github_list_repos':
      return 'Listing your GitHub repositories';
    case 'github_list_files':
      return `Listing ${args.path ? `"${args.path}" in ` : 'the root of '}${repo}`;
    case 'github_read_file':
      return `Reading "${args.path || '?'}" from ${repo}${as}`;
    case 'github_commit_file': {
      // A commit dialog must always name the identity it will land under, so
      // fall back to the repo owner -- which is the account the server picks
      // when the model didn't name one.
      const owner = args.account || String(args.repo || '').split('/')[0];
      return `Committing "${args.path || '?'}" to ${repo}${owner ? ` as ${owner}` : ''}`;
    }
    case 'web_search':
      return `Searching the web for "${args.query || '?'}"`;
    case 'web_fetch':
      return `Reading ${args.url || 'a page'}`;
    default:
      return `Running ${name}`;
  }
}

// Providers disagree about the shape of an assistant message. OpenAI puts the
// answer in message.content as a plain string; Claude returns an array of
// content blocks and hides the text at content[0].text. Reading .content
// directly renders "[object Object]" for every Claude reply, so everything
// goes through here instead.
function extractMessageText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (!block) return '';
        // Thinking blocks are the reasoning summary, not the answer.
        if (block.type === 'thinking' || block.type === 'reasoning') return '';
        return block.text || '';
      })
      .join('');
  }
  return message.text || '';
}

// Claude carries extended thinking as blocks inside the same content array,
// while OpenAI-style replies use a separate message.reasoning field.
function extractMessageReasoning(message) {
  if (!message || typeof message === 'string') return '';
  if (typeof message.reasoning === 'string' && message.reasoning) return message.reasoning;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b && (b.type === 'thinking' || b.type === 'reasoning'))
      .map((b) => b.thinking || b.text || '')
      .join('');
  }
  return '';
}

// Same split for tool calls: OpenAI-style replies expose message.tool_calls,
// Claude emits tool_use blocks in the content array. Normalize to the
// OpenAI shape, which is what the tool loop is written against.
function extractToolCalls(message) {
  if (!message || typeof message === 'string') return [];
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return message.tool_calls;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b && b.type === 'tool_use')
      .map((b) => ({ id: b.id, function: { name: b.name, arguments: b.input || {} } }));
  }
  return [];
}

// How hard a reasoning model should think before answering. Puter passes this
// through as reasoning_effort; see
// https://docs.puter.com/AI/chat/ for the accepted values.
const EFFORT_LEVELS = [
  { id: 'none', name: 'None', desc: 'No thinking at all' },
  { id: 'minimal', name: 'Minimal', desc: 'Barely any' },
  { id: 'low', name: 'Low', desc: 'Quick' },
  { id: 'medium', name: 'Medium', desc: 'Balanced' },
  { id: 'high', name: 'High', desc: 'Thorough' },
  { id: 'xhigh', name: 'Extra high', desc: 'Slowest, most thorough' },
];

// Empty means "send nothing and let the model do whatever it does by
// default", which is how the app behaved before this option existed.
const DEFAULT_EFFORT = '';

// Only the reasoning tiers take an effort setting. Sending it to a model that
// ignores it would put a control on screen that silently does nothing, so the
// picker stays hidden for everything not listed here.
const EFFORT_CAPABLE_MODEL_IDS = [
  'gpt-6-astra-pro',
  'gpt-5.6-sol-pro',
  'gpt-5.6-terra-pro',
  'gpt-5.6-luna-pro',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
];

function supportsEffort(modelId) {
  return EFFORT_CAPABLE_MODEL_IDS.includes(modelId);
}

function isValidEffort(value) {
  return EFFORT_LEVELS.some((level) => level.id === value);
}

// Conversations live in localStorage as a list, newest first. Capped so a
// long-lived browser can't grow the store without bound -- localStorage is
// only a few MB and a single overflowing write loses everything.
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 200;

// The first thing the user actually said, which is what makes a list of
// chats scannable. Falls back rather than showing an empty row.
function deriveChatTitle(messages, max = 40) {
  const firstUser = (messages || []).find((m) => m && m.type === 'user' && String(m.content || '').trim());
  const text = firstUser ? String(firstUser.content).trim().replace(/\s+/g, ' ') : '';
  if (!text) return 'New chat';
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function newConversation(id, now) {
  return { id, title: 'New chat', messages: [], updatedAt: now };
}

// Newest first, with a stable tiebreak so equal timestamps don't reshuffle
// the list on every render.
function sortConversations(list) {
  return [...(list || [])].sort((a, b) => (b.updatedAt - a.updatedAt) || String(a.id).localeCompare(String(b.id)));
}

// Replaces the matching conversation, or adds it, then trims to the cap.
// Always returns a new array rather than mutating the caller's.
function upsertConversation(list, convo) {
  const rest = (list || []).filter((c) => c && c.id !== convo.id);
  return sortConversations([...rest, convo]).slice(0, MAX_CONVERSATIONS);
}

// Chats were a single "puterChatMessages" array before this existed. Carry
// them into the list as one conversation instead of dropping them.
function migrateLegacyMessages(legacyMessages, id, now) {
  if (!Array.isArray(legacyMessages) || !legacyMessages.length) return null;
  const messages = legacyMessages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  return { id, title: deriveChatTitle(messages), messages, updatedAt: now };
}

// Puter translates reasoning_effort into each provider's own shape, and for
// some Claude models it sends Anthropic's older "thinking.type: enabled",
// which those models reject outright:
//
//   400 "thinking.type.enabled" is not supported for this model. Use
//   "thinking.type.adaptive" and "output_config.effort" ...
//
// We can't change what Puter sends, so the app detects this specific refusal
// and retries the request without an effort setting.
function isEffortUnsupportedError(error) {
  const message = String((error && (error.message || error.error || error)) || '');
  if (!message) return false;
  const mentionsThinking = /thinking\.type|output_config\.effort|reasoning_effort/i.test(message);
  const mentionsEffort = /effort|thinking/i.test(message);
  const isRejection = /not supported|unsupported|invalid_request_error|\b400\b/i.test(message);
  return isRejection && (mentionsThinking || mentionsEffort);
}

// A reply from puter.ai.chat carries more than a message: model, id, usage,
// stop_reason and friends ride along. Echoing that object straight back into
// the conversation for a tool round-trip makes the provider reject the whole
// request --
//
//   400 messages.1.model: Extra inputs are not permitted
//
// -- so only the fields a conversation turn is allowed to have go back.
function toConversationMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const turn = { role: message.role || 'assistant', content: message.content ?? '' };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    turn.tool_calls = message.tool_calls;
  }
  return turn;
}

// A 429 from the provider means the request was too fast, not that something
// is broken. Both the server and the client use this to retry with a delay
// instead of showing an error the user has to act on.
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 2000;

function isRateLimitError(error) {
  const message = String((error && (error.message || error.error || error)) || '');
  return /\b429\b|too many requests|rate.?limit/i.test(message);
}

// Puter runs a "User-Pays" model: free for whoever builds the app, billed to
// whoever is signed in. On the free plan that's a fixed credit allowance, and
// running out surfaces as a bare "No usage left for request", which reads like
// a bug rather than a spent budget.
function isOutOfCreditsError(error) {
  const message = String((error && (error.message || error.error || error)) || '');
  return /no usage left|insufficient (credit|fund)|usage limit|quota exceeded|out of credits|\b402\b/i.test(message);
}

// Models whose replies cost noticeably more per message. Used to warn before
// an expensive run, not to stop anyone using them.
const HEAVY_MODEL_IDS = ['claude-opus-5', 'gpt-6-astra', 'gpt-6-astra-pro', 'gpt-5.6-sol', 'gpt-5.6-sol-pro'];
const HEAVY_EFFORT_LEVELS = ['high', 'xhigh'];

function isHeavyModel(modelId) {
  return HEAVY_MODEL_IDS.includes(modelId);
}

// The combination that empties an allowance fastest: a top-tier model, maximum
// thinking, and a tool loop where every round is another billed call.
function estimateCostWarning(modelId, effort, toolsEnabled) {
  const reasons = [];
  if (isHeavyModel(modelId)) reasons.push('a top-tier model');
  if (HEAVY_EFFORT_LEVELS.includes(effort)) reasons.push(`${effort} reasoning effort`);
  if (toolsEnabled) reasons.push('GitHub tools, where each step is another request');
  if (reasons.length < 2) return '';
  return 'Heads up: ' + reasons.join(' + ') + ' uses your Puter credits quickly.';
}

// Renders a conversation as markdown for the clipboard. Tool-activity lines
// and error notices are the app talking to itself, so they stay out -- what
// gets pasted into an issue or a doc should be the exchange, nothing else.
function conversationToMarkdown(messages, title) {
  const lines = title ? ['# ' + title, ''] : [];
  for (const message of messages || []) {
    if (!message || message.type === 'system') continue;
    const text = String(message.content == null ? '' : message.content).trim();
    if (!text) continue;
    lines.push(message.type === 'user' ? '## You' : '## Assistant', '', text, '');
  }
  return lines.join('\n').trim();
}

// How much of the conversation travels with each message. Sending history
// costs tokens, but sending none costs far more: without it the model
// re-discovers the same facts every turn, re-listing repositories and asking
// which one you meant, which is several billed calls to get back to where it
// already was.
const MAX_HISTORY_MESSAGES = 12;

// Rebuilds the exchange as chat turns. System lines are the app narrating
// itself -- tool activity, error notices -- and are left out; feeding them back
// invites the model to comment on them. Trailing user messages are dropped
// because the caller appends the live one itself.
function buildChatHistory(messages, limit = MAX_HISTORY_MESSAGES) {
  const turns = [];
  for (const message of messages || []) {
    if (!message || (message.type !== 'user' && message.type !== 'bot')) continue;
    const text = String(message.content == null ? '' : message.content).trim();
    if (!text) continue;
    turns.push({ role: message.type === 'user' ? 'user' : 'assistant', content: text });
  }
  const recent = turns.slice(-limit);
  // A history that opens on an assistant turn reads as a reply to nothing.
  while (recent.length && recent[0].role === 'assistant') recent.shift();
  return recent;
}

// Answer-first instructions, in the spirit of the i-have-adhd skill
// (https://github.com/ayghri/i-have-adhd). The tool rules exist because each
// clarifying question is a paid round trip: asking which repository when the
// user already named one costs the same as reading the file would have.
const SYSTEM_PROMPT = [
  'You are a concise assistant inside a chat app. Lead with the answer or the action, never with a preamble.',
  'Do not open with "Great question", do not close with "Hope this helps" or "Let me know".',
  '',
  'You have the conversation so far. Use it. Never ask for something the user already told you.',
  '',
  'When GitHub tools are available:',
  '- If the user gives a repository URL or an owner/name, use it. Do not ask which repository.',
  '- Reading and listing are safe and cheap. Just do them; never ask permission to read.',
  '- Never answer "say proceed and I will do it". If you can act, act now.',
  '- Committing is the only step that needs approval, and the app already asks the user itself.',
  '- Read a file before rewriting it, and send the complete new contents.',
  '',
  'When web tools are available:',
  '- If the question needs facts outside training or the repos -- current events, releases, prices, docs -- search first, never guess.',
  '- Read the most promising results before answering, and cite every factual claim as [title](url).',
  '- Fetching and searching are safe and cheap. Just do them.',
  '',
  'If a request is genuinely ambiguous, make the most reasonable assumption, say which assumption you made in one line, and continue.',
].join('\n');

// Puter is the default because it needs no key. The others are direct,
// OpenAI-compatible endpoints reached through our own server, which holds the
// key -- so the browser never sees one.
const PUTER_PROVIDER = 'puter';

// A direct provider answers in OpenAI's completion shape, with the message
// wrapped in choices[]. Unwrap it so the rest of the app sees the same
// { message } it gets from Puter and every existing helper keeps working.
function normalizeProviderReply(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.message) return data;
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (!choice || !choice.message) return null;
  // finish_reason explains an empty answer -- a token limit, a filter -- and
  // is the difference between "the model said nothing" and knowing why.
  return { message: choice.message, finishReason: choice.finish_reason, raw: data };
}

// A reply can arrive with nothing in it. Rather than print "(no reply)" and
// leave the user to guess, work out what happened from what did arrive.
function explainEmptyReply(message, finishReason) {
  if (finishReason === 'length') {
    return 'The model hit its output limit before writing an answer. Ask for something shorter, or split the request.';
  }
  if (finishReason === 'content_filter') {
    return 'The provider filtered this response.';
  }
  if (message && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return 'The model asked for another tool step but sent no answer with it. Ask it to continue.';
  }
  return 'The model returned an empty response. This usually clears on a retry; if it repeats, try another model.';
}

// OpenRouter publishes real prices, so cost is a fact rather than a guess at
// the name. Only 21 of its ~430 models are actually free, and the ":free"
// suffix alone was not a reliable signal. Nara and NVIDIA return no
// pricing: their free tier is an account-level allowance, so everything they
// list is free within it, which is why a missing price counts as free.
function isFreeModel(model) {
  if (!model) return false;
  const pricing = model.pricing;
  if (pricing && (pricing.prompt !== undefined || pricing.completion !== undefined)) {
    return Number(pricing.prompt || 0) === 0 && Number(pricing.completion || 0) === 0;
  }
  // No published price. This is an assumption, not a fact: a provider that
  // publishes nothing might meter an account allowance, or might simply
  // require billing before any call succeeds -- one answers "Payment
  // required to access this resource" on a key without one. Treating an
  // unpriced model as free keeps it visible so the provider can say which,
  // rather than hiding a catalogue the user may well have access to. The
  // error, when it comes, is now reported accurately.
  return true;
}

// Providers mark a free model in the id when they publish no prices. OpenRouter
// uses a ":free" suffix; others use "-free".
function isFreeModelId(id) {
  return /[:-]free$/i.test(String(id || ''));
}

// The GitHub tools only work on a model that accepts them. Sending tools to
// one that doesn't is a request that can only fail, so the caller checks first
// and drops them. A provider that reports nothing is given the benefit of the
// doubt rather than having the tools withheld.
function supportsTools(model) {
  const params = model && model.supportedParameters;
  return Array.isArray(params) ? params.includes('tools') : true;
}

// A model that emits audio or images can't hold a conversation, however
// promising its name. OpenRouter lists several among the free models.
function emitsText(model) {
  const out = model && model.outputModalities;
  return Array.isArray(out) ? out.includes('text') : true;
}

// Families that are good at code or long-form reasoning. This is a heuristic
// over model names, not a benchmark: it decides ordering in a dropdown, and
// being wrong costs a scroll, not a wrong answer.
const CAPABLE_MODEL_PATTERN =
  /(coder|code|deepseek|qwen ?3|qwen3|qwen2\.5|llama-?3\.[13]|llama-?4|kimi|glm|mistral-large|devstral|minimax|gpt-oss|nemotron|command-a|reasoner|thinking|r1\b)/i;

function isCapableModelId(id) {
  return CAPABLE_MODEL_PATTERN.test(String(id || ''));
}

// Providers return their whole catalogue -- OpenRouter's runs to hundreds --
// including embedding and audio models that can only fail on a chat call.
// Drop those, then float what the user actually wants to the top: free first,
// then models suited to research and coding.
function usableChatModels(models, limit = 60) {
  const skip = /(embed|rerank|whisper|tts|moderation|guard|safety|vision-only|image|dall-e|stable-diffusion|flux|lyria)/i;
  const usable = (models || [])
    .filter((m) => m && typeof m.id === 'string' && !skip.test(m.id) && emitsText(m))
    .map((m) => ({
      id: m.id,
      ownedBy: m.ownedBy || m.owned_by,
      contextLength: m.contextLength,
      supportedParameters: m.supportedParameters,
      free: isFreeModel(m),
      capable: isCapableModelId(m.id),
      tools: supportsTools(m),
    }));

  const rank = (m) => (m.free ? 0 : 4) + (m.tools ? 0 : 2) + (m.capable ? 0 : 1);
  return usable
    .map((m, index) => ({ m, index }))
    // Keep the provider's own order within a rank, so "newest first" survives.
    .sort((a, b) => rank(a.m) - rank(b.m) || a.index - b.index)
    .map(({ m }) => m)
    .slice(0, limit);
}

// One line under a model's name in the picker.
function describeProviderModel(model) {
  if (!model) return '';
  const parts = [];
  if (model.free) parts.push('free');
  if (model.tools === false) parts.push('no tools');
  if (model.capable) parts.push('code / research');
  if (model.contextLength >= 1000000) parts.push('1M ctx');
  else if (model.contextLength >= 200000) parts.push(Math.round(model.contextLength / 1000) + 'k ctx');
  if (!parts.length && model.ownedBy) parts.push(model.ownedBy);
  return parts.slice(0, 3).join(' · ');
}

// A 402 or 403 can mean two very different things, and the difference decides
// what to do about it.
//
//   "thinkingmachines/inkling:free is only available on agentic harnesses"
//       -- one model is off limits; drop it and pick another.
//
//   "A payment method is required. Add one at .../billing"
//       -- the whole account is off limits; dropping models one at a time just
//          burns a failed request per model until the list is empty.
//
// A message that names the model is about that model. One that talks about
// payment, billing or the plan without naming a model is about the account.
function isAccountLevelFailure(message, modelId) {
  const text = String(message || '');
  if (!text) return false;
  if (modelId && text.includes(modelId)) return false;
  // Matched on the concepts rather than a word order: providers phrase this as
  // "payment required", "a payment method is required" and "requires a payment
  // method", and all three mean the same thing.
  return /payment method|payment (is )?required|billing|subscription|upgrade your plan|no active plan|add funds/i.test(text);
}

// Server-Sent Events arrive as newline-delimited `data:` lines. A single
// provider chunk may contain several events, or a half-finished event that
// the next chunk completes. This parser does not maintain state (that is the
// caller's job), so it expects to be fed decoded chunks that each start and
// end on event boundaries. In practice that holds: the browser's text decoder
// and the Node stream reader both emit line-aligned chunks for SSE.
// Returns an array of parsed payloads: a JSON object when the line carried
// data, the string "[DONE]" for a final sentinel, or null for comments.
function parseSseChunk(decoded) {
  if (!decoded) return [];
  return decoded.split('\n').reduce((out, line) => {
    if (line.startsWith(':') || line.trim() === '') return out;
    if (line.startsWith('data: ')) {
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') { out.push('[DONE]'); return out; }
      try { out.push(JSON.parse(payload)); } catch { /* partial/unknown line */ }
    }
    return out;
  }, []);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MODES,
    DEFAULT_MODE,
    isValidMode,
    modePrompt,
    SKILL_SOURCES,
    BUILD_CORE_SKILLS,
    skillsAllowedForMode,
    skillTriggerScore,
    pickSkills,
    renderSkillsPrompt,
    USE_SKILL_TOOL,
    isUseSkillTool,
    parseSkillFrontmatter,
    MODELS,
    DEFAULT_MODEL,
    isValidModel,
    escapeHtml,
    ATTACHABLE_EXTENSIONS,
    isAttachableFile,
    renderMarkdownLite,
    detectsImageIntent,
    VISION_MODEL_IDS,
    DEFAULT_VISION_MODEL,
    isVisionCapable,
    DOCUMENT_EXTENSIONS,
    isDocumentFile,
    GITHUB_TOOLS,
    GITHUB_TOOL_NAMES,
    WEB_TOOLS,
    WEB_TOOL_NAMES,
    MAX_TOOL_ROUNDS,
    TOOL_ROUNDS_EXHAUSTED_PROMPT,
    EMPTY_REPLY_NUDGE,
    isGithubTool,
    isWebTool,
    safeJson,
    isToolsRejection,
    modelTokens,
    matchListEntry,
    parseToolArgs,
    describeToolCall,
    extractMessageText,
    extractMessageReasoning,
    extractToolCalls,
    toConversationMessage,
    EFFORT_LEVELS,
    DEFAULT_EFFORT,
    EFFORT_CAPABLE_MODEL_IDS,
    supportsEffort,
    isValidEffort,
    isEffortUnsupportedError,
    isRateLimitError,
    RATE_LIMIT_RETRIES,
    RATE_LIMIT_BASE_DELAY_MS,
    isOutOfCreditsError,
    HEAVY_MODEL_IDS,
    isHeavyModel,
    estimateCostWarning,
    MAX_CONVERSATIONS,
    MAX_MESSAGES_PER_CONVERSATION,
    deriveChatTitle,
    conversationToMarkdown,
    MAX_HISTORY_MESSAGES,
    buildChatHistory,
    SYSTEM_PROMPT,
    PUTER_PROVIDER,
    normalizeProviderReply,
    explainEmptyReply,
    isAccountLevelFailure,
    usableChatModels,
    isFreeModelId,
    isFreeModel,
    supportsTools,
    emitsText,
    isCapableModelId,
    describeProviderModel,
    newConversation,
    sortConversations,
    upsertConversation,
    migrateLegacyMessages,
    parseSseChunk,
  };
}
