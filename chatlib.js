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
  chat: [
    'MODE: CHAT. The user wants an answer, not a change to anything.',
    'Research it: search the web and read pages whenever the answer depends on anything past your training, prefer primary sources, and cite them as [title](url).',
    'You can read this workspace and any connected repository, but you have no tools that write, commit, delete or run a command -- in this mode they are not offered at all. So never promise to "just fix it" here: say what would change, and that Build mode is where it happens.',
    'Answer plainly and finish. No plan document, no todo list, no commit.',
  ].join('\n'),
  plan: [
    'MODE: PLAN. The user wants an implementation plan, not changes.',
    'Your tools are read-only on purpose: in this mode there is no way to write a file, commit, or delete anything, so investigate freely and propose -- never report a change as done.',
    'Investigate first (read the repo and the workspace, search the web for unknowns), then answer with:',
    'a short goal statement, what you found in the code (file paths), a numbered step-by-step plan, risks, and open decisions.',
    'Record the plan you propose as tasks with the task tools, so Build mode picks it up rather than re-deriving it.',
    'End by asking the user to switch to Build mode to execute.',
  ].join('\n'),
  build: [
    'MODE: BUILD. You are executing agreed work, and this is the only mode with the tools to change anything. Be disciplined about it:',
    '- Prefer the smallest change that fully solves the request; reuse what the repo already has.',
    '- For behavior changes, write or adjust a test first when the repo has tests to attach to.',
    '- Verify before claiming done: run what the repo offers (tests, build, lint) -- with run_command when it is offered, and never claim a result you did not read.',
    // The todo list is the plan of record. Kept in the mode prompt rather than
    // added to each request, because this text never changes between turns and a
    // request that grows on every turn cannot be cached (#89).
    '- Work from the todo list: record the plan as tasks before a multi-step job, update each status as it moves, and when the request changes revise the list -- add what is new, drop what is no longer wanted -- rather than starting a second plan beside it.',
    '- Finish every todo before you report. If one is genuinely still open, name it and say why; never report the work as complete while the list says otherwise.',
    '- Summarize what changed, what you verified, and what you deliberately did not do.',
    '- Commits and shell commands still require the user\'s explicit approval through the app\'s own confirmation, so ask for the command you want rather than a way around it.',
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
//
// Beyond name/description (the auto-router's matching signal) two optional
// keys travel through, mirroring Claude Code's skill frontmatter:
// - `allowed-tools`: space- or comma-separated function names in this app's
//   own vocabulary (workspace_read_file, github_commit_file, ...). A skill
//   that declares them offers only those tools while active.
// - `disable-model-invocation: true`: the skill never auto-pins; only an
//   explicit `/name` brings it in. For workflows with side effects, where
//   the model must not decide timing on its own.
function parseSkillFrontmatter(markdown) {
  const text = String(markdown || '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { name: '', description: '', allowedTools: null, userOnly: false };
  const out = { name: '', description: '', allowedTools: null, userOnly: false };
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|description|allowed-tools|disable-model-invocation):\s*(.*)$/.exec(lines[i].trim());
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
    const key = m[1];
    const clean = value.replace(/^"|"$/g, '');
    if (key === 'allowed-tools') {
      const list = clean.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      out.allowedTools = list.length ? list : null;
    } else if (key === 'disable-model-invocation') {
      out.userOnly = /^(true|1|yes)$/i.test(clean);
    } else {
      out[key] = clean;
    }
  }
  return out;
}

// Curated sources. anthropics/skills is the full official library and
// obra/superpowers is the development-methodology set; the rest are added for
// what they do that those two do not.
//
// Three rules kept this list from growing a tail. A source has to publish real
// SKILL.md files with frontmatter (that is what the router scores). Its skills
// have to be *useful to a chat app* -- `mksglu/context-mode` was left out
// because its skills instruct the agent to call tools this app does not have,
// and `heygen-com/hyperframes` because they produce video. And a repo whose
// skills would swamp the picker was left out whole: `openai/plugins` ships 536
// across vendor plugins, which is a browsing problem, not a library.
const SKILL_SOURCES = [
  { repo: 'anthropics/skills', branch: 'main', dir: 'skills', pick: 'all' },
  { repo: 'obra/superpowers', branch: 'main', dir: 'skills', pick: 'all' },
  // Engineering practice: review, diagnosis, codebase and domain design.
  { repo: 'mattpocock/skills', branch: 'main', dir: 'skills', pick: 'all' },
  // The other half of a general assistant's work: copy, SEO, ads, analytics.
  { repo: 'coreyhaines31/marketingskills', branch: 'main', dir: 'skills', pick: 'all' },
  // Ponytail is the lazy-senior-dev discipline -- YAGNI, stdlib first, no
  // unrequested abstraction. Its audit/review/debt/gain companions earn their
  // place beside it; the rest of the repo is packaging for other clients.
  {
    repo: 'DietrichGebert/ponytail',
    branch: 'main',
    dir: '.openclaw/skills',
    pick: ['ponytail', 'ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help'],
  },
  {
    repo: 'JuliusBrussee/caveman',
    branch: 'main',
    dir: 'skills',
    pick: ['caveman', 'lean-build', 'surgical-patch', 'verify-and-stop', 'caveman-commit'],
  },
  // Writing, in deliberately different voices: rewriting AI tells out of prose,
  // sharpening a draft without flattening it, and the compression discipline.
  // A SKILL.md at the repository root is the whole skill -- hence dir ''.
  { repo: 'blader/humanizer', branch: 'main', dir: '', pick: 'all' },
  { repo: 'petergyang/no-ai-slop', branch: 'main', dir: 'skills', pick: 'all' },
  // Diagrams as standalone HTML/SVG, from a plain description or a repo.
  { repo: 'cathrynlavery/diagram-design', branch: 'main', dir: 'skills', pick: 'all' },
  { repo: 'tt-a1i/archify', branch: 'main', dir: 'archify', pick: 'all' },
  // Output shaped for a reader who needs the next action first.
  { repo: 'ayghri/i-have-adhd', branch: 'main', dir: 'skills', pick: 'all' },
];

// The skills in one repo's git tree, as { name, path } pairs.
//
// Nesting is real and has to be handled: a repo can keep
// `skills/engineering/code-review/SKILL.md`, and naming a skill by the first
// segment under the directory would call all thirty-seven of one repo's skills
// "engineering" and collapse them into one. The name is therefore the folder
// *holding* the file. A SKILL.md directly inside the directory, or at the root
// of a repo whose `dir` is '', is the skill itself and takes the repo's name.
//
// Same-named skills within one source keep the first: the catalogue addresses
// skills by name, so a duplicate would be unreachable anyway.
function skillEntriesFromTree(tree, source) {
  const dir = String((source && source.dir) || '').replace(/^\/+|\/+$/g, '');
  const repo = String((source && source.repo) || '');
  const fallback = repo.split('/').pop() || 'skill';
  const prefix = dir ? dir + '/' : '';
  const found = [];
  for (const node of Array.isArray(tree) ? tree : []) {
    if (!node || node.type !== 'blob' || typeof node.path !== 'string') continue;
    const path = node.path;
    if (!path.endsWith('SKILL.md')) continue;
    if (prefix) {
      if (!path.startsWith(prefix)) continue;
    } else if (path !== 'SKILL.md') {
      continue;
    }
    const segments = path.split('/');
    const folder = segments.length >= 2 ? segments[segments.length - 2] : '';
    found.push({ name: folder || fallback, path: path });
  }
  const wanted = Array.isArray(source && source.pick)
    ? found.filter((e) => source.pick.includes(e.name))
    : found;
  const seen = new Set();
  const out = [];
  for (const entry of wanted) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return out;
}

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

// --- What a mode may do, as a tool surface rather than a sentence ---
//
// A mode that only asks nicely is not a mode. opencode's plan mode is read-only
// because the write tools are not in the request at all, which is the version
// that holds: a model with a tool in front of it will reach for it, whatever the
// instruction above says. So each mode gets its own list here, and the executor
// refuses a write that arrives anyway -- a resumed turn from another mode, or a
// model calling a tool from memory.
//
//   chat   research: the web, this workspace, connected repos -- all read-only
//   plan   the same, plus the task list the plan is recorded in
//   build  everything, and it is the only mode that changes anything
//
// A tool in no group is offered in every mode. That is deliberate for a name
// this table has never seen: a read-only tool added later must not be locked out
// of two modes by omission. Every *write* is listed in a write group below, and
// those are the groups the executor checks, so a write added without one is
// still stopped by the approval dialog every write already goes through.
const TOOL_GROUPS = {
  research: ['web_search', 'web_fetch'],
  shell: ['run_command'],
  workspaceRead: ['workspace_list_files', 'workspace_read_file', 'workspace_search_files'],
  workspaceWrite: ['workspace_write_file', 'workspace_edit_file', 'workspace_delete_file'],
  repoRead: ['github_list_repos', 'github_list_files', 'github_read_file', 'github_search_code', 'github_list_commits', 'github_list_branches'],
  repoWrite: ['github_commit_file', 'github_delete_file', 'github_create_branch'],
  plan: ['task_list', 'task_add', 'task_update'],
  skills: ['use_skill'],
};

const MODE_TOOL_GROUPS = {
  chat: ['research', 'workspaceRead', 'repoRead'],
  plan: ['research', 'workspaceRead', 'repoRead', 'plan', 'skills'],
  build: ['research', 'workspaceRead', 'workspaceWrite', 'repoRead', 'repoWrite', 'plan', 'skills', 'shell'],
};

// The groups that change something outside this conversation: a file in the
// workspace, a file in a repository. The task list is deliberately not one of
// them -- a plan is a note to self, and Plan mode is exactly where it is written.
const WRITE_TOOL_GROUPS = ['workspaceWrite', 'repoWrite', 'shell'];

function toolGroupsForName(name) {
  const wanted = String(name || '');
  return Object.keys(TOOL_GROUPS).filter((group) => TOOL_GROUPS[group].includes(wanted));
}

function modeAllowsTool(mode, name) {
  const groups = toolGroupsForName(name);
  if (!groups.length) return true;
  const allowed = MODE_TOOL_GROUPS[mode] || MODE_TOOL_GROUPS[DEFAULT_MODE];
  return groups.every((group) => allowed.includes(group));
}

// What the model is actually offered, which is what a mode really is.
//
// Entries that name no tool are dropped rather than passed on: this list goes
// straight into a request, and a provider rejects the whole turn over one
// malformed spec -- so a filter is the wrong place to keep something unusable.
function toolsForMode(mode, tools) {
  return (Array.isArray(tools) ? tools : []).filter((tool) => {
    const name = tool && tool.function && tool.function.name;
    return typeof name === 'string' && name && modeAllowsTool(mode, name);
  });
}

// The belt to those braces: a call that got through anyway is refused here.
function modeBlocksWrite(mode, name) {
  if (mode === 'build') return false;
  const groups = toolGroupsForName(name);
  return groups.some((group) => WRITE_TOOL_GROUPS.includes(group));
}

// What the model is told when it is refused, in the words a user would use.
function modeWriteRefusal(mode, name) {
  const label = mode === 'plan' ? 'Plan' : 'Chat';
  const next = mode === 'plan'
    ? 'Finish the plan and tell the user to switch to Build mode to execute it.'
    : 'Describe what would change and say that Build mode is where it happens.';
  return 'Refused: ' + label + ' mode is read-only, so ' + name + ' was not run. Nothing changed. ' + next;
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
  'those', 'been', 'being', 'does', 'doing', 'did', 'done', 'like', 'well', 'way', 'new',
  // Questions and bare auxiliaries. These were the single biggest source of
  // wrong picks: every library writes "Use when the user asks why...", so a
  // plain JavaScript question was being answered with SEO skills, all of them
  // matching on the word "why". A word that appears inside a sentence *about*
  // the trigger is not itself a trigger.
  'what', 'why', 'who', 'whom', 'whose', 'which', 'how', 'won', 'then', 'there',
  'here', 'should', 'would', 'could', 'may', 'might', 'must', 'shall', 'will',
  'say', 'says', 'said', 'please', 'thanks', 'thank', 'hello', 'sure', 'yeah',
  'explain', 'tell', 'ask', 'asks', 'asked', 'asking', 'my', 'me', 'our', 'us',
  'thing', 'things', 'stuff', 'anything', 'something', 'everything', 'nothing',
  // Two-letter words are kept as tokens now, so every ordinary one has to be
  // stopped or "ad", "ai" and "ui" would drown in them. The point of keeping
  // short tokens at all is that they are real names for real things.
  'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'if', 'in', 'is', 'it', 'no',
  'of', 'on', 'or', 'so', 'to', 'up', 'we', 'ok', 'id', 'vs', 'eg', 'ie', 'th']);

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

// Two letters and up, not three: "ad", "ui", "js", "ci" and "pr" are the
// names of real things, and "ad variations" has to be able to reach ad-creative.
// The cost of keeping them is that every ordinary two-letter word has to be
// stopped, which is why the stop list ends with a block of them.
const MIN_SKILL_TOKEN = 2;

function skillTokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9.]+/)
    // A full stop at the edge belongs to the sentence, not the word. Without
    // this, the last word of every description is unmatchable -- "abstractions."
    // never meets "abstractions" -- which quietly costs every skill that ends a
    // sentence with the word it is really about. Dots *inside* a token stay, so
    // a version like "5.4" is one token rather than "5" and "4".
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length >= MIN_SKILL_TOKEN && !SKILL_STOP.has(t))
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

// How many distinct words of the request a skill answers. The minimum is
// applied to this count rather than to the score, because "one shared word" is
// the unit the rule is about: a threshold on the score would move the moment a
// word was weighted, and this has to stay checkable from the outside.
function skillHitCount(requestText, skill) {
  const want = new Set(skillTokens(requestText));
  if (!want.size) return 0;
  const name = new Set(skillTokens(skill && skill.name));
  const desc = new Set(skillTokens(skill && skill.description));
  let hits = 0;
  for (const t of want) if (name.has(t) || desc.has(t)) hits += 1;
  return hits;
}

// The fewest shared words a skill may be picked on. One shared word is a
// coincidence: the library's long trigger lists contain every ordinary word
// somewhere, and a router that acts on one of those answers a JavaScript
// question with a marketing skill. Two shared words, or one that is part of the
// skill's own name, is evidence. Kept as the unweighted count deliberately --
// see skillHitCount.
const MIN_SKILL_HITS = 2;

// How many words a description is, used only to break ties. Between two skills
// that matched equally, the one that says less is the stronger evidence: a
// focused description sharing a word means more than a keyword list sharing it.
function skillDescriptionWeight(skill) {
  return skillTokens(skill && skill.description).length;
}

// Whether any word of the skill's own name appears in the request. A name hit
// is the one thing a single shared word can be.
function skillNamesMatchesRequest(requestText, skill) {
  const want = new Set(skillTokens(requestText));
  if (!want.size) return false;
  for (const t of new Set(skillTokens(skill && skill.name))) if (want.has(t)) return true;
  return false;
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
    // A user-only skill (disable-model-invocation) never auto-pins: only an
    // explicit `/name` brings it in. This is the auto path; deliberate pins
    // bypass pickSkills entirely, so they are unaffected.
    .filter((s) => !s.userOnly)
    .filter((s) => !processOnly || PROCESS_HINT.test(s.description));
  const scored = pool
    .map((s) => ({
      s,
      score: skillTriggerScore(requestText, s),
      hits: skillHitCount(requestText, s),
      named: skillNamesMatchesRequest(requestText, s),
      weight: skillDescriptionWeight(s),
    }))
    // Worth >= 2 points is the same rule as "two shared words, or one that is
    // part of the skill's own name" -- but stated as the rule, because the old
    // `score >= 2` was a number nobody could check without re-deriving it.
    .filter(({ hits, named }) => hits >= MIN_SKILL_HITS || named)
    // Score first, then the tighter description, then the name. The last two are
    // only ever tie-breaks -- but without them the winner of a tie was whichever
    // library happened to be listed first, which is how "draft three ad
    // variations" was answered by a general-purpose nudge rather than by the
    // skill actually called ad-creative.
    .sort((a, b) => (b.score - a.score) || (a.weight - b.weight) || String(a.s.name).localeCompare(String(b.s.name)));
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
  // The methodology core watches over real work. Seeding it into a request that
  // matched nothing at all is how "thanks, that worked" came back carrying
  // test-driven-development: nothing had been recognised, so three disciplines
  // were handed over instead of none.
  if (mode === 'build' && scored.length) for (const name of BUILD_CORE_SKILLS) push(name);
  return picked;
}

// Narrows the offered tools to what the turn's skills allow. A skill that
// declares `allowed-tools` names this app's function names
// (workspace_read_file, github_commit_file, ...); the turn offers the union
// of every declaring skill's list, and skills without the field abstain, so
// a turn with no declarations is unchanged. Union, not intersection: two
// scoped skills with disjoint sets would otherwise starve the turn to zero
// tools, which reads as a broken model rather than a safe one.
function filterToolsBySkills(tools, activeSkills) {
  if (!Array.isArray(tools)) return tools;
  const declaring = (Array.isArray(activeSkills) ? activeSkills : [])
    .filter((s) => s && Array.isArray(s.allowedTools) && s.allowedTools.length);
  if (!declaring.length) return tools;
  const allow = new Set();
  for (const s of declaring) for (const n of s.allowedTools) allow.add(String(n).toLowerCase());
  return tools.filter((t) => {
    const name = t && t.function && t.function.name;
    return name ? allow.has(String(name).toLowerCase()) : true;
  });
}

// Renders picked skills as extra system context. Bounded excerpts: the
// overview carries the method; the model can ask for the full text via
// use_skill if it needs the detailed sections.
//
function filterToolsBySkills(tools, activeSkills) {
  if (!Array.isArray(tools)) return tools;
  const declaring = (Array.isArray(activeSkills) ? activeSkills : [])
    .filter((s) => s && Array.isArray(s.allowedTools) && s.allowedTools.length);
  if (!declaring.length) return tools;
  const allow = new Set();
  for (const s of declaring) for (const n of s.allowedTools) allow.add(String(n).toLowerCase());
  return tools.filter((t) => {
    const name = t && t.function && t.function.name;
    return name ? allow.has(String(name).toLowerCase()) : true;
  });
}

// Dynamic context injection (`!` commands) for a skill that needs current
// workspace state. Spike gate: aborts when no workspace root is present,
// rather than inventing a non-existent repo.
const SKILL_COMMAND_ALLOWLIST = ['git status --short', 'git diff --stat', 'git log --oneline -5'];
function extractWorkspaceState(workspaceRoot = '.') {
  try {
    const fs = require('fs');
    const { execSync } = require('child_process');
    const root = fs.existsSync(workspaceRoot) ? workspaceRoot : '.';
    const stat = execSync('git status --short', { cwd: root, encoding: 'utf8', maxBuffer: 64000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const diff = execSync('git diff --stat', { cwd: root, encoding: 'utf8', maxBuffer: 64000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return `Workspace (${root}): status — ${stat ? stat.split('\\n').slice(0, 5).join('; ') : '(clean)'}; diff stat — ${diff || '(none)'}.`;
  } catch {
    return null;
  }
}

// A pinned skill (see below) is marked, and the header changes with it: "this
// request" is the wrong instruction for something the user asked to apply to the
// whole chat, and the model follows that instruction literally.
function renderSkillsPrompt(picked, excerptLength = 1200) {
  if (!Array.isArray(picked) || !picked.length) return '';
  const parts = picked.map((s) =>
    `### Skill: ${s.name} (from ${s.source})${s && s.pinned ? ' [pinned]' : ''}\n${(s.description || '').trim()}\n\n${String(s.body || '').slice(0, excerptLength).trim()}`
  );
  const pinned = picked.some((s) => s && s.pinned);
  return [
    pinned
      ? 'ACTIVE SKILLS — the user pinned these to this chat, so they apply to every request in it:'
      : 'ACTIVE SKILLS — follow these methods for this request:',
    '(If a skill references scripts or files that are not available here, apply its approach manually.)',
    '',
    parts.join('\n\n---\n\n'),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Skills a chat was told to use
// ---------------------------------------------------------------------------
//
// The router above picks per request and then forgets: the next question scores
// from scratch. These are different. A skill the user asked for by name belongs
// to the conversation -- `/ponytail` on the first message is still applying on
// the ninth, in every mode, and survives a reload because it is stored with the
// chat. A new chat starts with none of them, so a choice is never inherited by a
// conversation that did not make it.
//
// Explicit beats automatic in both directions: a pinned skill rides along even
// when auto-picking is switched off, or the mode allows no skills at all,
// because someone naming a skill is not asking for the router's opinion.

// A ceiling, because every skill is prompt budget on every request. Adding past
// it drops the oldest choice and says so rather than silently refusing.
const MAX_ACTIVE_SKILLS = 5;

function activateSkill(active, name) {
  const wanted = String(name || '').trim().toLowerCase();
  const list = (Array.isArray(active) ? active : []).map((n) => String(n));
  if (!wanted) return { names: list, dropped: '' };
  if (list.some((n) => n.toLowerCase() === wanted)) return { names: list, dropped: '' };
  const next = [...list, wanted];
  const dropped = next.length > MAX_ACTIVE_SKILLS ? next.shift() : '';
  return { names: next, dropped };
}

function deactivateSkill(active, name) {
  const wanted = String(name || '').trim().toLowerCase();
  return (Array.isArray(active) ? active : []).filter((n) => String(n).toLowerCase() !== wanted);
}

// The pinned names as catalogue rows, in the order they were chosen. A name that
// is not installed is dropped: the catalogue is the truth about what can run.
function pinnedSkills(active, catalog) {
  const rows = [];
  for (const name of Array.isArray(active) ? active : []) {
    const wanted = String(name).toLowerCase();
    const row = (Array.isArray(catalog) ? catalog : [])
      .find((s) => s && String(s.name).toLowerCase() === wanted);
    if (row) rows.push(row);
  }
  return rows;
}

// Everything that rides one request: the pinned skills, always, then whatever
// the router adds for this question. Pinned first, because someone's choice
// should not be the one that falls off the end of the prompt.
function skillsForTurn({ mode, skillsEnabled, requestText, active, catalog } = {}) {
  const pinned = pinnedSkills(active, catalog).map((s) => ({ ...s, pinned: true }));
  const auto = skillsEnabled ? pickSkills(requestText, mode, catalog) : [];
  const seen = new Set(pinned.map((s) => s.name));
  return [...pinned, ...auto.filter((s) => !seen.has(s.name))];
}

// ---------------------------------------------------------------------------
// Which skills someone actually reaches for
// ---------------------------------------------------------------------------
//
// A pin is the strongest signal this app has about what a person wants from a
// skill: it is deliberate, it is per chat, and it is typed or clicked rather
// than inferred. One pin in one chat is a mood. The same skill pinned in two
// different chats is a habit, and a habit is worth offering before it has to be
// typed a third time.
//
// Two rules keep this from becoming a suggestion engine with opinions of its
// own. Habit is counted by *chat*, not by click: pinning the same skill twice in
// one conversation is one intention, and un-pinning and re-pinning it must not
// look like enthusiasm. And only deliberate pins count -- a skill the model
// loaded for itself with use_skill is the app's doing, not a preference, and
// counting it would make the model's own choices suggest themselves back.
const SKILL_HABIT_CHATS = 2;
const MAX_TRACKED_SKILLS = 60;
const MAX_TRACKED_CHATS_PER_SKILL = 12;
// One name hit is worth three description hits in skillTriggerScore, so this is
// "the request names it, or shares two of the skill's own words".
//
// Two, and not three, because descriptions are long and written in trigger
// language that rarely repeats a person's phrasing verbatim: "compress this prose
// into fewer words" shares four tokens with caveman's description but none with
// its name, and an offer nobody ever sees is not cautious, it is absent. One
// shared word is below the line: that is where a suggestion engine starts
// interrupting. The offer is also dismissible per chat, capped at one at a time,
// and only ever made for a skill already pinned in two other chats, which is the
// part doing most of the work.
const SUGGEST_MIN_SCORE = 2;

function normalizeSkillUsage(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, entry] of Object.entries(raw)) {
    const key = String(name || '').trim().toLowerCase();
    if (!key || !entry || typeof entry !== 'object') continue;
    const chats = (Array.isArray(entry.chats) ? entry.chats : [])
      .filter((c) => typeof c === 'string' && c)
      .slice(-MAX_TRACKED_CHATS_PER_SKILL);
    if (!chats.length) continue;
    const lastAt = Number(entry.lastAt);
    out[key] = { chats, lastAt: Number.isFinite(lastAt) ? lastAt : 0 };
  }
  return out;
}

function pruneSkillUsage(usage) {
  const entries = Object.entries(normalizeSkillUsage(usage));
  if (entries.length <= MAX_TRACKED_SKILLS) return Object.fromEntries(entries);
  // Bounded by recency, so a long-lived browser cannot accumulate every skill
  // it has ever seen pinned.
  return Object.fromEntries(entries.sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, MAX_TRACKED_SKILLS));
}

// Records a deliberate pin. `counted` says whether this was a new chat for that
// skill -- the bar can then stay quiet about a habit it already knows.
function recordSkillPin(usage, name, conversationId, now = Date.now()) {
  const key = String(name || '').trim().toLowerCase();
  const id = String(conversationId == null ? '' : conversationId);
  const next = normalizeSkillUsage(usage);
  if (!key || !id) return { usage: next, counted: false };
  const entry = next[key] || { chats: [], lastAt: 0 };
  const known = entry.chats.includes(id);
  next[key] = {
    chats: known ? entry.chats : [...entry.chats, id].slice(-MAX_TRACKED_CHATS_PER_SKILL),
    lastAt: Number(now),
  };
  return { usage: pruneSkillUsage(next), counted: !known };
}

// Skills pinned in enough different chats to count as a habit, most-used first.
function learnedSkillNames(usage) {
  return Object.entries(normalizeSkillUsage(usage))
    .filter(([, entry]) => entry.chats.length >= SKILL_HABIT_CHATS)
    .sort((a, b) => (b[1].chats.length - a[1].chats.length) || (b[1].lastAt - a[1].lastAt))
    .map(([name]) => name);
}

// The one skill to offer for this text, or null.
//
// Deliberately at most one: a row of suggestions is a menu, and a menu is what
// the picker is for. The offer is a question, never an action -- a skill that
// switched itself on would be spending prompt budget on every request of a chat
// that never asked for it.
function suggestSkillFor(requestText, catalog, usage, { active = [], dismissed = [] } = {}) {
  const text = String(requestText || '').trim();
  // Too little to be a request: "ok", "hi", a paste of one word.
  if (text.length < 8) return null;
  const taken = new Set([...active, ...dismissed].map((n) => String(n).toLowerCase()));
  const habits = learnedSkillNames(usage);
  const rows = Array.isArray(catalog) ? catalog : [];
  const chatCounts = normalizeSkillUsage(usage);
  let best = null;
  for (const name of habits) {
    if (taken.has(name)) continue;
    const row = rows.find((s) => s && String(s.name).toLowerCase() === name);
    // A skill that is no longer installed cannot be offered.
    if (!row) continue;
    const score = skillTriggerScore(text, row);
    if (score < SUGGEST_MIN_SCORE) continue;
    const chats = chatCounts[name].chats.length;
    if (!best || score > best.score || (score === best.score && chats > best.chats)) {
      best = { skill: row, score, chats };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Commands typed into the composer
// ---------------------------------------------------------------------------

// Deliberately short: a command has to do something the buttons cannot, or it is
// noise in a list people have to read. `/skill` is the important one, and typing
// the skill's own name is shorthand for it -- how people actually reach for one.
const CHAT_COMMANDS = [
  { name: 'help', usage: '/help', desc: 'List these commands' },
  { name: 'skill', usage: '/skill <name>  ·  /skill off <name>', desc: 'Use an installed skill for the rest of this chat' },
  { name: 'skills', usage: '/skills', desc: 'Show what this chat is using' },
  { name: 'mode', usage: '/mode chat | plan | build', desc: 'Switch mode' },
  { name: 'clear', usage: '/clear', desc: 'Start a new chat — this one stays in the sidebar' },
  { name: 'compact', usage: '/compact on | off | status', desc: 'Reduce sent history for this session without changing the visible chat' },
];

// What a line typed into the composer means:
//   { kind: 'command', name, args }   a known command
//   { kind: 'skill', name }           /ponytail, when no command is named that
//   { kind: 'chain', names }          /review /verify — pins several at once
//   null                              plain text, sent to the model as usual
//
// Returning null for anything unrecognised is the important half: a message that
// merely starts with a slash -- a path, a date, a shrug -- is a message, and an
// app that swallowed it would be worse than a typo it never claimed to fix.
//
// A chain pins every named skill and consumes the line, exactly like one
// /skill does: the text stays visible as the user's message but is not sent.
// Asking in the same line would need send-path surgery (the composer can only
// consume or reply, not inject), so that stays a follow-up, not this change.
const MAX_SKILL_CHAIN = 3;
function resolveChatCommand(text, skillNames) {
  const line = String(text == null ? '' : text).trim();
  const match = /^\/([a-z][a-z0-9-]*)\s*([\s\S]*)$/i.exec(line);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const args = match[2].trim();
  if (CHAT_COMMANDS.some((c) => c.name === name)) return { kind: 'command', name, args };
  const known = (Array.isArray(skillNames) ? skillNames : []).map((n) => String(n).toLowerCase());
  if (!known.includes(name)) return null;
  // Leading run of /names: every token must carry its own slash, so args
  // never glue onto the chain by accident.
  const names = [name];
  const rest = args.split(/\s+/).filter(Boolean);
  for (const token of rest) {
    const m = /^\/([a-z][a-z0-9-]*)$/i.exec(token);
    if (!m || !known.includes(m[1].toLowerCase()) || names.length >= MAX_SKILL_CHAIN) break;
    names.push(m[1].toLowerCase());
  }
  if (names.length < 2) return { kind: 'skill', name };
  return { kind: 'chain', names };
}

function renderCommandsHelp() {
  return [
    'Commands',
    ...CHAT_COMMANDS.map((c) => '`' + c.usage + '` — ' + c.desc),
    '',
    'Or type `/` and a skill name — `/ponytail`, `/caveman`, `/humanizer` — to use it for the rest of this chat.',
    'Name up to three at once — `/review /verify` — to pin a whole stack with one line.',
  ].join('\n');
}

function renderSkillsCommandReply(active, catalog) {
  const installed = Array.isArray(catalog) ? catalog : [];
  const pinned = pinnedSkills(active, installed);
  const missing = (Array.isArray(active) ? active : [])
    .filter((n) => !pinned.some((s) => String(s.name).toLowerCase() === String(n).toLowerCase()));
  const lines = pinned.length
    ? ['Pinned to this chat: ' + pinned.map((s) => '`' + s.name + '`').join(', ')]
    : ['Nothing is pinned to this chat' + (installed.length ? ' — ' + installed.length + ' skills are installed' : '') + '.'];
  if (missing.length) lines.push('Not installed, so ignored: ' + missing.join(', '));
  lines.push('Type `/skill <name>`, or just `/<name>`, to add one; the × on a chip removes it.');
  return lines.join('\n\n');
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

// Tools that only read. Independent lookups can run together, which is the
// difference between one round trip and three for a question that needs three
// files read.
const CONCURRENT_SAFE_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'github_list_repos',
  'github_list_files',
  'github_read_file',
  // Code search and history are lookups too: a round that asks "where is this
  // called" and "who touched it last" is two reads, and reads may share a wave.
  'github_search_code',
  'github_list_commits',
  'use_skill',
  // Workspace reads only. A write is absent on purpose, so it keeps running on
  // its own and cannot interleave with another call. The task writers are
  // absent for the same reason.
  'workspace_list_files',
  'workspace_read_file',
  'workspace_search_files',
  'task_list',
]);

// A ceiling on how many go at once. A model can ask for a dozen lookups in one
// round, and firing them all at a free tier is how a 429 gets earned -- the app
// already backs off for them elsewhere.
const MAX_CONCURRENT_TOOLS = 4;

function isConcurrentSafeTool(name) {
  return CONCURRENT_SAFE_TOOLS.has(String(name || ''));
}

// Which of one round's calls may run together, given as positions rather than
// objects: the caller pairs results back to the calls the model actually asked
// for, so nothing depends on the order they finish in. Anything not known to be
// a read is serial, so a new or misspelled tool runs alone rather than being
// guessed at as safe to parallelise.
function planToolCalls(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const concurrent = [];
  const serial = [];
  list.forEach((call, index) => {
    const name = (call && call.function && call.function.name) || '';
    (isConcurrentSafeTool(name) ? concurrent : serial).push(index);
  });
  return { concurrent, serial };
}

// Positions cut into groups of at most `size`, in order, so a long round is sent
// in waves rather than all at once. An empty list yields no batches at all.
function batchIndices(indices, size = MAX_CONCURRENT_TOOLS) {
  const list = Array.isArray(indices) ? indices : [];
  const width = Math.max(1, Number(size) || 1);
  const batches = [];
  for (let i = 0; i < list.length; i += width) batches.push(list.slice(i, i + width));
  return batches;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Catches plain-language image requests ("generate an image of a fox",
// "draw me a logo") typed into normal chat, without requiring the user to
// notice the dedicated image-mode toggle first. The first pattern is deliberately
// strict; the second accepts a useful noun later in the phrase ("create a
// futuristic scene for...") without treating "make a plan for my image website"
// as a drawing request.
const IMAGE_INTENT_PATTERN =
  /^(?:please\s+)?(generate|create|draw|make|design|paint|render|illustrate|visualize|produce|compose)\s+(?:me\s+|us\s+)?(?:an?\s+)?(image|picture|photo|photograph|illustration|graphic|logo|icon|artwork|drawing|sketch|wallpaper|poster|banner|avatar|visual|scene|character|landscape|art)\b/i;
const IMAGE_EDIT_PATTERN =
  /\b(edit|modify|alter|recolor|recolour|retouch|transform|replace|remove|add|change|turn|swap)\b[\s\S]{0,100}\b(color|colour|background|object|person|car|vehicle|text|logo|style|lighting|image|photo|picture)\b/i;
const IMAGE_EDIT_REVERSE_PATTERN =
  /\b(color|colour|background|object|person|car|vehicle|text|logo|style|lighting|image|photo|picture)\b[\s\S]{0,100}\b(change|edit|modify|alter|recolor|recolour|retouch|transform|replace|remove|add|turn|swap)\b/i;

function detectsImageIntent(text) {
  const value = String(text || '').trim();
  if (IMAGE_INTENT_PATTERN.test(value)) return true;
  if (!/\b(generate|create|draw|make|design|paint|render|illustrate|visualize|produce|compose)\b/i.test(value)) return false;
  const imageWords = /\b(image|picture|photo|photograph|illustration|graphic|logo|icon|artwork|drawing|sketch|wallpaper|poster|banner|avatar|visual|scene|character|landscape|art)\b/i;
  if (!imageWords.test(value)) return false;
  // A prose noun that appears after a planning/software noun is not an image
  // request: "make a plan for my image website" is about a website. A request
  // whose image noun comes first remains valid: "create an image for my site".
  const imageAt = value.search(imageWords);
  const proseAt = value.search(/\b(plan|website|web\s+app|spreadsheet|budget|api|function|component|code|documentation)\b/i);
  if (proseAt >= 0 && proseAt < imageAt) return false;
  return true;
}

function detectsImageEditIntent(text) {
  const value = String(text || '').trim();
  return IMAGE_EDIT_PATTERN.test(value) || IMAGE_EDIT_REVERSE_PATTERN.test(value);
}

// The action is explicit so an attached-image edit can never fall through to a
// fresh text-to-image request or to an ordinary chat turn. `forced` is the image
// toggle; an attached image plus an edit verb wins over it because preserving the
// source is the user's stronger instruction.
function imageAction(text, hasImage = false, forced = false) {
  // An attached source is the stronger instruction: any image request that
  // arrives with it must be image-to-image, never a fresh text-only generation.
  // A plain vision question still falls through to chat.
  if (hasImage && (detectsImageEditIntent(text) || detectsImageIntent(text) || forced)) return 'edit';
  if (forced) return 'generate';
  return detectsImageIntent(text) ? 'generate' : 'chat';
}

// ---------------------------------------------------------------------------
// What kind of image turn is this, and what does the image model get told?
//
// ChatGPT does neither of those with keywords: the model reads the conversation,
// chooses generate or edit, and writes the prompt the image model actually
// receives -- the API hands it back as `revised_prompt`. This app's first
// version did the opposite. A regex picked generate-vs-edit from the raw text,
// and the raw text was sent on as the prompt. That is why "make the sky purple"
// with a photo attached answered *about* the photo instead of editing it: no
// verb-and-noun pair in the pattern matched, so the turn fell through to a
// vision chat and could never reach an image model at all.
//
// The rules below keep the deterministic decision as a *floor* rather than
// replacing it, because the failure it exists to prevent is worth keeping fixed:
// an attached picture must never become a fresh text-only render (the bug that
// drew a poster of a car where a recoloured one was asked for). A turn the
// pattern is sure about stays that kind of turn whatever the planner says; the
// planner can only move a turn *into* image work, never out of it.
//
// The planner is consulted only for turns that could plausibly be image work --
// something attached, or a plain-language draw request -- so an ordinary chat
// message never pays for the extra call.
const IMAGE_PLAN_ACTIONS = ['generate', 'edit', 'chat'];
const MAX_IMAGE_PROMPT_CHARS = 1200;

// Written as a contract rather than a conversation, because the reply has to be
// parseable. The instruction not to leave pronouns in the prompt is the one that
// matters most: "make it warmer" reaches a text-to-image model with nothing to
// warm, and a prompt referring to "the attached image" reaches it with a phrase
// no image model can resolve.
const IMAGE_PLANNER_PROMPT = [
  'You decide how an image request is handled. Reply with one JSON object and nothing else.',
  '',
  '{"action": "generate" | "edit" | "chat", "prompt": "..."}',
  '',
  '- "generate": draw a new picture from scratch.',
  '- "edit": change something in a picture the user supplied, or in the picture already shown in this chat, keeping the rest of it.',
  '- "chat": a question about a picture, or code or prose that merely mentions images. Nothing is drawn.',
  '',
  'The prompt you return is sent to the image model verbatim, so:',
  '- For "edit", say only what changes and what must stay: "recolour the car deep red; keep the wheels, the number plate and the background unchanged".',
  '- For "generate", write a self-contained description with subject, style and framing. Leave no pronoun such as "it" or "this" in it.',
  '- Write the prompt in English even when the request is not, and never mention the user, this chat, or "the attached image".',
  '- For "chat", return an empty prompt.',
].join('\n');

// Models wrap JSON in prose or a code fence however firmly they are told not to,
// so the first object in the reply is read rather than the whole body. Anything
// that does not parse is no plan at all, which leaves the deterministic floor in
// charge -- never a half-understood action guessing at what to draw.
function parseImagePlan(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const action = String(parsed.action || '').toLowerCase().trim();
  if (!IMAGE_PLAN_ACTIONS.includes(action)) return null;
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim().slice(0, MAX_IMAGE_PROMPT_CHARS) : '';
  return { action, prompt };
}

// --- Reading a drawing back against the request -------------------------------
//
// The prompt an image model receives is a rewrite of what the user said, and the
// picture is judged -- by the person who asked -- against what they said, never
// against the rewrite. Nothing compared the two: a drawing that met its prompt but
// missed the request looked exactly like a good one, and the only signal was the
// user noticing. One short question, asked of a model that can see the picture,
// closes that loop.
const IMAGE_CHECK_PROMPT = [
  'You are shown a picture that was just drawn, the request that asked for it, and the prompt the image model was given.',
  'Decide whether the picture shows what the request asked for. Judge the picture, not the prompt.',
  'Be strict about words in the picture (wording and spelling), about counts, and about anything the request named that is missing or wrong.',
  'Ignore style, quality and taste. Do not describe the picture.',
  'Reply with one line and nothing else:',
  'MATCHES',
  'or',
  'MISSED: <the single thing that differs, at most 12 words, in the terms the request used>',
].join('\n');

const MAX_IMAGE_CHECK_CHARS = 160;

// What the checking call is shown, in that order: the words that asked, then the
// words that drew. Both, because the two disagreeing is the whole point.
function imageCheckQuestion(requestText, promptText) {
  const text = (value) => String(value == null ? '' : value).trim();
  return ['The request:', text(requestText), '', 'The prompt the image model was given:', text(promptText)].join('\n');
}

// 'MATCHES', or 'MISSED: the sign reads HLLO'. Anything else -- a description, a
// hedge, a miss with nothing named -- is no verdict at all, which leaves no note
// rather than a guess.
// The prompt for a second attempt at a picture the reviewer found wanting.
//
// The difference is already the instruction -- the reviewer names one thing that
// is wrong, in the words of the request -- so it is folded in verbatim rather
// than paraphrased: a rewrite is a second chance to lose the one fact the retry
// exists for. Either half missing is no prompt, because a fix with nothing to
// fix would spend a render on the same picture, and an empty prompt is not what
// an image service should be sent.
function imageCheckFixPrompt(promptText, missed) {
  const prompt = String(promptText == null ? '' : promptText).trim();
  const difference = String(missed == null ? '' : missed).trim().slice(0, MAX_IMAGE_CHECK_CHARS);
  if (!prompt || !difference) return '';
  return prompt + '\n\nCorrect this in the next attempt: ' + difference;
}

const IMAGE_CHECK_ANSWER = /^\s*(match\w*|miss\w*|no)\b[\s:,.\u2026\u2013\u2014-]*(.*)$/i;

function parseImageCheck(text) {
  const lines = String(text == null ? '' : text).split('\n').map((line) => line.trim()).filter(Boolean);
  // The verdict line, not the first line: models like to introduce themselves.
  const verdict = lines.map((line) => IMAGE_CHECK_ANSWER.exec(line)).find(Boolean);
  if (!verdict) return null;
  if (/^match/i.test(verdict[1])) return { matches: true, missed: '' };
  const missed = verdict[2].replace(/^["\u201c'\s]+|["\u201d'\s.]+$/g, '').trim().slice(0, MAX_IMAGE_CHECK_CHARS);
  return missed ? { matches: false, missed } : null;
}

// The floor plus the plan, as one rule. `fallback` is what imageAction() decided
// from the text alone, and it wins whenever the plan cannot make the turn
// *better*: an edit stays an edit, a draw request stays a draw request, and a
// plain chat message only becomes image work when there is something to work
// from (an attachment, or a picture already in this chat) or the image toggle
// says so. Without those guards a chat that merely sounded like a description
// would start rendering pictures nobody asked for.
//
// The one asymmetry worth stating: a plan may ask for a *generation* only when
// the user turned the image toggle on. With a picture attached, "generate" would
// mean ignoring the picture -- the poster-of-a-car bug -- and the whole point of
// the deterministic floor is that no reading of the request can get back there.
// A follow-up that genuinely wants a new picture from an old one says so, and
// the toggle is right there.
function resolveImageAction(fallback, plan, options = {}) {
  const hasImage = !!(options && options.hasImage);
  const hasPreviousImage = !!(options && options.hasPreviousImage);
  const forced = !!(options && options.forced);
  const source = hasImage || hasPreviousImage;
  if (fallback === 'edit') return 'edit';
  if (fallback === 'generate') {
    if (plan && plan.action === 'edit' && source) return 'edit';
    return 'generate';
  }
  if (!plan) return 'chat';
  if (plan.action === 'edit' && source) return 'edit';
  if (plan.action === 'generate' && forced) return 'generate';
  return 'chat';
}

// The newest picture already in the conversation, which is what "now make it
// look realistic" is about. Chat keeps every generated picture it stores (see
// storedImagePlan), so the previous turn's image is the source of the next
// edit -- without it, multi-turn editing is impossible: no API hands an image
// model a picture the client cannot name, and re-attaching your own output by
// hand is not a thing anyone does.
// `urlOf` says how to get a showable URL out of one stored entry. It exists
// because an entry no longer always has one: a picture kept in the index is
// named by an id, and the page holds the readable form (see image-store.js).
// The default reads the entry's own url, which is what a link or an inline copy
// has, so callers that only ever see those need not pass anything.
function lastImageInMessages(messages, urlOf) {
  const list = Array.isArray(messages) ? messages : [];
  const read = typeof urlOf === 'function' ? urlOf : (im) => (typeof im.url === 'string' ? im.url : '');
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    const images = entry && Array.isArray(entry.images) ? entry.images : [];
    for (let j = images.length - 1; j >= 0; j -= 1) {
      const image = images[j];
      if (!image) continue;
      const url = read(image);
      if (url) return { url, prompt: String(image.prompt || '') };
    }
  }
  return null;
}

// Applies **bold**, *italic*, `inline code`, fenced code blocks, -/1. lists and
// [title](url) links to already-HTML-escaped text. Only ever emits a small
// fixed set of tags (strong/em/code/pre/ul/ol/li/a) around text that was
// escaped up front, so markdown syntax can never smuggle in a live tag.
function inlineFormat(s) {
  return s
    .replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^\n_]+?)__/g, '<strong>$1</strong>')
    .replace(/\*([^\n*]+?)\*/g, '<em>$1</em>')
    .replace(/(?<![\w])_([^\n_]+?)_(?![\w])/g, '<em>$1</em>');
}

const CODE_BLOCK_TOKEN = 'CODEBLOCKTOKEN';
const CODE_SPAN_TOKEN = 'CODESPANTOKEN';
const LINK_TOKEN = 'LINKTOKEN';

// A link only ever becomes an anchor when it is http(s). Everything else --
// javascript:, data:, vbscript:, a relative path -- stays visible as text.
// The web tools tell the model to cite sources as [title](url), and that text
// comes from pages it read, so the scheme check is what stops a hostile page
// from getting a clickable sink that runs script in our own document.
function safeLinkHref(url) {
  return /^https?:\/\//i.test(url) ? url : null;
}

// Matches [label](url). The url may contain balanced parentheses so that
// ordinary Wikipedia-style links (…/Foo_(bar)) stay whole, but never
// whitespace -- which is also why the href needs no attribute escaping of its
// own: a quote in the url was already turned into &quot; by escapeHtml, and a
// space (the only way to open a new attribute) cannot appear at all.
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]*)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g;

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

  // Links are held behind a token for the same reason code spans are, and it
  // matters more here: elsewhere in the line the emphasis passes would run
  // straight over the finished anchor and corrupt it. A url containing _x_ or
  // a*b*c is enough -- those become <em> inside the href. Running after the
  // code passes also means a link inside `code` or a fence stays literal.
  const links = [];
  text = text.replace(MARKDOWN_LINK_PATTERN, (match, label, url) => {
    const href = safeLinkHref(url);
    if (!href) return match;
    const idx = links.length;
    links.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${inlineFormat(label)}</a>`);
    return `@@${LINK_TOKEN}${idx}@@`;
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
  const linkTokenPattern = new RegExp(`@@${LINK_TOKEN}(\\d+)@@`, 'g');

  // Links go back in first: an anchor built from a label like [`code`](url)
  // still holds a code-span token, and that has to be resolved before the
  // final string leaves this function.
  return htmlParts
    .join('')
    .replace(linkTokenPattern, (_m, i) => links[Number(i)])
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
      name: 'github_search_code',
      description: 'Search the code inside one repository for a word or phrase and get back the matching files and lines. Use it to find where something is defined or used before reading whole files -- much cheaper than listing directories and guessing. GitHub indexes the default branch.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name".' },
          query: { type: 'string', description: 'The text to find, e.g. "handleSendMessage" or "TODO(perf)".' },
          account: { type: 'string', description: 'Which connected GitHub account to act as. Only needed when the repo is not owned by one of them, e.g. an organisation repo; github_list_repos reports the right value.' },
        },
        required: ['repo', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_commits',
      description: 'List the most recent commits on a repository (or on one file). Use it to see what changed lately and who changed it, which is often the fastest way to find the code responsible for a bug.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name".' },
          path: { type: 'string', description: 'Only commits that touched this path, e.g. "src/index.js". Omit for the whole repository.' },
          account: { type: 'string', description: 'Which connected GitHub account to act as. Only needed when the repo is not owned by one of them, e.g. an organisation repo.' },
        },
        required: ['repo'],
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
          branch: { type: 'string', description: 'Branch to commit to. Omit for the repository default. github_list_branches says which branches exist.' },
          content: { type: 'string', description: 'The complete new contents of the file.' },
          message: { type: 'string', description: 'Commit message.' },
          account: { type: 'string', description: 'Which connected GitHub account to act as. Only needed when the repo is not owned by one of them, e.g. an organisation repo; github_list_repos reports the right value.' },
        },
        required: ['repo', 'path', 'content', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_delete_file',
      description: 'Delete one file from a repository and commit the deletion. The user is asked to approve it, the same way every commit is.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name".' },
          path: { type: 'string', description: 'Path of the file to delete inside the repo.' },
          branch: { type: 'string', description: 'Branch to delete from. Omit for the repository default.' },
          message: { type: 'string', description: 'Commit message.' },
          account: { type: 'string', description: 'Which connected GitHub account to act as. Only needed when the repo is not owned by one of them, e.g. an organisation repo.' },
        },
        required: ['repo', 'path', 'message'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'github_list_branches',
      description: 'List the branches of a repository and say which one is the default. Read this before writing to a repository you have not written to in this conversation: a repo whose only branch is something like "claude/some-feature" answers 404 for every read that assumes "main".',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name".' },
          account: { type: 'string', description: 'Which connected GitHub account to act as. Only needed when the repo is not owned by one of them, e.g. an organisation repo.' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_create_branch',
      description: 'Create a branch in a repository, from another branch or from the repository default. Use it rather than telling the user to make the branch themselves. Creating a branch that already exists is reported as such and is not an error. The user is asked to approve it, as with every repository write.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as "owner/name".' },
          branch: { type: 'string', description: 'Name of the branch to create, e.g. "main".' },
          from: { type: 'string', description: 'Branch to start it from. Omit for the repository default.' },
          account: { type: 'string', description: 'Which connected GitHub account to act as. Only needed when the repo is not owned by one of them, e.g. an organisation repo.' },
        },
        required: ['repo', 'branch'],
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

const GITHUB_WRITE_TOOL_NAMES = ['github_commit_file', 'github_delete_file', 'github_create_branch'];

function isGithubTool(name) {
  return GITHUB_TOOL_NAMES.includes(name);
}

// The two that change a repository. Named here rather than at the call sites so
// the mode surface, the commit confirmation and any secret-file guard all agree
// about what a write is.
function isGithubWriteTool(name) {
  return GITHUB_WRITE_TOOL_NAMES.includes(name);
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

// A small scratch space of text files the model can keep notes and drafts in.
// It lives in the browser next to the conversations, not on the server: the
// deployment is shared and its container is rebuilt on every push, so a
// server-side workspace would be both visible to other users and temporary.
// Nothing written here is reachable from another browser.
const WORKSPACE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'workspace_list_files',
      description: 'List the files in the workspace, a scratch space of text files kept in this browser. Call it first to see what is already there.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder to list, e.g. "notes". Empty string or omitted lists every file.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_read_file',
      description: 'Read one text file from the workspace. Read a file before rewriting it, so you keep the parts you are not changing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file, e.g. "notes/todo.md".' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_search_files',
      description: 'Search every file in the workspace for a piece of text. Returns "path: line: text" for each match, so it is how you find where something is written before reading whole files. Plain text, not a regular expression, and case-insensitive.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The text to look for, e.g. "TODO" or "function handleSend".' },
          path: { type: 'string', description: 'Folder to search inside, e.g. "notes". Empty string or omitted searches every file.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_write_file',
      description: 'Write a text file in the workspace, creating it or replacing it whole. The content replaces the whole file, so send the complete new text, not a diff. To change part of a file that already exists, prefer workspace_edit_file. The user is asked to approve every write before it happens.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file, e.g. "notes/todo.md".' },
          content: { type: 'string', description: 'The complete new contents of the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_edit_file',
      description: 'Change part of a workspace file: old_text is replaced by new_text. Read the file first and copy old_text from it exactly. old_text must appear exactly once unless all is true, so an edit can never land somewhere you did not mean. The user is asked to approve every edit before it happens.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file to change, e.g. "notes/todo.md".' },
          old_text: { type: 'string', description: 'The exact text to replace, copied from the file.' },
          new_text: { type: 'string', description: 'What to put in its place. An empty string deletes the old text.' },
          all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_delete_file',
      description: 'Delete a file from the workspace. The user is asked to approve every delete before it happens.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file to delete, e.g. "notes/todo.md".' },
        },
        required: ['path'],
      },
    },
  },
];

const WORKSPACE_TOOL_NAMES = WORKSPACE_TOOLS.map((t) => t.function.name);

// A command that runs on the server, which is the one tool here that can do
// something the user cannot take back. The model's scratch space is
// browser-local, so a script has nowhere to run -- writing and *executing* a file
// needs a real machine, and this is it.
//
// Build mode only: the shell is a write in every sense that matters, and the
// server refuses it outright unless the operator has enabled it (WORKSPACE_RUN in
// server.js), so on a deployment where it was never turned on the model gets one
// plain sentence back rather than a broken tool. Every command is also put to the
// user verbatim before it runs, which is where the real decision is made.
const RUN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command on the server and read its output: write and run a script, generate a file, run tests. It runs in a scratch directory on the server, not on the user\'s computer, and what comes back is stdout, stderr, the exit code, the shell it used and the files now in that directory. Write a script and run it in one command -- on bash a quoted heredoc so nothing is expanded on the way in (cat > make.js <<\'EOF\' ... EOF), then node make.js; the result names the shell, so write for the one you are given. The user is asked to approve every command before it runs.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run, e.g. "node make.js".' },
          cwd: { type: 'string', description: 'Folder inside the workspace to run in. Omit to run at the workspace root.' },
        },
        required: ['command'],
      },
    },
  },
];

const RUN_TOOL_NAMES = RUN_TOOLS.map((t) => t.function.name);

function isRunTool(name) {
  return RUN_TOOL_NAMES.includes(name);
}

// Which of them read and which of them change the store. The split is what the
// mode surface and the parallel-safety rule both key off, so it is one list
// rather than two spellings of the same idea.
const WORKSPACE_WRITE_TOOL_NAMES = ['workspace_write_file', 'workspace_edit_file', 'workspace_delete_file'];

function isWorkspaceTool(name) {
  return WORKSPACE_TOOL_NAMES.includes(name);
}

// A write is never parallel-safe, however it is spelled: two writes to one path
// in the same round is a race whose loser disappears without a trace.
function isWorkspaceWriteTool(name) {
  return WORKSPACE_WRITE_TOOL_NAMES.includes(name);
}

// Caps, so one runaway turn cannot fill the browser's storage. localStorage
// holds a few megabytes for the whole origin and the conversations share it.
const MAX_WORKSPACE_PATH_CHARS = 160;
const MAX_WORKSPACE_FILES = 64;
const MAX_WORKSPACE_FILE_CHARS = 100000;
const MAX_WORKSPACE_TOTAL_CHARS = 200000;

// Paths are relative to the workspace root and can never leave it. A `..` is
// refused rather than resolved away: "notes/../../elsewhere" is a different
// request from "elsewhere", and quietly rewriting it would hide that.
function normalizeWorkspacePath(input) {
  const raw = String(input == null ? '' : input).trim().replace(/\\/g, '/');
  if (!raw || raw.length > MAX_WORKSPACE_PATH_CHARS) return null;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  // Control characters, the null byte among them, are part of no real path.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

function workspaceFileNames(files) {
  const store = files && typeof files === 'object' ? files : {};
  return Object.keys(store).sort();
}

// The immediate children of a folder. Folders are derived from the paths rather
// than stored, so there is no empty-folder state to keep consistent, and a name
// that is both a file and a folder is reported as the folder.
function workspaceList(files, dir = '') {
  const wanted = String(dir == null ? '' : dir).trim();
  const base = wanted ? normalizeWorkspacePath(wanted) : '';
  if (base === null) return { error: 'Invalid folder path.' };
  const prefix = base ? base + '/' : '';
  const names = new Map();
  for (const path of workspaceFileNames(files)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const existing = names.get(rest);
      if (!existing || existing.type === 'file') {
        names.set(rest, { name: rest, path, type: 'file', chars: String(files[path]).length });
      }
    } else {
      const name = rest.slice(0, slash);
      names.set(name, { name, path: prefix + name, type: 'folder' });
    }
  }
  const entries = [...names.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: base, entries, totalFiles: workspaceFileNames(files).length };
}

function workspaceRead(files, path) {
  const target = normalizeWorkspacePath(path);
  if (target === null) return { error: 'Invalid file path.' };
  const store = files && typeof files === 'object' ? files : {};
  if (!Object.prototype.hasOwnProperty.call(store, target)) {
    const all = workspaceFileNames(store);
    return {
      error: 'No file at "' + target + '". ' +
        (all.length ? 'Existing files: ' + all.join(', ') : 'The workspace is empty.'),
    };
  }
  return { path: target, content: String(store[target]) };
}

// Returns a whole new store rather than mutating: the caller decides whether to
// keep it, and a refused write leaves the workspace exactly as it was.
function workspaceWrite(files, path, content) {
  const target = normalizeWorkspacePath(path);
  if (target === null) return { error: 'Invalid file path.' };
  const text = typeof content === 'string' ? content : content == null ? '' : String(content);
  if (text.length > MAX_WORKSPACE_FILE_CHARS) {
    return { error: 'That file is ' + text.length + ' characters; the limit is ' + MAX_WORKSPACE_FILE_CHARS + '.' };
  }
  const store = Object.assign({}, files && typeof files === 'object' ? files : {});
  const created = !Object.prototype.hasOwnProperty.call(store, target);
  if (created && workspaceFileNames(store).length >= MAX_WORKSPACE_FILES) {
    return { error: 'The workspace already holds ' + MAX_WORKSPACE_FILES + ' files. Delete one before adding another.' };
  }
  store[target] = text;
  const names = workspaceFileNames(store);
  const total = names.reduce((sum, name) => sum + String(store[name]).length, 0);
  if (total > MAX_WORKSPACE_TOTAL_CHARS) {
    return { error: 'That would put the workspace at ' + total + ' characters; the limit is ' + MAX_WORKSPACE_TOTAL_CHARS + '.' };
  }
  return { files: store, path: target, chars: text.length, created, totalFiles: names.length };
}

// A delete hands back a new store, like a write: the caller decides whether to
// keep it, and a refused delete leaves the workspace exactly as it was.
function workspaceDelete(files, path) {
  const target = normalizeWorkspacePath(path);
  if (target === null) return { error: 'Invalid file path.' };
  const store = files && typeof files === 'object' ? files : {};
  if (!Object.prototype.hasOwnProperty.call(store, target)) {
    const names = workspaceFileNames(store);
    return {
      error: 'No file at "' + target + '".' + (names.length ? ' Existing files: ' + names.join(', ') : ' The workspace is empty.'),
    };
  }
  const next = Object.assign({}, store);
  delete next[target];
  return { files: next, path: target, totalFiles: workspaceFileNames(next).length };
}

// Change part of a file, with the match count checked before anything moves.
//
// An edit that cannot see its own target must not guess: a model that guessed
// would write the change into the first place that looked close, which is worse
// than a failed call because it looks like success. So a missing old_text, or
// one that appears more than once without `all`, is refused with the count.
function workspaceEdit(files, path, oldText, newText, all) {
  const target = normalizeWorkspacePath(path);
  if (target === null) return { error: 'Invalid file path.' };
  const store = files && typeof files === 'object' ? files : {};
  if (!Object.prototype.hasOwnProperty.call(store, target)) {
    const names = workspaceFileNames(store);
    return {
      error: 'No file at "' + target + '".' + (names.length ? ' Existing files: ' + names.join(', ') : ' The workspace is empty.'),
    };
  }
  const from = typeof oldText === 'string' ? oldText : '';
  if (!from) return { error: 'old_text is required, and must be text copied from the file.' };
  const to = typeof newText === 'string' ? newText : newText == null ? '' : String(newText);
  const content = String(store[target]);
  let count = 0;
  for (let i = content.indexOf(from); i !== -1; i = content.indexOf(from, i + from.length)) count += 1;
  if (!count) {
    return { error: 'old_text does not appear in "' + target + '". Read the file and copy the text exactly, whitespace included.' };
  }
  if (count > 1 && all !== true) {
    return {
      error: 'old_text appears ' + count + ' times in "' + target + '". Include more surrounding text to make it unique, or pass all: true to replace every occurrence.',
    };
  }
  const next = Object.assign({}, store);
  next[target] = all === true ? content.split(from).join(to) : content.replace(from, to);
  const written = next[target];
  if (written.length > MAX_WORKSPACE_FILE_CHARS) {
    return { error: 'That edit would make the file ' + written.length + ' characters; the limit is ' + MAX_WORKSPACE_FILE_CHARS + '.' };
  }
  const total = workspaceFileNames(next).reduce((sum, name) => sum + String(next[name]).length, 0);
  if (total > MAX_WORKSPACE_TOTAL_CHARS) {
    return { error: 'That would put the workspace at ' + total + ' characters; the limit is ' + MAX_WORKSPACE_TOTAL_CHARS + '.' };
  }
  return {
    files: next,
    path: target,
    replaced: all === true ? count : 1,
    occurrences: count,
    totalFiles: workspaceFileNames(next).length,
  };
}

// Find text across the workspace without reading every file into the prompt.
// The line number is what makes a result usable: a match with no position is a
// note that something is in there somewhere, which costs a read to act on.
const MAX_WORKSPACE_SEARCH_MATCHES = 60;
const MAX_WORKSPACE_SEARCH_LINE_CHARS = 200;

function workspaceSearch(files, query, dir) {
  const needle = String(query == null ? '' : query);
  if (!needle.trim()) return { error: 'query is required.' };
  const wanted = String(dir == null ? '' : dir).trim();
  const base = wanted ? normalizeWorkspacePath(wanted) : '';
  if (base === null) return { error: 'Invalid folder path.' };
  const prefix = base ? base + '/' : '';
  // Case-insensitive on purpose, and stated in the tool description: a search
  // that misses on capitalisation is the one that makes an agent read more files
  // than it needed to, while an edit stays exact.
  const low = needle.toLowerCase();
  const store = files && typeof files === 'object' ? files : {};
  const matches = [];
  let truncated = false;
  for (const path of workspaceFileNames(store)) {
    if (!path.startsWith(prefix)) continue;
    const lines = String(store[path]).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].toLowerCase().includes(low)) continue;
      if (matches.length >= MAX_WORKSPACE_SEARCH_MATCHES) { truncated = true; break; }
      matches.push({ path, line: i + 1, text: lines[i].trim().slice(0, MAX_WORKSPACE_SEARCH_LINE_CHARS) });
    }
    if (truncated) break;
  }
  return { matches, truncated, root: base };
}

// A small task list the model keeps between turns, so work that spans several
// conversations does not have to be re-described each time. It lives in the
// browser beside the workspace, for the same reason: a shared server would show
// one person's plan to everybody else.
const TASK_STATUSES = ['todo', 'doing', 'done', 'blocked'];
const MAX_TASKS = 40;
const MAX_TASK_TITLE_CHARS = 120;
const MAX_TASK_DETAIL_CHARS = 600;

function newTaskGraph() {
  return { nextId: 1, tasks: [] };
}

// Anything read back from storage goes through here first: a shape written by an
// older build, or edited by hand, must not become a task the tools cannot
// reason about. Ids are kept when they are usable so a reference from the model
// still resolves after a reload.
function normalizeTaskGraph(raw) {
  const graph = newTaskGraph();
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) return graph;
  const used = new Set();
  let maxId = 0;
  const kept = [];
  for (const task of raw.tasks.slice(0, MAX_TASKS)) {
    if (!task || typeof task !== 'object') continue;
    const title = String(task.title || '').trim().slice(0, MAX_TASK_TITLE_CHARS);
    if (!title) continue;
    let id = '';
    if (typeof task.id === 'string' && /^t[1-9]\d*$/.test(task.id) && !used.has(task.id)) {
      id = task.id;
      used.add(id);
      maxId = Math.max(maxId, Number(id.slice(1)));
    }
    kept.push({ source: task, id, title });
  }
  for (const item of kept) {
    if (!item.id) {
      maxId += 1;
      item.id = 't' + maxId;
      used.add(item.id);
    }
  }
  const known = new Set(kept.map((item) => item.id));
  for (const item of kept) {
    graph.tasks.push({
      id: item.id,
      title: item.title,
      detail: String(item.source.detail || '').trim().slice(0, MAX_TASK_DETAIL_CHARS),
      status: TASK_STATUSES.includes(item.source.status) ? item.source.status : 'todo',
      dependsOn: [...new Set((Array.isArray(item.source.dependsOn) ? item.source.dependsOn : []).map(String))]
        .filter((dep) => known.has(dep) && dep !== item.id),
    });
  }
  // A stored nextId is what stops an id being handed out twice after a task was
  // deleted, so it is kept when it is ahead of the ids actually present.
  const storedNext = Number.isInteger(raw.nextId) && raw.nextId > 0 ? raw.nextId : 0;
  graph.nextId = Math.max(maxId + 1, storedNext);
  return graph;
}

function findTask(graph, id) {
  const tasks = graph && Array.isArray(graph.tasks) ? graph.tasks : [];
  return tasks.find((task) => task.id === String(id == null ? '' : id).trim()) || null;
}

function knownTaskIds(graph) {
  const tasks = graph && Array.isArray(graph.tasks) ? graph.tasks : [];
  return tasks.length ? tasks.map((task) => task.id).join(', ') : 'none yet';
}

// A dependency has to name a task that already exists, and ids are handed out in
// order, so a cycle is impossible to express rather than something to detect
// afterwards.
function addTask(graph, input = {}) {
  const current = normalizeTaskGraph(graph);
  const title = String(input.title || '').trim().slice(0, MAX_TASK_TITLE_CHARS);
  if (!title) return { error: 'A task needs a title.' };
  if (current.tasks.length >= MAX_TASKS) {
    return { error: 'The task list already holds ' + MAX_TASKS + ' tasks. Finish or drop one before adding another.' };
  }
  const known = new Set(current.tasks.map((task) => task.id));
  const wanted = Array.isArray(input.dependsOn)
    ? input.dependsOn
    : input.depends_on == null ? [] : [input.depends_on];
  const dependsOn = [...new Set(wanted.map((dep) => String(dep).trim()).filter(Boolean))];
  const unknown = dependsOn.filter((dep) => !known.has(dep));
  if (unknown.length) {
    return { error: 'No such task: ' + unknown.join(', ') + '. Known ids: ' + knownTaskIds(current) + '.' };
  }
  const task = {
    id: 't' + current.nextId,
    title,
    detail: String(input.detail || '').trim().slice(0, MAX_TASK_DETAIL_CHARS),
    status: 'todo',
    dependsOn,
  };
  current.tasks.push(task);
  current.nextId += 1;
  return { graph: current, task };
}

// Finishing something that still waits on unfinished work is refused: that is
// the one status change that can quietly make a plan look complete when it is
// not, and it is cheap to catch here.
function setTaskStatus(graph, id, status) {
  const current = normalizeTaskGraph(graph);
  const task = findTask(current, id);
  const wanted = String(status == null ? '' : status).trim();
  if (!task) {
    return { error: 'No task "' + String(id == null ? '' : id) + '". Known ids: ' + knownTaskIds(current) + '.' };
  }
  if (!TASK_STATUSES.includes(wanted)) {
    return { error: 'Status must be one of: ' + TASK_STATUSES.join(', ') + '.' };
  }
  if (wanted === 'done') {
    const unfinished = task.dependsOn.filter((dep) => (findTask(current, dep) || {}).status !== 'done');
    if (unfinished.length) {
      return { error: 'Cannot finish "' + task.title + '" while it still depends on ' + unfinished.join(', ') + '.' };
    }
  }
  const updated = Object.assign({}, task, { status: wanted });
  current.tasks = current.tasks.map((entry) => (entry.id === task.id ? updated : entry));
  return { graph: current, task: updated };
}

function readyTasks(graph) {
  const current = normalizeTaskGraph(graph);
  // 'blocked' is a deliberate park, so it is not offered as ready even when
  // everything it waits on is finished.
  return current.tasks.filter((task) => task.status === 'todo' || task.status === 'doing')
    .filter((task) => task.dependsOn.every((dep) => (findTask(current, dep) || {}).status === 'done'));
}

function taskGraphLines(graph) {
  const current = normalizeTaskGraph(graph);
  return current.tasks.map((task) => {
    const after = task.dependsOn.length ? ' (after ' + task.dependsOn.join(', ') + ')' : '';
    const detail = task.detail ? ' -- ' + task.detail : '';
    return '- [' + task.status + '] ' + task.id + ' ' + task.title + after + detail;
  });
}

// What the model sees when it asks for the list.
function renderTaskGraphText(graph) {
  const lines = taskGraphLines(graph);
  return lines.length ? lines.join('\n') : 'The task list is empty.';
}

// The same list rides in the system prompt, so a follow-up turn knows what was
// already planned without spending a tool call to find out. Empty graphs add
// nothing at all rather than an empty heading.
function renderTaskGraphPrompt(graph) {
  const lines = taskGraphLines(graph);
  if (!lines.length) return '';
  return [
    'TASK LIST — kept in this browser and carried between chats, so a later turn ' +
      'picks the work up where it stopped. Keep it current with the task tools as ' +
      'work moves: add what the work turns out to need, update each status as it ' +
      'changes, and finish every task before reporting. Never restate the plan in ' +
      'prose instead of the list.',
    ...lines,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Showing the model thinking
// ---------------------------------------------------------------------------
//
// A reasoning model's scratchpad arrives as a token stream and is usually longer
// than the answer. Two views of it, in opposite directions: while it is still
// coming you want the newest line, and afterwards you want only enough to decide
// whether to open it.

// The last thing thought, flattened to a single line. The tail and not the head:
// the first line of a four-thousand-character scratchpad says what it started
// with, while the end says what it is doing now -- which is the only question a
// live view answers.
function reasoningTailLine(text, limit = 180) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (line.length <= limit) return line;
  return '\u2026' + line.slice(-limit);
}

// The one-line summary over a finished scratchpad. Given no start time -- a
// conversation restored from storage on a later day -- it says how much there is
// and nothing about how long it took, rather than inventing a duration.
function describeReasoning(text, { startedAt = 0, now = 0 } = {}) {
  const chars = String(text || '').length;
  const size = chars >= 1000 ? (chars / 1000).toFixed(1) + 'k' : String(chars);
  const seconds = startedAt > 0 && now > 0 ? Math.max(0, (now - startedAt) / 1000) : 0;
  const label = seconds >= 0.5 ? 'Thought for ' + seconds.toFixed(1) + 's' : 'Thought';
  return label + ' · ' + size + ' chars';
}

// ---------------------------------------------------------------------------
// The list as something to work from
// ---------------------------------------------------------------------------
//
// The graph above is the model's memory of a plan. These are the rules the panel
// and the turn contract are built on, kept pure so the panel, the prompt and the
// tests cannot disagree about what "still open" means.

// Display order: what is being worked on, then what is next, then what is
// deliberately parked, then what is finished. Sorting by status rather than by
// id is the difference between a plan and an archive -- the thing you are doing
// right now must not be item nine because it was added last.
const TODO_STATUS_ORDER = ['doing', 'todo', 'blocked', 'done'];

function orderTodos(graph) {
  const current = normalizeTaskGraph(graph);
  const rank = (task) => {
    const at = TODO_STATUS_ORDER.indexOf(task.status);
    return at === -1 ? TODO_STATUS_ORDER.length : at;
  };
  return [...current.tasks].sort((a, b) => (rank(a) - rank(b)) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

function todoProgress(graph) {
  const current = normalizeTaskGraph(graph);
  const count = (status) => current.tasks.filter((task) => task.status === status).length;
  const done = count('done');
  return {
    total: current.tasks.length,
    done,
    doing: count('doing'),
    todo: count('todo'),
    blocked: count('blocked'),
    open: current.tasks.length - done,
  };
}

// The checkbox on a row. One click completes, one click reopens: a person is the
// authority on their own work, so 'doing' and 'blocked' both complete. A
// finished task reopens as 'todo' rather than back into a state the model set,
// which would otherwise leave the row looking mid-flight with nothing running.
function toggleTodoStatus(status) {
  return String(status) === 'done' ? 'todo' : 'done';
}

// The one line above the rows. Empty and silent when there is nothing to say.
function renderTodoSummary(graph) {
  const progress = todoProgress(graph);
  if (!progress.total) return '';
  const parts = [progress.done + ' of ' + progress.total + ' done'];
  if (progress.doing) parts.push(progress.doing + ' in progress');
  if (progress.blocked) parts.push(progress.blocked + ' blocked');
  return parts.join(' · ');
}

// What is still open, as the model reads it. The nudge exists because recording
// a plan and finishing one are different habits: a reply that arrives carrying
// three silent open todos reads as complete when it is not, and the list is the
// only place that gap is visible.
//
// `touched` is what keeps this from being noise. A model that never wrote to the
// list this turn is not working from it, so an old task left open from an
// earlier conversation is not something to interrupt an answer about.
function todoReportNudge(graph, { touched = false } = {}) {
  if (!touched) return '';
  const current = normalizeTaskGraph(graph);
  const open = orderTodos(current).filter((task) => task.status !== 'done');
  if (!open.length) return '';
  return [
    'TODO LIST — ' + open.length + ' of ' + current.tasks.length + ' still open:',
    ...open.map((task) => '- [' + task.status + '] ' + task.id + ' ' + task.title),
    'Finish them, or say plainly in your reply which are still open and why. ' +
      'Do not report the work as complete while they are open.',
  ].join('\n');
}

// The tools the model calls to keep that list up to date.
const TASK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'task_list',
      description: 'List the tasks already recorded for this work, with their status, id and dependencies. Call it before adding or updating anything, so you extend the plan instead of duplicating it.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_add',
      description: 'Record one task in the list that is kept between chats. Add work you have not done yet, not a log of what you just did. A task that has to wait for another names that task\'s id in depends_on.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short description of the work, e.g. "Add retry to the deploy poller".' },
          detail: { type: 'string', description: 'Anything needed to pick this up later: the file, the approach, the decision already made.' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks that must finish first, e.g. ["t1"].' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_update',
      description: 'Move a task to a new status. Mark "done" only when the work is genuinely finished and checked, not when the code has merely been written.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from task_list, e.g. "t2".' },
          status: { type: 'string', enum: TASK_STATUSES, description: 'New status.' },
        },
        required: ['id', 'status'],
      },
    },
  },
];

const TASK_TOOL_NAMES = TASK_TOOLS.map((t) => t.function.name);

function isTaskTool(name) {
  return TASK_TOOL_NAMES.includes(name);
}

// Only the reading one may share a wave: two status changes at once would
// depend on each other's outcome, and one would silently win.
function isTaskWriteTool(name) {
  return name === 'task_add' || name === 'task_update';
}

// Where an image can come from. Our server route fronts a provider with an
// image-capable model and is the everyday backend; Puter is the app's own
// account and draws only when it is asked for by name.
const IMAGE_BACKENDS = ['puter', 'server'];

// Which image models each kind of work is asked of, best first.
//
// Puter documents Sunburst as the one to pick when editing precision matters and
// Flare as the fast everyday *generation* model. The app pinned gpt-image-2 and
// gpt-image-1.5 for both jobs, so every edit was made by a generation-leaning
// model that predates both of those -- the class of mistake that shows up as an
// edit drifting away from its source. The chains keep a second and third choice,
// because a Puter account can be refused one model without losing the rest.
const IMAGE_GENERATE_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5'];
const IMAGE_EDIT_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2'];

function imageModelsFor(kind) {
  return kind === 'edit' ? IMAGE_EDIT_MODELS.slice() : IMAGE_GENERATE_MODELS.slice();
}

// Puter draws at 'low' when nothing asks for better, and nothing did: every
// picture this app has produced was rendered at the bottom quality tier while
// paying the same credits. 'high' is the tier the models are documented to look
// like; the server route asks its upstream for the same thing.
const IMAGE_QUALITY = 'high';

// --- The size a picture was asked for ---
//
// The request used to carry no dimensions at all, which is the whole of "I asked
// for a wide one and got a square": every service drew its own default and the
// user found out in the download. Reading the size out of the prompt fixes that
// without adding a sixth control to a composer that is already crowded, and it
// matches how the request is actually written -- "a 16:9 banner", "1536x1024",
// "a tall phone wallpaper".
//
// One choice, three readings: an OpenAI-shaped images API wants "1536x1024",
// Puter's txt2img wants the ratio as {w, h}, and a Together model wants pixels.
// Nothing downstream re-derives them.
const IMAGE_SIZE_PRESETS = [
  { id: 'square', label: '1:1', width: 1024, height: 1024, ratio: { w: 1, h: 1 } },
  { id: 'landscape', label: '3:2', width: 1536, height: 1024, ratio: { w: 3, h: 2 } },
  { id: 'portrait', label: '2:3', width: 1024, height: 1536, ratio: { w: 2, h: 3 } },
  { id: 'wide', label: '16:9', width: 1536, height: 864, ratio: { w: 16, h: 9 } },
  { id: 'tall', label: '9:16', width: 864, height: 1536, ratio: { w: 9, h: 16 } },
];

// The words that mean a shape, and the shape they mean. `square` is checked
// before the orientation words so "square 16:9-ish crop" does not become a
// widescreen request, and `portrait` on its own is deliberately absent: "a
// portrait of a woman" is a subject, and turning that into a 2:3 frame would be
// the app inventing a layout nobody asked for. "portrait orientation" is the
// phrase that does mean the frame.
const IMAGE_SIZE_WORDS = [
  { id: 'square', words: ['square'] },
  { id: 'wide', words: ['widescreen', 'wide', 'cinematic', '16:9', 'banner', 'youtube thumbnail', 'desktop wallpaper'] },
  { id: 'tall', words: ['9:16', 'reels', 'reel', 'story', 'stories', 'tiktok', 'phone wallpaper', 'mobile wallpaper'] },
  { id: 'landscape', words: ['landscape', 'horizontal', '3:2', 'postcard'] },
  { id: 'portrait', words: ['portrait orientation', 'portrait mode', 'vertical', '2:3', 'poster', 'book cover'] },
];

function imageSizePreset(id) {
  return IMAGE_SIZE_PRESETS.find((preset) => preset.id === id) || null;
}

// A pair of numbers as a label: 1536x1024 is 3:2, and saying so is how a user
// can tell a request that was understood from one that was ignored.
function imageRatioLabel(width, height) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (!w || !h) return '';
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const divisor = gcd(w, h) || 1;
  return w / divisor + ':' + h / divisor;
}

// The size a prompt asks for, or null for "let the service choose". Explicit
// pixels win over an explicit ratio, and both win over a shape word, because
// that is the order of specificity -- "16:9 at 2048x1152" is a 2048x1152 image.
//
// `words: false` is for an edit. "Make the poster blue" is an instruction about a
// picture that already exists, and reshaping it because the sentence happened to
// contain a shape word would crop something the user only asked to recolour. An
// edit still honours dimensions or a ratio that were spelled out: those are a
// request for a shape rather than a passing mention of one.
function imageSizeFromPrompt(promptText, options) {
  const text = String(promptText || '').toLowerCase();
  if (!text) return null;
  const wordsCount = !(options && options.words === false);
  const pixels = /(\d{2,5})\s*[x×]\s*(\d{2,5})/.exec(text);
  if (pixels) {
    const width = Number(pixels[1]);
    const height = Number(pixels[2]);
    // Small numbers are proportions ("3x2 sticker shapes") and enormous ones are
    // not dimensions this app could ask anyone for.
    if (width >= 64 && height >= 64 && width <= 4096 && height <= 4096) {
      return { id: 'exact', label: imageRatioLabel(width, height), width, height, ratio: { w: width, h: height } };
    }
  }
  const ratio = /(?<!\d)(\d{1,2})\s*:\s*(\d{1,2})(?!\d)/.exec(text);
  if (ratio) {
    const w = Number(ratio[1]);
    const h = Number(ratio[2]);
    if (w && h && w <= 32 && h <= 32) {
      // Scaled to something a service will actually draw: a 21:9 request is
      // 1536x658, not 21x9.
      const long = 1536;
      const scale = long / Math.max(w, h);
      return {
        id: 'ratio',
        label: w + ':' + h,
        width: Math.max(64, Math.round(w * scale)),
        height: Math.max(64, Math.round(h * scale)),
        ratio: { w, h },
      };
    }
  }
  if (!wordsCount) return null;
  for (const entry of IMAGE_SIZE_WORDS) {
    for (const word of entry.words) {
      // Word boundaries on both sides, so "wide" does not fire on "widespread"
      // and "story" does not fire on "history".
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i').test(text)) {
        const preset = imageSizePreset(entry.id);
        if (preset) return { ...preset, words: true };
      }
    }
  }
  return null;
}

// What an OpenAI-shaped images endpoint wants in its `size` field, or '' to send
// nothing and let the service do as it likes.
function imageSizeBody(size) {
  if (!size || !size.width || !size.height) return '';
  return Math.round(size.width) + 'x' + Math.round(size.height);
}

// What Puter's txt2img wants. Its `ratio` is documented as {w, h} and is the one
// field every Puter image provider understands, which is why the pixel pair is
// not sent to it: an unrecognised option there is a failed draw.
function imageRatioBody(size) {
  if (!size || !size.ratio) return null;
  return { w: size.ratio.w, h: size.ratio.h };
}

// How far off a shape may be and still count as the shape that was asked for.
// Two percent: providers round a ratio to the grid their model draws on, and
// 1536x1024 against 1530x1020 is the same picture to anyone looking at it.
const SHAPE_TOLERANCE = 0.02;

// Whether the drawing is a different shape from the one that was asked for.
// The one test behind both answers to that question -- saying so, and cutting it
// to the shape -- so the two can never disagree about a picture.
function imageShapeIsOff(size, drawnWidth, drawnHeight) {
  const w = Math.round(Number(drawnWidth) || 0);
  const h = Math.round(Number(drawnHeight) || 0);
  if (!size || !size.width || !size.height || !w || !h) return false;
  const asked = size.width / size.height;
  return Math.abs(asked - w / h) / asked > SHAPE_TOLERANCE;
}

// The sentence for a picture that came back a different shape from the one that
// was asked for. Silence would be the same silence that produced the complaint:
// the user is looking at a square and believes they asked for a square.
//
// `reframed` is the cut that was made, when one was: the sentence then names the
// shape the picture has rather than only the one it arrived as, because the
// second is the answer and the first is the reason.
function describeDrawnSize(size, drawnWidth, drawnHeight, reframed) {
  const w = Math.round(Number(drawnWidth) || 0);
  const h = Math.round(Number(drawnHeight) || 0);
  if (!imageShapeIsOff(size, w, h)) return '';
  const drawn = 'drawn ' + imageRatioLabel(w, h) + ' (' + w + '×' + h + ')';
  const cut = reframed && reframed.width && reframed.height ? reframed : null;
  if (cut) {
    return 'asked for ' + size.label + ' (' + imageSizeBody(size) + '), ' + drawn +
      ' — cut to ' + imageRatioLabel(cut.width, cut.height) + ' (' + cut.width + '×' + cut.height + ')';
  }
  return 'asked for ' + size.label + ' (' + imageSizeBody(size) + '), ' + drawn;
}

// The largest rectangle of the shape that was asked for, taken from the middle
// of the picture that came back. Null when there is nothing worth cutting.
//
// This is where "ask for a size and get it" stops being a measurement and
// becomes an answer. Every service is asked for the shape and not every service
// honours it; the app used to measure the result, say "drawn 1:1" on the status
// line, and hand the square over anyway. A 1024x1024 drawing for a 16:9 request
// already contains a 1024x576 picture, and that picture is the one the request
// described -- so it is cut out rather than reported on.
//
// Nothing is upscaled and nothing is padded, so a service that draws small
// still draws small; it just draws the shape that was asked for. A cut that
// would leave a sliver is refused, because 2000x120 is not a banner.
const MIN_REFRAME_EDGE = 64;

function reframePlan(size, drawnWidth, drawnHeight) {
  const width = Math.round(Number(drawnWidth) || 0);
  const height = Math.round(Number(drawnHeight) || 0);
  if (!imageShapeIsOff(size, width, height)) return null;
  const aspect = size.width / size.height;
  const cut = width >= height * aspect
    ? { width: Math.round(height * aspect), height }
    : { width, height: Math.round(width / aspect) };
  if (cut.width < MIN_REFRAME_EDGE || cut.height < MIN_REFRAME_EDGE) return null;
  return {
    x: Math.round((width - cut.width) / 2),
    y: Math.round((height - cut.height) / 2),
    width: cut.width,
    height: cut.height,
  };
}

// A refusal is the *prompt's* fault -- not the account's, and not that model's.
// Trying the next model, and then the other backend, buys the same answer a
// second time and reads to the user as a hang rather than a decision. Puter
// reports it as errorCode 'moderation_flagged'; the phrasings below catch the
// fronts that report it as plain prose.
function isModerationRefusal(error) {
  const message = String((error && (error.message || error.error || error.errorCode || error)) || '');
  if (!message) return false;
  if (/moderation_flagged/i.test(message)) return true;
  return /content policy|safety (system|filter)|moderation|prohibited|violates? (our|the) (polic|usage)/i.test(message);
}

// What to say when every backend answered the same way: reword it. Naming the
// backends is right for a transport failure and wrong here -- nothing was broken.
const IMAGE_REFUSAL_ADVICE =
  'The image service refused that request under its content policy. Reword the prompt — drop real names, logos and graphic detail — and try again.';

function imageBackendOrder(options) {
  // A destructuring default only covers `undefined`, so null and junk are read
  // here too: "no options" must mean "the route", never a crash or an empty
  // list of backends to try.
  const puterSignedIn = !!(options && options.puterSignedIn);
  const puterChosen = !!(options && options.puterChosen);
  // Puter is opt-in, and it is opt-in because of what it costs. A Puter account
  // has a fixed monthly allowance of credits that does not roll over, and one
  // picture spends a visible slice of it, where the server route spends a free
  // provider key. So an image nobody pointed at Puter goes to the route, and a
  // route that fails says so rather than quietly billing the allowance -- an
  // automatic fallback is exactly how the month's credits disappear into
  // pictures the user never chose to pay for.
  //
  // Being *on* Puter for chat is not that choice either: chat is cheap there and
  // images are not, so the picker deciding the conversation must not also decide
  // to spend credits on every drawing.
  if (!puterSignedIn || !puterChosen) return ['server'];
  // With Puter asked for, one thing still puts the route first: a painted brush
  // mask. Puter's image options have no mask field at all, so the route is the
  // only backend that can express it -- asking Puter first would silently ignore
  // the region the user painted and edit the whole picture instead. The caller
  // falls back to Puter without the mask if the route refuses, and says so.
  return options.serverFirst ? ['server', 'puter'] : ['puter', 'server'];
}

// When every backend fails, the useful thing to report is what was tried and
// what stopped each one. Reporting only the last error meant a provider-only
// setup was told "Puter is not signed in" -- true, and not the reason.
function imageFailureMessage({ puterError = '', serverError = '', puterAvailable = false } = {}, verb = 'generate') {
  const tried = [];
  if (puterError) tried.push('Puter (' + puterError + ')');
  if (serverError) tried.push('the server image route (' + serverError + ')');
  // Puter sitting there unused is the one fact that turns this message into
  // something the user can act on, so it is only offered when it really is a
  // way out: signed in, and not already one of the things that just failed.
  const offer = puterAvailable && !puterError
    ? ' Turn on “Draw with Puter” in the session panel to spend Puter credits on this one instead.'
    : '';
  if (!tried.length) return 'Could not ' + verb + ' an image: no backend was available.' + offer;
  return 'Could not ' + verb + ' an image. Tried ' + tried.join(' and ') + '.' + offer;
}

// Whether a turn needs a Puter account before it can start.
//
// Puter is our own provider and needs one, always. Every other provider goes
// through our server with the operator's key, so whether it needs a Puter
// account depends on who is standing there: a deployment with a login of its
// own has already established that, and enforces it on every API route, so a
// direct provider can be used without one. A deployment with no login has
// established nothing, and there the Puter sign-in is the only thing between an
// anonymous visitor and the operator's keys — so it stays required even for a
// direct provider.
function needsPuterAccount(input) {
  const options = input && typeof input === 'object' ? input : {};
  if (String(options.provider || '') === PUTER_PROVIDER) return true;
  return !options.loginRequired;
}

// Response bodies are JSON until a proxy, edge, or gateway hands back an
// HTML/text error page instead (mid-restart deploys do this routinely).
// Parsing that raw throws SyntaxError, which reads as gibberish to the user,
// so normalize it here into a retryable message at every call site. A parse
// failure is marked so callers can tell it apart from a real error body.
//
// A body that parses into something which is not an object is unusable for the
// same reason, and is worse: `null` is valid JSON, so nothing throws and the
// caller finds out only when it reads a field off it.
const UNREADABLE_BODY =
  'The server answered with something unreadable (often a proxy page while redeploying) — wait a moment and retry.';

function unreadableBody() {
  return { error: UNREADABLE_BODY, parseFailed: true };
}

async function safeJson(res) {
  try {
    const data = await res.json();
    // `null` is valid JSON, so it resolves rather than throwing and the catch
    // below never sees it. The first caller to read a field off it then died
    // with "Cannot read properties of null (reading 'parseFailed')", so a body
    // that is not an object counts as unreadable whatever produced it.
    if (!data || typeof data !== 'object') return unreadableBody();
    return data;
  } catch {
    return unreadableBody();
  }
}

// A failed provider response explains itself in JSON when the request was plain
// and in an SSE frame when it was streaming, and a proxy in the middle can
// answer with neither. Read whichever arrived, because reading only JSON both
// loses the provider's own words and, on a body of `null`, throws where the
// caller expected a string.
function errorDetailFromBody(text) {
  const raw = String(text === null || text === undefined ? '' : text).trim();
  if (!raw) return '';
  const asDetail = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const detail = value.error || value.message || value.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object') {
      const nested = detail.message || detail.code;
      return typeof nested === 'string' ? nested : JSON.stringify(detail);
    }
    return '';
  };
  try {
    const parsed = asDetail(JSON.parse(raw));
    if (parsed) return parsed;
  } catch { /* not plain JSON: an SSE frame, or a proxy page */ }
  for (const line of raw.split('\n')) {
    const frame = line.trim();
    if (!frame.startsWith('data:')) continue;
    const payload = frame.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = asDetail(JSON.parse(payload));
      if (parsed) return parsed;
    } catch { /* keep looking at the other frames */ }
  }
  return '';
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

// Did the model send arguments that are not usable JSON?
//
// parseToolArgs has to swallow a parse failure -- one malformed call must not
// take down a turn -- and swallowing it also hides it: the call runs with {}
// and the result reads as the tool's answer. That is fine for running a tool and
// wrong for deciding whether a step is working, because a model emitting broken
// arguments is a model that cannot do the step. No arguments at all (a
// no-parameter tool such as task_list) is a legitimate call, not a failure.
function toolArgsUnusable(raw) {
  if (raw == null || raw === '') return false;
  if (typeof raw === 'object') return false;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return true;
    // An array parses as an object and is no more usable as named arguments
    // than a number is: every tool reads its arguments by key.
    return Array.isArray(parsed);
  } catch {
    return true;
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
    case 'github_search_code':
      return `Searching ${repo}${as} for "${args.query || '?'}"`;
    case 'github_list_commits':
      return `Listing recent commits in ${repo}${args.path ? ` (${args.path})` : ''}${as}`;
    case 'github_list_branches':
      return `Listing the branches of ${repo}${as}`;
    case 'github_create_branch':
      return `Creating branch "${args.branch || '?'}" in ${repo}${args.from ? ` from ${args.from}` : ''}${as}`;
    case 'github_delete_file': {
      const owner = args.account || String(args.repo || '').split('/')[0];
      const on = args.branch ? ` on ${args.branch}` : '';
      return `Deleting "${args.path || '?'}" from ${repo}${on}${owner ? ` as ${owner}` : ''}`;
    }
    case 'github_commit_file': {
      // A commit dialog must always name the identity it will land under, so
      // fall back to the repo owner -- which is the account the server picks
      // when the model didn't name one.
      const owner = args.account || String(args.repo || '').split('/')[0];
      // The branch belongs in the approval dialog: "commit to main" and
      // "commit to someone's feature branch" are different decisions.
      const on = args.branch ? ` on ${args.branch}` : '';
      return `Committing "${args.path || '?'}" to ${repo}${on}${owner ? ` as ${owner}` : ''}`;
    }
    case 'web_search':
      return `Searching the web for "${args.query || '?'}"`;
    case 'web_fetch':
      return `Reading ${args.url || 'a page'}`;
    case 'workspace_list_files':
      return args.path ? `Listing the workspace folder "${args.path}"` : 'Listing the workspace files';
    case 'workspace_read_file':
      return `Reading "${args.path || '?'}" from the workspace`;
    case 'workspace_write_file':
      return `Writing "${args.path || '?'}" to the workspace`;
    case 'workspace_search_files':
      return `Searching the workspace for "${args.query || '?'}"`;
    case 'workspace_edit_file':
      return `Editing "${args.path || '?'}" in the workspace`;
    case 'workspace_delete_file':
      return `Deleting "${args.path || '?'}" from the workspace`;
    case 'run_command': {
      // Summarised on one line, and not quoted. This string becomes a transcript
      // line and the label beside the typing dots, neither of which has room for
      // a heredoc: the unfurled command pushed the arguments -- the only part
      // that distinguishes two commands -- past the chip's ellipsis. The dialog
      // quotes the command in full, which is the one place it has to be read.
      const flat = String(args.command || '?').replace(/\s+/g, ' ').trim();
      return 'Running on the server: ' + (flat.length > 80 ? flat.slice(0, 79) + '…' : flat);
    }
    case 'task_list':
      return 'Reading the task list';
    case 'task_add':
      return `Adding a task: "${args.title || '?'}"`;
    case 'task_update':
      return `Marking ${args.id || 'a task'} as ${args.status || '?'}`;
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

// How many times one turn may move to a different provider. Bounded because the
// point is to survive one provider going down, not to crawl every service the
// operator ever configured while the user watches.
const MAX_PROVIDER_FAILOVERS = 2;

// The providers a turn may move to, in the order they are worth trying.
//
// The order is the server's, kept as-is: that list is not a ranking, and
// re-sorting it would move a request onto whichever provider sorts first for no
// better reason. What is filtered is the genuinely unusable -- a service that
// serves no chat models at all (speech, search), and anything not configured,
// since a turn moved to a provider with no key can only fail.
function failoverProviderOrder(providers, options = {}) {
  const ids = (Array.isArray(providers) ? providers : [])
    .filter((p) => p && typeof p.id === 'string' && p.id)
    .filter((p) => p.configured === true && (!p.kind || p.kind === 'chat'))
    .map((p) => p.id);
  // Puter goes last, and only when it is actually usable: it is the one provider
  // that needs an account rather than a key, so a turn that moved there because
  // a keyed provider failed would often fail on the sign-in instead. It is still
  // worth reaching when it is the only thing left.
  if (options.puterUsable && !ids.includes(PUTER_PROVIDER)) ids.push(PUTER_PROVIDER);
  return ids;
}

// The first provider in that order which has not been tried this turn and is not
// already known to have refused the whole account. Null when there is nowhere
// left to go -- the caller then reports the original failure rather than a
// fallback that also failed.
function nextFailoverProvider(order, tried = [], blocked = new Set()) {
  const skip = new Set(Array.isArray(tried) ? tried : []);
  const refused = blocked instanceof Set ? blocked : new Set();
  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id !== 'string' || !id) continue;
    if (skip.has(id) || refused.has(id)) continue;
    return id;
  }
  return null;
}

// Whether a failure is worth moving providers for.
//
// A spent allowance, a refused account, a rate limit, an upstream outage or a
// dead socket is a property of *that* provider, and another one has its own
// account and its own capacity. A model that refused the request is a different
// matter: the model walker has already tried its siblings, so moving provider
// would multiply the attempts for a request that is going to fail everywhere.
function isFailoverWorthyFailure(message, statusCode, modelId) {
  const text = String(message || '');
  const status = Number(statusCode) || 0;
  if (!text && !status) return false;
  if (isOutOfCreditsError(text) || isQuotaExhausted(text)) return true;
  if (isAccountLevelFailure(text, modelId)) return true;
  if (status === 429 || status >= 500) return true;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|did not respond within|not reachable/i.test(
    text,
  );
}

// Rewrites a conversation that contains tool calls into one that does not.
//
// Moving a turn to a model that cannot call tools is the one case where the work
// already recorded has to change shape: a provider whose model has no tool
// support rejects a request carrying assistant tool_calls outright, so the calls
// and their results are folded into plain text. The information survives; only
// the envelope does not. Consecutive same-role messages are merged, because a
// run of user turns is itself rejected by some providers.
function flattenToolTurn(messages) {
  const out = [];
  const push = (role, content) => {
    const previous = out[out.length - 1];
    if (previous && previous.role === role) previous.content += '\n\n' + content;
    else out.push({ role, content });
  };
  let issued = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      issued = new Map(
        message.tool_calls.map((call) => {
          const fn = (call && call.function) || {};
          return [call && call.id, describeToolCall(fn.name, parseToolArgs(fn.arguments))];
        }),
      );
      const said = typeof message.content === 'string' ? message.content.trim() : '';
      push('assistant', said || 'Working on it.');
      continue;
    }
    if (message.role === 'tool') {
      const what = issued.get(message.tool_call_id) || 'a tool call';
      const body = String(message.content == null ? '' : message.content);
      push('user', 'Result of ' + what + ':\n' + body);
      continue;
    }
    if (typeof message.role === 'string' && message.role) {
      push(message.role, typeof message.content === 'string' ? message.content : String(message.content == null ? '' : message.content));
    }
  }
  return out;
}

// What a message's Retry button should resend, if it has one at all.
//
// A bot reply's target is the user turn above it, so the saved transcript does
// not need a second copy of the prompt. A notice with no reply under it -- the
// "Kept N completed tool step(s)" line from an interrupted turn -- has to carry
// its own, or the button it shows would have nothing to send.
function retryTargetFor(message, previous) {
  if (!message || typeof message !== 'object') return undefined;
  if (typeof message.retryText === 'string' && message.retryText) return message.retryText;
  if (message.type !== 'bot') return undefined;
  if (!previous || previous.type !== 'user') return undefined;
  return typeof previous.content === 'string' ? previous.content : undefined;
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

// Matching OpenCode's retry layer, a transient provider answer deserves another
// try: quotas (429) and the server-side failures that mean "try again later"
// (5xx), but never a fixed client fault (400/401/402/403/404/422), which
// retrying can only repeat. Status 0 means "no response at all" — a socket
// error or our own deadline — which OpenCode also classifies as retryable.
function isRetryableStatus(status) {
  return status === 0 || status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
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

// Roughly how many tokens a piece of text costs. Four characters to a token is
// an estimate, not a tokenizer -- but it is close enough to decide what *fits*,
// and being 15% wrong changes which one message gets dropped, never whether the
// request works. Shipping a real tokenizer to the browser for a budgeting
// decision would cost more than it saves.
function estimateTokens(value) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value);
  return text ? Math.ceil(text.length / 4) : 0;
}

// What the attachment in the composer costs the next request, in the same
// estimate the history budget is spent in -- which is the point of showing it,
// because the two numbers are read together and an attachment rides in the
// prompt *whole* where the history behind it gets trimmed. The 200KB ceiling is
// about fifty thousand tokens, and no model reads that for free. A picture is
// bytes that no character estimate can speak for, so it has no cost here rather
// than a made-up one. Returns null when there is nothing to show.
function describeAttachmentCost(attachment) {
  const tokens = attachment && attachment.kind === 'text' ? estimateTokens(attachment.content) : 0;
  if (!tokens) return null;
  const shown = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens);
  return {
    label: '~' + shown + ' tokens',
    tokens,
    // Worth noticing rather than wrong: it alone outweighs the entire history
    // this app trims a chat to, and unlike that history it is not trimmed at all.
    heavy: tokens > HISTORY_TOKEN_BUDGET,
  };
}

// How much history is worth sending. The message cap above bounds the *number*
// of turns; this bounds their weight, which is what actually overflows a model's
// window: twelve turns of chat are cheap, twelve turns carrying a pasted file
// are not. Newest first, because the current thread is what the next answer
// depends on -- a rename twenty messages ago is worth less than the file just
// read.
const HISTORY_TOKEN_BUDGET = 24000;

// Keeps the newest turns whose combined weight fits the budget. The newest turn
// always travels however large it is: a request that arrives without it is a
// different question than the one that was asked, and a provider's "context
// length exceeded" is a failed turn rather than a cheaper one.
function budgetChatHistory(turns, budget = HISTORY_TOKEN_BUDGET) {
  const list = Array.isArray(turns) ? turns : [];
  const limit = Number(budget) > 0 ? Number(budget) : HISTORY_TOKEN_BUDGET;
  const kept = [];
  let spent = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const cost = estimateTokens(list[i] && list[i].content);
    if (kept.length && spent + cost > limit) break;
    kept.unshift(list[i]);
    spent += cost;
  }
  return kept;
}

// Rebuilds the exchange as chat turns. System lines are the app narrating
// itself -- tool activity, error notices -- and are left out; feeding them back
// invites the model to comment on them. Trailing user messages are dropped
// because the caller appends the live one itself.
function buildChatHistory(messages, limit = MAX_HISTORY_MESSAGES, budget = HISTORY_TOKEN_BUDGET) {
  const turns = [];
  for (const message of messages || []) {
    if (!message || (message.type !== 'user' && message.type !== 'bot')) continue;
    const text = String(message.content == null ? '' : message.content).trim();
    if (!text) continue;
    turns.push({ role: message.type === 'user' ? 'user' : 'assistant', content: text });
  }
  const recent = budgetChatHistory(turns.slice(-limit), budget);
  // A history that opens on an assistant turn reads as a reply to nothing.
  while (recent.length && recent[0].role === 'assistant') recent.shift();
  return recent;
}

// Compact session mode is deliberately a context policy, not a destructive
// conversation operation. The visible transcript and local history stay intact;
// only the next provider request receives a smaller, recent exchange. Keeping
// this as a named helper makes the token-saving tradeoff inspectable and testable.
const COMPACT_HISTORY_MESSAGES = 6;
const COMPACT_HISTORY_TOKEN_BUDGET = 10000;

function compactChatHistory(messages, budget = COMPACT_HISTORY_TOKEN_BUDGET) {
  return buildChatHistory(messages, COMPACT_HISTORY_MESSAGES, budget);
}

// A tool result that comes back enormous -- a generated bundle, a long page, a

// CSV -- is paid for again on every remaining round of the turn, because each
// round re-sends the conversation. Clipping it once, with the loss stated, tells
// the model there is more without buying the same bytes a dozen times over.
//
// The limit is deliberately generous rather than tight: it has to be generous
// enough that reading an ordinary source file still delivers the whole file, or
// the clip would quietly break the one tool a coding task depends on most. What
// it bounds is the pathological case -- the file nobody meant to open -- not
// normal work.
const MAX_TOOL_RESULT_CHARS = 20000;

function clipToolResult(value, limit = MAX_TOOL_RESULT_CHARS) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value);
  const max = Number(limit) > 0 ? Number(limit) : MAX_TOOL_RESULT_CHARS;
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return (
    text.slice(0, max) +
    '\n\n[... ' + dropped + ' more characters clipped to keep this turn affordable; ' +
    'ask for a narrower range if you need the rest]'
  );
}

// Argument objects are compared by meaning, not by the order the model happened
// to write them in -- otherwise the same call with re-ordered arguments would
// read as new work and be paid for twice.
function canonicalToolArgs(args) {
  if (args == null) return '';
  if (typeof args !== 'object') return String(args);
  if (Array.isArray(args)) return '[' + args.map(canonicalToolArgs).join(',') + ']';
  return (
    '{' +
    Object.keys(args)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalToolArgs(args[key]))
      .join(',') +
    '}'
  );
}

// What identifies one tool call for the purpose of not running it twice. Empty
// when there is no tool name to identify it by, so a malformed call is never
// mistaken for a repeat of an earlier one.
function toolCallKey(name, args) {
  const tool = typeof name === 'string' ? name.trim() : '';
  if (!tool) return '';
  return tool + ':' + canonicalToolArgs(args);
}

// Said to the model when it asks for a call it has already made. The call is not
// re-run -- the answer is already in the conversation -- but the model has to be
// told that, or it reads the repeat as a failure and asks a third time.
const REPEATED_TOOL_CALL_NOTICE =
  'You have already called that tool with those exact arguments in this turn. ' +
  'Its result is in the conversation above and has not changed. Do not call it ' +
  'again: either use what you have, or change the arguments to make progress.';

// How many times one identical call may come back from the memo before the model
// is told plainly that repeating it will not help.
const MAX_REPEATED_TOOL_CALLS = 2;

// Reads a conversation that was stored part-way through its tool loop back into
// the calls it records: every call the model made, paired back to the result
// recorded against it, with the name and arguments that produced it.
//
// This is the other half of resuming. Handing a model its own tool results and
// nothing else makes it ask for the same tools again, because from where it sits
// there is no record that they were paid for -- which costs exactly what never
// having saved the turn would have.
function toolCallRecords(messages, parseArgs = parseToolArgs) {
  const records = [];
  let issued = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    // A batch of calls opens a new set for the results that follow it.
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      issued = message.tool_calls.map((call) => {
        const fn = (call && call.function) || {};
        const args = parseArgs(fn.arguments);
        return { id: call && call.id, name: String(fn.name || ''), args: args, key: toolCallKey(fn.name, args) };
      });
      continue;
    }
    if (message.role !== 'tool' || !message.tool_call_id) continue;
    const match = issued.find((entry) => entry.id === message.tool_call_id);
    if (match && match.key) {
      records.push({
        key: match.key,
        name: match.name,
        args: match.args,
        result: String(message.content == null ? '' : message.content),
      });
    }
  }
  return records;
}

// The same rebuild as the memo below, with the call behind each answer kept.
// Resuming needs both halves: the answers, so the steps already done are not
// bought again, and what each one was *about*, so a write later in the turn can
// forget the answers it made wrong.
function toolMemoFromConversation(messages, parseArgs = parseToolArgs) {
  const memo = new Map();
  for (const record of toolCallRecords(messages, parseArgs)) {
    memo.set(record.key, record.result);
  }
  return memo;
}

// ---------------------------------------------------------------------------
// What a read answered, remembered past the question that paid for it
// ---------------------------------------------------------------------------
//
// A tool loop re-asks the same things between questions as well as inside one:
// the follow-up to an answer about a file opens by reading that file again. The
// question-scoped memo above cannot help there -- it is deliberately empty when
// a new question starts -- so the read is bought a second time for an answer
// the app already has. Worse, by then the history it was read into may have been
// trimmed away for weight, leaving the model no choice but to ask again.
//
// Remembering a read is only safe while the answer is still true, so this
// carries three rules rather than a size:
//
//   * a write forgets what it touched. An answer about a path -- and any listing
//     of a folder that path sits in -- stops being true once something writes
//     there. This is the correctness half: without it, a model that writes a
//     file and reads it back is handed the text from before its own write, and
//     concludes the write failed.
//   * a remembered read expires. Fifteen minutes is long enough for a follow-up
//     question to reuse what the last answer read, and short enough that a file
//     edited since is not quoted as current.
//   * the answer says how old it is, in the result itself. Silently handing back
//     a stale file is how a coding turn goes wrong in a way nothing in the
//     transcript explains, so the model is told and can choose to re-read.

// Which tools may be remembered across questions: only reads of something
// outside the app -- a file, a listing, a page. A write is absent because
// remembering one would let the app claim work it never did in this turn.
const REMEMBERED_READ_TOOLS = new Set([
  'workspace_read_file',
  'workspace_list_files',
  'github_list_repos',
  'github_list_files',
  'github_read_file',
  'web_search',
  'web_fetch',
]);

function isRememberableRead(name) {
  return REMEMBERED_READ_TOOLS.has(String(name || ''));
}

// Which tools change something. Kept separate from "not concurrent-safe": the
// task writers are never run in parallel either, but a task list is not a file
// and nothing remembered has to be forgotten because one was written.
const MUTATING_TOOLS = new Set(['workspace_write_file', 'github_commit_file']);

function isMutatingTool(name) {
  return MUTATING_TOOLS.has(String(name || ''));
}

// What an answer is about, as a place a later write can be compared against:
// "workspace/notes/a.md", "github/owner/name/src/index.js", "workspace" for the
// whole scratch space, and '' for anything not about one place at all (a search,
// an unfamiliar tool).
//
// The family prefixes are load-bearing: a workspace path and a repo path can be
// spelled identically, and a write to one must not be read as a write to the
// other. The bare family is the root, so a write anywhere below it still matches
// by prefix -- which is what makes a folder listing read before a file appeared
// in it get forgotten too.
function memoSubject(name, args) {
  const tool = String(name || '');
  const values = args && typeof args === 'object' ? args : {};
  const path = String(values.path == null ? '' : values.path).replace(/^\/+|\/+$/g, '');
  if (tool.startsWith('workspace_')) return path ? 'workspace/' + path : 'workspace';
  if (tool.startsWith('github_')) {
    // Case-folded: the same repository spelled two ways is the same repository,
    // so a commit under one spelling still forgets a read made under the other.
    const repo = String(values.repo == null ? '' : values.repo).trim().replace(/^\/+|\/+$/g, '').toLowerCase();
    if (!repo) return 'github';
    return 'github/' + repo + (path ? '/' + path : '');
  }
  return '';
}

// Whether a write makes a remembered answer wrong. A write with no place in it
// -- a tool this file has not been taught -- invalidates every placed answer,
// because a thing allowed to change anywhere has to be assumed to have changed
// everywhere. It never invalidates an unplaced answer: writing a file did not
// make a search result stale.
function memoSubjectInvalidatedByWrite(subject, writtenSubject) {
  const read = String(subject == null ? '' : subject).replace(/^\/+|\/+$/g, '');
  const written = String(writtenSubject == null ? '' : writtenSubject).replace(/^\/+|\/+$/g, '');
  if (!written) return read !== '';
  if (!read) return false;
  return read === written || written.startsWith(read + '/');
}

// How long a remembered read may be trusted.
const REMEMBERED_READ_TTL_MS = 15 * 60 * 1000;

function describeRememberedAge(ageMs) {
  const seconds = Math.max(0, Math.round(Number(ageMs) / 1000));
  if (!Number.isFinite(seconds) || seconds < 45) return 'a moment ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
  const hours = Math.round(minutes / 60);
  return hours + (hours === 1 ? ' hour ago' : ' hours ago');
}

// One conversation's remembered reads. A plain object rather than module state,
// so the rules are testable without a browser and the caller decides which
// conversation the memory belongs to -- the memory is only worth having inside
// the conversation whose files it describes.
function createReadMemory({ now = () => Date.now(), ttlMs = REMEMBERED_READ_TTL_MS } = {}) {
  const entries = new Map();

  function recall(key) {
    if (!key) return null;
    const entry = entries.get(key);
    if (!entry) return null;
    const at = Number(now());
    const ageMs = at - entry.at;
    if (!Number.isFinite(ageMs) || ageMs > ttlMs) {
      entries.delete(key);
      return null;
    }
    // The note travels with the answer so the caller cannot forget to say how
    // old it is.
    return { result: entry.result, ageMs: ageMs, note: '[remembered from ' + describeRememberedAge(ageMs) + '] ' };
  }

  function remember(name, args, key, result) {
    if (!key || !isRememberableRead(name)) return false;
    // What it was about is recorded from the arguments themselves, where they
    // are still real values: a call key is a fingerprint, not a description, and
    // reading paths back out of it would guess.
    entries.set(key, { result: result, subject: memoSubject(name, args), at: Number(now()) });
    return true;
  }

  // Forgets what a write may have made wrong, here and in the question memo the
  // caller passes in. Both hold the same read under the same key, and a stale
  // copy left in either would be served back as current.
  //
  // A write is not in here: it is never an entry, so the guard that makes the
  // same commit run once cannot be forgotten by a later write to the same path.
  function forgetWritten(name, args, questionMemo) {
    const written = memoSubject(name, args);
    const doomed = [];
    for (const [key, entry] of entries) {
      if (memoSubjectInvalidatedByWrite(entry && entry.subject, written)) doomed.push(key);
    }
    for (const key of doomed) {
      entries.delete(key);
      if (questionMemo && questionMemo.delete) questionMemo.delete(key);
    }
    return doomed.length;
  }

  // The one entry point for "a call just ran": a read is kept, a write is not
  // remembered and instead forgets what it touched. Both halves of the rule are
  // stated in one place, so no caller can apply half of it and leave the other
  // half out.
  function record(name, args, key, result, questionMemo) {
    if (isMutatingTool(name)) {
      forgetWritten(name, args, questionMemo);
      return false;
    }
    return remember(name, args, key, result);
  }

  return {
    recall,
    remember,
    forgetWritten,
    record,
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

// How much of a stopped turn is already done, in tool steps. Shown to the user
// so a resume reads as carrying on rather than as starting over.
function pendingTurnStepCount(convo) {
  const list = Array.isArray(convo) ? convo : [];
  return list.filter((message) => message && message.role === 'tool').length;
}

// Only a turn that got somewhere is worth keeping. A failure before the first
// tool call left nothing that costs anything to redo.
function hasToolWork(convo) {
  return pendingTurnStepCount(convo) > 0;
}

// Said to the model when a stored turn is picked back up. Without it a model
// looking at its own tool results may simply repeat the calls that produced
// them, which is the cost this exists to avoid.
const RESUME_CONTINUATION_PROMPT =
  'Your previous attempt at this request was interrupted after the tool steps ' +
  'above. Those results are already paid for and are still valid. Continue from ' +
  'where you stopped: do not repeat a step that already has a result, and finish ' +
  'the original request.';

// The store is shared with every saved conversation, so a turn too large to fit
// is not stored at all: resuming is a courtesy, and losing the conversation list
// to it is not.
const MAX_PENDING_TURN_CHARS = 400000;

// A stored turn as JSON, or null when there is nothing worth keeping or no room
// for it. Never half-written: a truncated turn would be replayed as a broken
// request rather than rejected.
function serializePendingTurn(turn, limit = MAX_PENDING_TURN_CHARS) {
  if (!turn || typeof turn.question !== 'string' || !Array.isArray(turn.convo) || !turn.convo.length) {
    return null;
  }
  const max = Number(limit) > 0 ? Number(limit) : MAX_PENDING_TURN_CHARS;
  let json;
  try {
    json = JSON.stringify(turn);
  } catch {
    return null;
  }
  return json.length <= max ? json : null;
}

// The inverse, and deliberately strict: anything that does not look like a turn
// this app wrote is treated as nothing at all rather than trusted into a request.
function parsePendingTurn(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.question !== 'string' || !Array.isArray(parsed.convo) || !parsed.convo.length) {
    return null;
  }
  return {
    question: parsed.question,
    convo: parsed.convo,
    steps: Number(parsed.steps) || 0,
    at: Number(parsed.at) || 0,
  };
}

// How many input tokens the provider served from its prompt cache. Every vendor
// spells it differently -- OpenAI and OpenRouter nest it under the prompt-token
// details, Anthropic and DeepSeek put it at the top level -- and a miss is zero.
function cachedTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const candidates = [
    details.cached_tokens,
    details.cache_read,
    usage.cache_read_input_tokens,
    usage.prompt_cache_hit_tokens,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
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
  'When run_command is available:',
  '- It runs on the server, in a scratch directory of its own. Create a file and run it in one command, with a quoted heredoc: cat > make.js <<\'EOF\' ... EOF. Then node make.js.',
  '- The user approves every command before it runs, so send few, meaningful ones. Do not run a command just to look around.',
  '- Read the output. A non-zero exit code with a stack trace is the useful part; fix the script and run it again rather than explaining the error back.',
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

// Embedding, audio and image models sit in the same catalogue as chat models
// and can only fail on a chat call. One list, because the picker and the router
// must agree about what is even a candidate -- the router asking a text-to-image
// model to digest a tool result is the kind of bug nobody would look for.
const UNUSABLE_CHAT_MODEL_PATTERN =
  /(embed|rerank|whisper|tts|moderation|guard|safety|vision-only|image|dall-e|stable-diffusion|flux|lyria)/i;

// Speech synthesis, which the words above do not catch because these families
// are named after the voice rather than the job: `fish-audio/s2.1-pro-free`
// reads like an ordinary chat id. A gateway catalogue is where this bites --
// a failover picked exactly that model, having been refused by the one before
// it, and asked a text-to-speech endpoint to continue a coding task. Matching
// on "audio" would be the obvious rule and the wrong one: gpt-4o-audio and
// Voxtral answer chat completions perfectly well.
const SPEECH_MODEL_PATTERN =
  /(fish-audio|orpheus|melotts|aura-\d|elevenlabs|eleven-v|playai|kokoro|xtts|parler|speecht5|\bbark-)/i;

function isUsableChatModelId(id) {
  if (typeof id !== 'string' || !id) return false;
  return !UNUSABLE_CHAT_MODEL_PATTERN.test(id) && !SPEECH_MODEL_PATTERN.test(id);
}

// Providers return their whole catalogue -- OpenRouter's runs to hundreds --
// including embedding and audio models that can only fail on a chat call.
// Drop those, then float what the user actually wants to the top: free first,
// then models suited to research and coding.
function usableChatModels(models, limit = 60) {
  const usable = (models || [])
    .filter((m) => m && isUsableChatModelId(m.id) && emitsText(m))
    .map((m) => ({
      id: m.id,
      ownedBy: m.ownedBy || m.owned_by,
      contextLength: m.contextLength,
      supportedParameters: m.supportedParameters,
      free: isFreeModel(m),
      capable: isCapableModelId(m.id),
      tools: supportsTools(m),
      // Rides along because a capability is not a picker label: the picture
      // read-back asks this list for a model that can see, and a catalogue's
      // own answer is the only evidence there is. Dropped here once, and the
      // check could only ever pick a model on Puter, whose list is built in.
      vision: m.vision,
    }));

  const rank = (m) => (m.free ? 0 : 4) + (m.tools ? 0 : 2) + (m.capable ? 0 : 1);
  return usable
    .map((m, index) => ({ m, index }))
    // Keep the provider's own order within a rank, so "newest first" survives.
    .sort((a, b) => rank(a.m) - rank(b.m) || a.index - b.index)
    .map(({ m }) => m)
    .slice(0, limit);
}

// --- Per-step routing ---
//
// A turn with tools is not one call, it is up to a dozen, and every one of them
// re-sends the whole conversation. The user picks the model that should think
// about their request, but the rounds in between only have to read what a tool
// just handed back and choose the next move -- and because each of those rounds
// carries the entire conversation as input, they are the expensive ones. So the
// chosen model plans the turn and writes the reply; a cheaper one digests.
//
// This is a stage router in Switchyard's sense (NVIDIA-NeMo/Switchyard). Their
// benchmark puts the trade in numbers: their stage router reaches 72.7% at
// $68.19 against a 76.0% / $98.06 baseline -- 30.5% cheaper for 3.3 points of
// accuracy. A trade like that belongs behind a switch and on the record, which
// is why routing is one click from off and why the transcript names the model
// each step actually used rather than only the one that was picked.
const ROUTING_MODES = ['off', 'auto'];

// Which part of a turn a call is, from what the loop already knows. Three
// stages, because they differ in what the answer has to be good at:
//   plan   -- the first call of a turn. Nothing has been read yet, so this is
//             the call that decides what the turn is even going to do
//   work   -- a call with tool output in hand: read it, choose the next move
//   answer -- a call with tools withheld, or a retry with nothing new to read.
//             This is the reply the user is waiting for
function callStage({ round = 0, toolsOffered = false, toolResults = 0 } = {}) {
  if (!toolsOffered) return 'answer';
  if (round <= 0) return 'plan';
  if (toolResults > 0) return 'work';
  return 'answer';
}

// Names that read as the small member of a family. This is the *last* tiebreak,
// used only when a provider publishes no prices at all -- which is exactly the
// case for the allowance-backed ones (Nara, NVIDIA, the Antigravity proxy)
// where there is no price to rank on. Antigravity's list holds Claude Opus and a
// Gemini flash against one shared quota, so the name is the only signal that
// exists there. It is a heuristic, and being wrong costs quality rather than
// money, which is why any published price outranks it. Sizes are spelled out
// rather than matched as \d+b: 70b is not the lite member of anything.
const LITE_MODEL_PATTERN =
  /(flash|mini|nano|lite|small|haiku|turbo|instant|0\.5b|1b|1\.5b|2b|3b|4b|7b|8b|9b)\b/i;

function isLiteModelId(id) {
  return LITE_MODEL_PATTERN.test(String(id || ''));
}

// What a step costs, as one number to sort on. Input dominates a round of this
// size -- the conversation goes up, a tool call comes back -- so prompt price is
// weighted 3:1 over completion.
//
// A published price of zero is free by fact. A model with *no* published price
// returns null here rather than 0, which is a deliberate departure from
// isFreeModel: that function gives an unpriced model the benefit of the doubt so
// it stays visible in the picker, and that is right. It is the wrong answer for
// choosing a model automatically -- an unpriced premium model would sort as
// free and get handed every step. Unknown is not cheap.
function routeCost(model) {
  const pricing = (model && model.pricing) || {};
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  const input = Number.isFinite(prompt) ? prompt : 0;
  const output = Number.isFinite(completion) ? completion : 0;
  return input * 3 + output;
}

// How a model ranks for a work step: lower tier first, then lower cost. null
// means there is nothing to rank it on, so it is never chosen automatically.
function routeRank(model) {
  if (!model) return null;
  const cost = routeCost(model);
  if (isFreeModelId(model.id) || cost === 0) return { tier: 0, cost: 0, why: 'free' };
  if (cost !== null) return { tier: 1, cost, why: 'the cheapest price' };
  if (isLiteModelId(model.id)) return { tier: 2, cost: 0, why: 'the small model in this family' };
  return null;
}

// The model a step should run on, or null to leave it on the user's own.
//
// Only a work step moves: the plan decides what the turn does and the answer is
// what the user reads, so both stay on the model they chose. A model that cannot
// take tools is skipped when tools are being sent -- routing a tool round to a
// model that cannot ask for a tool is not a saving, it is a failed turn.
function routeStep({ stage, mode = 'auto', model, models = [], needsTools = false, refused = [] } = {}) {
  if (mode !== 'auto') return null;
  if (stage !== 'work') return null;
  if (!model) return null;
  const skip = new Set((refused || []).map((id) => String(id)));
  const ranked = (models || [])
    .filter((m) => m && isUsableChatModelId(m.id) && !skip.has(String(m.id)) && emitsText(m))
    .filter((m) => (needsTools ? supportsTools(m) && m.tools !== false : true))
    .map((m) => ({ m, rank: routeRank(m) }))
    .filter((row) => row.rank)
    .sort((a, b) =>
      a.rank.tier - b.rank.tier || a.rank.cost - b.rank.cost || String(a.m.id).localeCompare(String(b.m.id)));
  if (!ranked.length) return null;
  const best = ranked[0];
  // The chosen model may already be the cheapest thing here. Re-sending the same
  // step to the same model would report a saving that does not exist.
  const own = ranked.find((row) => String(row.m.id) === String(model));
  if (own && own.rank.tier <= best.rank.tier && own.rank.cost <= best.rank.cost) return null;
  if (String(best.m.id) === String(model)) return null;
  return { model: best.m.id, from: model, why: best.rank.why, free: best.rank.tier === 0 };
}

// The model to run a classifier on, or null to leave it on the user's own.
//
// The image planner reads one message and answers with a few fields: whether the
// turn is a drawing, an edit or a chat, and the prompt to draw. That is a
// classification, not the conversation, and a small model does it about as well
// as a flagship -- so asking the flagship spends the conversation's per-token
// price on a routing decision. On Puter that price is credits from a fixed
// monthly allowance that does not roll over, which is why it earns a rule.
//
// Ranked exactly as a tool step is, so the app has one idea of "cheaper". Two
// differences: a classifier is handed no tools, so a model that cannot take them
// is still fine; and it is not a step of the conversation, so it is not limited
// to the 'work' stage the way routeStep is.
//
// `preferred` breaks ties toward a named model -- the app's own default -- when
// it ranks no worse than the winner. Puter publishes no prices, so several of its
// models tie at "the small one in the family" and an alphabetical winner would be
// whichever old id sorts first rather than the one the app already trusts.
//
// null means nothing here is clearly cheaper than what the user chose, and the
// caller keeps that rather than guessing.
function routeClassifier({ mode = 'auto', model, models = [], preferred = '', refused = [] } = {}) {
  if (mode !== 'auto') return null;
  if (!model) return null;
  const skip = new Set((refused || []).map((id) => String(id)));
  const ranked = (models || [])
    .filter((m) => m && isUsableChatModelId(m.id) && !skip.has(String(m.id)) && emitsText(m))
    .map((m) => ({ m, rank: routeRank(m) }))
    .filter((row) => row.rank)
    .sort((a, b) =>
      a.rank.tier - b.rank.tier || a.rank.cost - b.rank.cost || String(a.m.id).localeCompare(String(b.m.id)));
  if (!ranked.length) return null;
  let best = ranked[0];
  const wanted = ranked.find((row) => String(row.m.id) === String(preferred));
  if (wanted && wanted.rank.tier <= best.rank.tier && wanted.rank.cost <= best.rank.cost) best = wanted;
  // Already on something at least as cheap: moving it would report a saving that
  // does not exist, and would swap the user's model for no reason.
  const own = ranked.find((row) => String(row.m.id) === String(model));
  if (own && own.rank.tier <= best.rank.tier && own.rank.cost <= best.rank.cost) return null;
  if (String(best.m.id) === String(model)) return null;
  return { model: best.m.id, from: model, why: best.rank.why, free: best.rank.tier === 0 };
}

// The four ways a routed step can fail at the job -- all observable, none
// guessed: it refused, it came back with nothing, its tool arguments were not
// usable JSON, or it asked again for something it already had. Any of them means
// the step goes back to the model the user chose rather than ending the turn.
//
// Returns the phrase for the one that applies, or '' for a step that is fine, so
// the wording is decided here rather than invented at three call sites -- and so
// the precedence is a decision in one place: a step that both came back empty
// and repeated itself is reported as empty, because that is what the reader can
// act on.
function routedStepFailure({ errored = false, empty = false, badArguments = false, repeatedCall = false } = {}) {
  if (errored) return 'refused the step';
  if (empty) return 'came back with nothing';
  if (badArguments) return 'sent tool arguments that could not be used';
  if (repeatedCall) return 'asked again for something it already had';
  return '';
}

// One line for the transcript. Routing is invisible in the reply, so a turn that
// was served by two models has to say so where the conversation is -- a toast is
// gone in seconds, and a switch the user never made must not be a secret.
// The wording deliberately does not promise the chosen model writes the reply. A
// work step can be the step that answers -- it is the one holding the tool
// results -- and a note claiming otherwise would be the app describing a turn it
// did not run.
function describeRoute(route) {
  if (!route || !route.model) return '';
  return (
    'Reading tool results goes to ' + route.model + ' (' + route.why + '); ' +
    route.from + ' plans the turn and takes any step back that goes wrong.'
  );
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

// The model menu is anchored to a trigger that sits at the foot of the window,
// so a menu sized for the models in it ran off the bottom of the screen and was
// clipped by the toolbar it hung from -- roughly one row of a long list was
// reachable. These bound the menu to whatever space the trigger actually has.
const MODEL_MENU_MIN_HEIGHT = 180;
const MODEL_MENU_MAX_HEIGHT = 460;
const MODEL_MENU_GAP = 6;
const MODEL_MENU_MARGIN = 8;
const MODEL_MENU_WIDTH = 380;

// The attach menu is three items, so it is narrower and never as tall as the
// model list. It hangs from the paperclip at the start of the controls row,
// which is why it is placed from that trigger's own rect rather than the
// composer's.
const ATTACH_MENU_MIN_HEIGHT = 120;
const ATTACH_MENU_MAX_HEIGHT = 320;
const ATTACH_MENU_WIDTH = 240;

// Where the model menu should go, given the trigger's rect and the viewport.
// Pure geometry, so the clamping can be tested without a browser: the caller
// only applies the numbers.
//
// It opens upward unless there is genuinely more room below, because the trigger
// lives in the composer at the bottom of the screen. `bottom` and `top` are
// alternatives -- the caller uses whichever one is a number.
function placeDropdown(trigger, viewport, overrides = {}) {
  const gap = overrides.gap === undefined ? MODEL_MENU_GAP : overrides.gap;
  const margin = overrides.margin === undefined ? MODEL_MENU_MARGIN : overrides.margin;
  const wantWidth = overrides.width === undefined ? MODEL_MENU_WIDTH : overrides.width;
  const minHeight = overrides.minHeight === undefined ? MODEL_MENU_MIN_HEIGHT : overrides.minHeight;
  const maxHeight = overrides.maxHeight === undefined ? MODEL_MENU_MAX_HEIGHT : overrides.maxHeight;

  const rect = trigger || {};
  const viewWidth = Number(viewport && viewport.width) || 0;
  const viewHeight = Number(viewport && viewport.height) || 0;
  const triggerTop = Number(rect.top) || 0;
  const triggerBottom = Number(rect.bottom) || 0;
  const triggerRight = Number(rect.right) || 0;

  const spaceAbove = Math.max(0, triggerTop - gap - margin);
  const spaceBelow = Math.max(0, viewHeight - triggerBottom - gap - margin);
  // Only open downward when the menu cannot fit above and there is more room
  // below; otherwise a trigger in the middle of a tall window would flip up.
  const openUp = spaceBelow < Math.min(maxHeight, spaceAbove);
  const available = openUp ? spaceAbove : spaceBelow;
  // Never taller than the space it has, even when that is less than the minimum:
  // a short menu on screen beats a tall one running off it.
  const height = Math.min(available, Math.min(maxHeight, Math.max(minHeight, available)));

  const width = Math.max(0, Math.min(wantWidth, viewWidth - margin * 2));
  // Right-aligned to the trigger at first, then pulled back inside the window.
  const left = Math.min(Math.max(margin, triggerRight - width), Math.max(margin, viewWidth - width - margin));

  return {
    openUp,
    left: Math.round(left),
    top: openUp ? null : Math.round(triggerBottom + gap),
    bottom: openUp ? Math.round(viewHeight - triggerTop + gap) : null,
    width: Math.round(width),
    maxHeight: Math.round(height),
  };
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
  // "this model requires a subscription or usage credits" (Ollama Cloud) is a
  // per-model paywall, not an account refusal: it says "this model", which the
  // account-level phrasings never do. Treating it as account-level suspended
  // the whole provider on the strength of one model's price.
  if (/\bthis model\b/i.test(text)) return false;
  // Matched on the concepts rather than a word order: providers phrase this as
  // "payment required", "a payment method is required" and "requires a payment
  // method", and all three mean the same thing.
  return /payment method|payment (is )?required|billing|subscription|upgrade your plan|no active plan|add funds/i.test(text);
}

// A 429 whose body says the allowance is spent is not a rate limit to ride
// out — retrying it re-spends the same wait for the same answer. Ollama Cloud
// words a spent monthly cap as "you have reached your monthly usage limit",
// and the Antigravity proxy as "Quota Exhausted: All accounts failed or are
// exhausted for this model".
function isQuotaExhausted(message) {
  return /monthly usage limit|quota exhausted|all accounts failed or are exhausted/i.test(String(message || ''));
}

// A provider key travels in an HTTP header, so it must be printable ASCII.
// A paste that carried a word processor's em dash (U+2014) or smart quote
// makes undici throw "Cannot convert argument to a ByteString" — a crash that
// says nothing about the key. Name the first offending character instead.
function unsafeHeaderChar(value) {
  const s = String(value || '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return { index: i, char: s[i], code: c };
  }
  return null;
}

// Whether a refusal is about this one model, and so can be routed around by
// answering with a different one.
//
// The status codes are the three providers actually use for it: OpenRouter
// answers 403 for an app-gated model ("…:free is only available on agentic
// harnesses"), NVIDIA answers 404 for an id an account cannot reach, and a
// free key meeting a paid id answers 402.
//
// Deliberately false for 429 and 5xx. Those are transient or provider-wide, and
// retrying them against another model buries a real outage behind a slow crawl
// through the whole list. An account-level refusal is false for the same
// reason: every candidate would fail the same way.
function isModelScopedRefusal(status, message, modelId) {
  if (status !== 402 && status !== 403 && status !== 404) return false;
  return !isAccountLevelFailure(message, modelId);
}

// The bare model ids refused for one provider, recovered from the
// provider-prefixed keys the app stores. nextUsableModel compares ids, so
// handing it the raw set would match nothing and retry the same dead model.
//
// The prefix matters across a provider switch: refusing a model on OpenRouter
// must not hide an id of the same name on NVIDIA.
function refusedModelIds(refusedKeys, providerId) {
  const prefix = String(providerId || '') + ':';
  const keys = refusedKeys instanceof Set || Array.isArray(refusedKeys) ? [...refusedKeys] : [];
  return keys
    .filter((key) => typeof key === 'string' && key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

// How many models one turn may try after a refusal. Enough to route around a
// couple of dead ids; small enough that a provider whose whole list refuses
// reports the failure instead of walking the entire catalogue.
const MAX_MODEL_REFUSAL_RETRIES = 3;

// The id worth trying next, given the models already refused here, or null when
// nothing is left -- which is the caller's signal to stop retrying and report
// the failure instead of looping. Returning the id rather than the model keeps
// the caller's assignment to one line.
function nextUsableModel(models, refusedIds) {
  const list = Array.isArray(models) ? models : [];
  const refused = refusedIds instanceof Set
    ? (id) => refusedIds.has(id)
    : Array.isArray(refusedIds)
      ? (id) => refusedIds.includes(id)
      : () => false;
  const candidate = list.find((m) => m && m.id && !refused(m.id));
  return candidate ? candidate.id : null;
}

// Families are vendor lines inside a provider: picking Sonnet and having the
// app answer with Opus is a different model than the one the user asked for,
// so a refusal should first try another Claude. The heuristic is name-shaped,
// like the rest of this file's ranking: the first path segment, or a known
// family word anywhere in the id.
const MODEL_FAMILIES = ['claude', 'gemini', 'gpt', 'llama', 'qwen', 'deepseek', 'kimi', 'glm', 'mistral', 'minimax', 'nemotron', 'granite', 'gemma', 'phi'];

function modelFamily(id) {
  const s = String(id || '').toLowerCase();
  const seg = s.split('/')[0];
  const named = MODEL_FAMILIES.find((f) => s.includes(f));
  return named || (seg && seg.length > 2 ? seg : null);
}

// The variant line inside a family: claude-sonnet vs claude-opus, gemini-3.1
// vs gemini-3. Answering a Sonnet pick with Opus is what read as the bug, so
// the walker tries the variant first and only widens to the family after.
function modelVariant(id) {
  const s = String(id || '').toLowerCase();
  const family = modelFamily(s);
  if (!family) return null;
  const at = s.indexOf(family);
  const rest = s.slice(at + family.length).replace(/^[^a-z0-9.]+/, '');
  const next = (rest.match(/^[a-z0-9.]+/) || [''])[0];
  return next ? family + '-' + next : family;
}

// Like nextUsableModel, but stays within the refused model's line: same
// variant first (Sonnet -> Sonnet 4.5), then the family (Sonnet -> Opus), and
// only then the old head-of-list choice. Walking straight across families was
// the old behaviour, and it read as a bug: choosing Sonnet on Antigravity and
// getting Opus thinking-high mid-conversation.
function nearestUsableModel(models, refusedIds, fromId) {
  const list = Array.isArray(models) ? models : [];
  const refused = refusedIds instanceof Set
    ? (id) => refusedIds.has(id)
    : Array.isArray(refusedIds)
      ? (id) => refusedIds.includes(id)
      : () => false;
  const usable = list.filter((m) => m && m.id && !refused(m.id) && m.id !== fromId);
  if (!usable.length) return null;
  const variant = modelVariant(fromId);
  if (variant) {
    const sameVariant = usable.find((m) => modelVariant(m.id) === variant);
    if (sameVariant) return sameVariant.id;
  }
  const family = modelFamily(fromId);
  if (family) {
    const sibling = usable.find((m) => modelFamily(m.id) === family);
    if (sibling) return sibling.id;
  }
  return usable[0].id;
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

// Some providers list far more than is worth offering -- hundreds of ids, most
// of them paid or near-duplicate releases, where the useful set is a handful.
// A provider can declare the subset as rules instead of a literal array:
//
//   models: { exact: ['a', 'b'] }                 named ids, in this order
//   models: { newestOf: ['family'] }              only the newest in a family
//   models: { freeOnly: true, newestOf: ['x'] }   free ids, families collapsed
//
// Declaration order is preserved and ids are deduplicated, so a catalogue that
// lists the same id twice cannot put it in the picker twice.
function versionOf(id) {
  const match = String(id).match(/(\d+(?:\.\d+)*)/g);
  if (!match) return [0];
  // The last number in an id is the release: "muse-spark-1.3" is 1.3.
  return match[match.length - 1].split('.').map(Number);
}

function compareVersions(a, b) {
  const left = versionOf(a);
  const right = versionOf(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  // Same version: prefer the plain id over a longer variant, so
  // "muse-spark-1.3" wins over "muse-spark-1.3-contributor-free".
  return String(b).length - String(a).length;
}

function newestInFamily(models, prefix) {
  const family = (models || []).filter((m) => m && String(m.id).startsWith(prefix));
  if (!family.length) return null;
  return family.reduce((best, m) => (compareVersions(m.id, best.id) > 0 ? m : best));
}

// Returns the declared subset, or everything when nothing is declared. Falling
// back to the full list matters: a provider that renames a model shouldn't
// leave the picker empty.
function selectAllowedModels(models, rules) {
  if (!rules || (!rules.exact && !rules.newestOf && !rules.freeOnly && !rules.includeRest)) return models || [];
  // Namespaces within one catalogue that publish a free marker in the id, and
  // where the account can only spend the free ones. A gateway catalogue is
  // mixed by nature: the models it fronts come from many accounts on many
  // tiers, and it publishes no prices, so "is this free?" has no general
  // answer here -- but it has an answer for the namespaces that say so.
  const paid = (m) => (rules.freeOnlyPrefixes || []).some(
    (prefix) => String(m.id).startsWith(prefix) && !isFreeModelId(m.id),
  );
  const chosen = [];
  const seen = new Set();
  const take = (model) => {
    if (model && !seen.has(model.id)) {
      seen.add(model.id);
      chosen.push(model);
    }
  };

  // freeOnly leans on isFreeModelId rather than repeating the naming rules, so
  // "free" has one definition across the app. Families named in newestOf still
  // collapse to their newest member.
  if (rules.freeOnly) {
    const families = rules.newestOf || [];
    (models || [])
      .filter((m) => m && isFreeModelId(m.id))
      .filter((m) => !families.some((prefix) => String(m.id).startsWith(prefix)))
      .forEach(take);
    families.forEach((prefix) => {
      const family = (models || []).filter((m) => m && isFreeModelId(m.id) && String(m.id).startsWith(prefix));
      take(newestInFamily(family, prefix));
    });
  } else {
    (rules.newestOf || []).forEach((prefix) => take(newestInFamily(models, prefix)));
  }

  // exact goes through matchListEntry so an id matches exactly the way it would
  // in a plain array allowlist -- by id, or by label-based token match.
  (rules.exact || []).forEach((wanted) => take((models || []).find((m) => m && matchListEntry(m, wanted))));

  // includeRest turns the list from a gate into an ordering: what is named
  // leads, everything else follows. A gateway is the case for it -- the
  // operator already chose what it fronts, in its own dashboard, so a second
  // allowlist here can only hide their choices, and does: connecting Mistral
  // to OmniRoute added 48 models that a pinned list kept out of the picker
  // entirely. Naming an id that has since been retired simply stops leading
  // rather than removing a model from the list.
  if (rules.includeRest) (models || []).filter((m) => m && !paid(m)).forEach(take);
  return chosen.length ? chosen : models || [];
}

// --- Where the transcript is scrolled, and who is allowed to move it --------
//
// The app used to write chatMessages.scrollTop = scrollHeight from ten places,
// nine of them unconditional -- so a streaming reply dragged the reader back to
// the bottom every 40ms, and there was no way to read anything above it. There
// was also no "am I at the bottom?" state for a scroll-to-bottom control to
// read, which is why one could not exist. The policy lives here as rules so it
// can be tested without a browser: follow the newest output only while the
// reader is already at the bottom -- unless the app is showing them the message
// they just sent, or something they explicitly asked for.

// One short line above the fold still counts as being at the bottom. A
// fractional scrollHeight, a device-pixel rounding error or the tail of the last
// line should not read as the reader having scrolled away.
const TRANSCRIPT_BOTTOM_SLACK_PX = 120;

function transcriptAtBottom(scrollTop, scrollHeight, clientHeight, slack = TRANSCRIPT_BOTTOM_SLACK_PX) {
  const top = Number(scrollTop) || 0;
  const height = Number(scrollHeight) || 0;
  const view = Number(clientHeight) || 0;
  // A transcript shorter than its window cannot be scrolled at all, and is
  // therefore always at the bottom -- otherwise every append would look like a
  // detach and the app would stop following on a one-message conversation.
  if (height <= view) return true;
  const room = Math.max(0, Number(slack) || 0);
  return height - top - view <= room;
}

// The two writes allowed to move the reader against their own scrolling: the
// message they just sent, and something they asked for (tapping the pill,
// opening a saved chat). Everything else -- a streamed chunk, a tool notice, an
// image finishing -- obeys the pin.
const TRANSCRIPT_JUMP_SOURCES = ['own-message', 'user-request'];

function shouldFollowTranscript(source, pinned) {
  if (TRANSCRIPT_JUMP_SOURCES.includes(String(source || ''))) return true;
  return pinned === true;
}

// Which arrivals are worth announcing while the reader is elsewhere. A tool
// line or a reply that landed is news; the typing indicator is a placeholder
// that removes itself, and the reader's own message is what they just did.
const TRANSCRIPT_QUIET_SOURCES = ['own-message', 'indicator', 'user-request'];

function announcesUnread(source) {
  return !TRANSCRIPT_QUIET_SOURCES.includes(String(source || ''));
}

// --- What of a generated image is worth keeping -----------------------------
//
// A generated picture arrives as a data: or blob: URL -- the whole image inside
// the string -- and history kept only http(s) links, so every data URL was
// dropped the moment it was saved. The bubble showed the picture (it was still
// in memory) while the gallery, which reads from saved history, had nothing but
// the "[Generated image: ...]" text. Data URLs are kept now, re-encoded small
// enough to be worth storing; a remote link is kept as it stands, because the
// bytes were never ours and re-encoding it would save nothing.

// --- How often a streamed reply may be re-rendered ---------------------------
//
// Every flush re-renders the whole reply's markdown, so the cost of a flush
// grows with the reply. One fixed interval is therefore always wrong somewhere:
// short replies want a fast one or text arrives in visible clumps, long replies
// want a slow one or every frame pays for markup nobody is reading yet. The
// cadence backs off only where a flush actually costs something, and it is
// bounded at both ends so the feel never degrades into a stutter.
const STREAM_RENDER_MIN_MS = 40;
const STREAM_RENDER_MAX_MS = 200;

function nextStreamCadence(lastRenderMs, current = STREAM_RENDER_MIN_MS) {
  const now = Math.min(
    STREAM_RENDER_MAX_MS,
    Math.max(STREAM_RENDER_MIN_MS, Number(current) || STREAM_RENDER_MIN_MS),
  );
  const took = Number(lastRenderMs) || 0;
  // 16ms is a dropped frame on a 60Hz display: past that, back off.
  if (took > 16) return Math.min(STREAM_RENDER_MAX_MS, Math.round(now * 1.5));
  // Comfortably cheap, so try to get back to smooth.
  if (took < 6) return Math.max(STREAM_RENDER_MIN_MS, Math.round(now * 0.8));
  return now;
}

// What a picture in a response actually is.
//
// The base64 form used to be labelled image/png whatever the bytes were, and
// the services do not agree: the free drawer, Workers AI and Gemini all answer
// JPEG here. The label is not decoration -- an edit sends the picture on as a
// data URL and the server reads the type straight out of it, so a JPEG wearing
// image/png is a source file whose declared type is a lie. Only an image type
// is accepted, and a response that names none stays PNG, which is what an
// OpenAI-shaped images endpoint returns.
function imageMediaType(item) {
  const declared = String((item && (item.media_type || item.mime_type)) || '').trim().toLowerCase();
  return /^image\/[a-z0-9.+-]+$/.test(declared) ? declared : 'image/png';
}

// --- Saving a generated picture ---
//
// The picture the model drew is saved at the size it was drawn, which is the
// whole point of having asked for a size: re-encoding it to a fixed square (or
// to a "reasonable" 1024px) would hand back a different picture from the one on
// screen. So the render is a pass-through at the bitmap's own dimensions, and
// the menu names those dimensions so the size is visible before the save.
const IMAGE_DOWNLOAD_FORMATS = [
  { id: 'png', label: 'PNG', ext: 'png', mime: 'image/png', hint: 'Lossless, best for edits' },
  { id: 'jpg', label: 'JPG', ext: 'jpg', mime: 'image/jpeg', hint: 'Smaller file' },
  { id: 'pdf', label: 'PDF', ext: 'pdf', mime: 'application/pdf', hint: 'One print-ready page' },
];

// 'jpeg' is what most people type and 'jpe' is what Windows used to write; both
// are JPG here, and anything the table does not know is PNG rather than a
// silent failure to save.
function imageDownloadFormat(id) {
  const wanted = String(id || '').toLowerCase();
  const alias = wanted === 'jpeg' || wanted === 'jpe' ? 'jpg' : wanted;
  return IMAGE_DOWNLOAD_FORMATS.find((format) => format.id === alias) || IMAGE_DOWNLOAD_FORMATS[0];
}

// The prompt, reduced to something a file system will accept. Long prompts are
// cut at a word boundary and never trim to nothing: an empty stem would leave a
// file called "-.png".
function imageDownloadStem(promptText) {
  const slug = String(promptText || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'image';
}

// The dimensions are in the name on purpose: whether the picture came back at
// the size that was asked for is the first thing a folder listing should answer.
function imageDownloadFilename(promptText, format, width, height) {
  const spec = imageDownloadFormat(format);
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  const size = w > 0 && h > 0 ? `-${w}x${h}` : '';
  return `freeai4u-${imageDownloadStem(promptText)}${size}.${spec.ext}`;
}

// The page is the picture.
//
// It used to be A4, whichever way up suited the drawing, with a 24pt margin --
// which is what "the PDF has a white blank page around my image" was: the
// picture the user asked for, printed as a stamp in the middle of a sheet they
// did not ask for. One point per pixel makes the page exactly the picture, so a
// reader shows it edge to edge and a printer scales the whole frame onto paper.
// Only the page's size changes: the JPEG still goes in untouched.
const PDF_MAX_PAGE_PT = 2400;

function pdfPageFor(imageWidth, imageHeight) {
  const pixels = {
    width: Math.max(1, Math.round(Number(imageWidth) || 0)),
    height: Math.max(1, Math.round(Number(imageHeight) || 0)),
  };
  // A very large drawing gets a proportionally smaller page rather than a
  // 4000pt sheet: the page still holds nothing but the picture, which is the
  // promise; only its scale changes.
  const scale = Math.min(1, PDF_MAX_PAGE_PT / Math.max(pixels.width, pixels.height));
  const width = pixels.width * scale;
  const height = pixels.height * scale;
  return {
    pixels,
    width,
    height,
    imageWidth: width,
    imageHeight: height,
    x: 0,
    y: 0,
  };
}

// A one-page PDF holding the picture.
//
// Written by hand rather than pulled in as a dependency: the whole document is
// five objects, and the JPEG goes in untouched as a /DCTDecode stream, so the
// bytes that were drawn are the bytes that print. The caller supplies a JPEG
// because that is what the canvas gives back, and re-encoding it here would be
// a second lossy pass over an image that has already had one.
//
// The xref offsets are the part that has to be right rather than approximately
// right: a reader repairs a bad table or refuses the file, so every object
// records the byte length it was written at and the table is built from those.
// A PDF's text sections are bytes, not characters, and everything written here
// is Latin-1 -- so one character is one byte, which is the assumption /Length
// and every xref offset is computed from. TextEncoder would encode UTF-8 and
// quietly make a non-ASCII character three bytes long, moving every offset in
// the file without changing the table that describes them.
function pdfBytes(text) {
  const source = String(text);
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) out[i] = source.charCodeAt(i) & 0xff;
  return out;
}

function buildImagePdf(jpegBytes, imageWidth, imageHeight) {
  const jpeg = jpegBytes instanceof Uint8Array ? jpegBytes : new Uint8Array(jpegBytes || []);
  const page = pdfPageFor(imageWidth, imageHeight);
  const num = (value) => {
    const rounded = Math.round(Number(value) * 100) / 100;
    return Number.isFinite(rounded) ? String(rounded) : '0';
  };
  const chunks = [];
  let length = 0;
  const push = (value) => {
    const bytes = typeof value === 'string' ? pdfBytes(value) : value;
    chunks.push(bytes);
    length += bytes.length;
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets = [];
  const begin = (n) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
  };

  begin(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  begin(3);
  push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`);
  const content = `q\n${num(page.imageWidth)} 0 0 ${num(page.imageHeight)} ${num(page.x)} ${num(page.y)} cm\n/Im0 Do\nQ\n`;
  begin(4);
  push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  begin(5);
  push(`<< /Type /XObject /Subtype /Image /Width ${page.pixels.width} /Height ${page.pixels.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');

  const startxref = length;
  let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TRANSCRIPT_BOTTOM_SLACK_PX,
    transcriptAtBottom,
    TRANSCRIPT_JUMP_SOURCES,
    shouldFollowTranscript,
    TRANSCRIPT_QUIET_SOURCES,
    announcesUnread,
    STREAM_RENDER_MIN_MS,
    STREAM_RENDER_MAX_MS,
    nextStreamCadence,
    IMAGE_DOWNLOAD_FORMATS,
    imageDownloadFormat,
    imageDownloadStem,
    imageDownloadFilename,
    PDF_MAX_PAGE_PT,
    pdfPageFor,
    pdfBytes,
    buildImagePdf,
    MODES,
    DEFAULT_MODE,
    isValidMode,
    modePrompt,
    TOOL_GROUPS,
    MODE_TOOL_GROUPS,
    WRITE_TOOL_GROUPS,
    toolGroupsForName,
    modeAllowsTool,
    toolsForMode,
    modeBlocksWrite,
    modeWriteRefusal,
    SKILL_SOURCES,
    BUILD_CORE_SKILLS,
    skillEntriesFromTree,
    MAX_ACTIVE_SKILLS,
    activateSkill,
    deactivateSkill,
    pinnedSkills,
    skillsForTurn,
    SKILL_HABIT_CHATS,
    SUGGEST_MIN_SCORE,
    MAX_TRACKED_SKILLS,
    normalizeSkillUsage,
    recordSkillPin,
    learnedSkillNames,
    suggestSkillFor,
    CHAT_COMMANDS,
    resolveChatCommand,
    MAX_SKILL_CHAIN,
    renderCommandsHelp,
    renderSkillsCommandReply,
    MIN_SKILL_HITS,
    MIN_SKILL_TOKEN,
    skillDescriptionWeight,
    skillHitCount,
    skillNamesMatchesRequest,
    skillsAllowedForMode,
    skillTriggerScore,
    skillTokens,
    stemSkillToken,
    pickSkills,
    renderSkillsPrompt,
    SKILL_COMMAND_ALLOWLIST,
    extractWorkspaceState,
    filterToolsBySkills,
    USE_SKILL_TOOL,
    isUseSkillTool,
    parseSkillFrontmatter,
    MODELS,
    DEFAULT_MODEL,
    isValidModel,
    escapeHtml,
    renderMarkdownLite,
    detectsImageIntent,
    detectsImageEditIntent,
    imageAction,
    VISION_MODEL_IDS,
    DEFAULT_VISION_MODEL,
    isVisionCapable,
    GITHUB_TOOLS,
    GITHUB_WRITE_TOOL_NAMES,
    isGithubWriteTool,
    GITHUB_TOOL_NAMES,
    WEB_TOOLS,
    WEB_TOOL_NAMES,
    MAX_TOOL_ROUNDS,
    TOOL_ROUNDS_EXHAUSTED_PROMPT,
    EMPTY_REPLY_NUDGE,
    isGithubTool,
    isWebTool,
    PUTER_PROVIDER,
    needsPuterAccount,
    IMAGE_BACKENDS,
    imageBackendOrder,
    imageFailureMessage,
    IMAGE_PLANNER_PROMPT,
    IMAGE_PLAN_ACTIONS,
    IMAGE_CHECK_PROMPT,
    MAX_IMAGE_CHECK_CHARS,
    imageCheckFixPrompt,
    imageCheckQuestion,
    parseImageCheck,
    MAX_IMAGE_PROMPT_CHARS,
    parseImagePlan,
    resolveImageAction,
    lastImageInMessages,
    IMAGE_GENERATE_MODELS,
    IMAGE_EDIT_MODELS,
    imageModelsFor,
    IMAGE_QUALITY,
    IMAGE_SIZE_PRESETS,
    imageSizePreset,
    imageSizeFromPrompt,
    imageSizeBody,
    imageRatioBody,
    imageRatioLabel,
    describeDrawnSize,
    reframePlan,
    MIN_REFRAME_EDGE,
    isModerationRefusal,
    IMAGE_REFUSAL_ADVICE,
    WORKSPACE_TOOLS,
    WORKSPACE_WRITE_TOOL_NAMES,
    workspaceDelete,
    workspaceEdit,
    workspaceSearch,
    MAX_WORKSPACE_SEARCH_MATCHES,
    WORKSPACE_TOOL_NAMES,
    isWorkspaceTool,
    isWorkspaceWriteTool,
    RUN_TOOLS,
    RUN_TOOL_NAMES,
    isRunTool,
    normalizeWorkspacePath,
    workspaceList,
    workspaceRead,
    workspaceWrite,
    TASK_TOOLS,
    TASK_TOOL_NAMES,
    TASK_STATUSES,
    TODO_STATUS_ORDER,
    describeReasoning,
    reasoningTailLine,
    orderTodos,
    todoProgress,
    todoReportNudge,
    toggleTodoStatus,
    renderTodoSummary,
    isTaskTool,
    isTaskWriteTool,
    newTaskGraph,
    normalizeTaskGraph,
    findTask,
    addTask,
    setTaskStatus,
    readyTasks,
    renderTaskGraphText,
    renderTaskGraphPrompt,
    MAX_TASKS,
    MAX_TASK_TITLE_CHARS,
    MAX_TASK_DETAIL_CHARS,
    MAX_WORKSPACE_PATH_CHARS,
    MAX_WORKSPACE_FILES,
    MAX_WORKSPACE_FILE_CHARS,
    MAX_WORKSPACE_TOTAL_CHARS,
    safeJson,
    errorDetailFromBody,
    CONCURRENT_SAFE_TOOLS,
    MAX_CONCURRENT_TOOLS,
    isConcurrentSafeTool,
    planToolCalls,
    batchIndices,
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
    isRetryableStatus,
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
    conversationToMarkdown,
    MAX_HISTORY_MESSAGES,
    buildChatHistory,
    COMPACT_HISTORY_MESSAGES,
    COMPACT_HISTORY_TOKEN_BUDGET,
    compactChatHistory,
    SYSTEM_PROMPT,
    PUTER_PROVIDER,
    normalizeProviderReply,
    explainEmptyReply,
    isAccountLevelFailure,
    isModelScopedRefusal,
    isQuotaExhausted,
    unsafeHeaderChar,
    refusedModelIds,
    MAX_MODEL_REFUSAL_RETRIES,
    nextUsableModel,
    modelFamily,
    nearestUsableModel,
    usableChatModels,
    isUsableChatModelId,
    isFreeModelId,
    isFreeModel,
    supportsTools,
    emitsText,
    isCapableModelId,
    ROUTING_MODES,
    callStage,
    toolArgsUnusable,
    isLiteModelId,
    routeCost,
    routeRank,
    routeStep,
    routeClassifier,
    routedStepFailure,
    describeRoute,
    describeProviderModel,
    placeDropdown,
    MODEL_MENU_MAX_HEIGHT,
    ATTACH_MENU_MIN_HEIGHT,
    ATTACH_MENU_MAX_HEIGHT,
    ATTACH_MENU_WIDTH,
    newConversation,
    sortConversations,
    upsertConversation,
    migrateLegacyMessages,
    parseSseChunk,
    selectAllowedModels,
    newestInFamily,
    compareVersions,
    estimateTokens,
    HISTORY_TOKEN_BUDGET,
    describeAttachmentCost,
    budgetChatHistory,
    MAX_TOOL_RESULT_CHARS,
    clipToolResult,
    toolCallKey,
    REPEATED_TOOL_CALL_NOTICE,
    MAX_REPEATED_TOOL_CALLS,
    cachedTokensFromUsage,
    toolMemoFromConversation,
    isRememberableRead,
    isMutatingTool,
    memoSubject,
    memoSubjectInvalidatedByWrite,
    describeRememberedAge,
    toolCallRecords,
    createReadMemory,
    REMEMBERED_READ_TTL_MS,
    pendingTurnStepCount,
    hasToolWork,
    RESUME_CONTINUATION_PROMPT,
    MAX_PENDING_TURN_CHARS,
    serializePendingTurn,
    parsePendingTurn,
    retryTargetFor,
    imageMediaType,
    MAX_PROVIDER_FAILOVERS,
    failoverProviderOrder,
    nextFailoverProvider,
    isFailoverWorthyFailure,
    flattenToolTurn,
  };
}
