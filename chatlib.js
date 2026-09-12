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
    'Record the plan you propose as tasks with the task tools, so Build mode can pick it up rather than re-deriving it.',
  ].join('\n'),
  build: [
    'MODE: BUILD. You are executing agreed work. Be disciplined about it:',
    '- Prefer the smallest change that fully solves the request; reuse what the repo already has.',
    '- For behavior changes, write or adjust a test first when the repo has tests to attach to.',
    '- Verify before claiming done: run what the repo offers (tests, build, lint) and report actual results.',
    // The todo list is the plan of record. Kept in the mode prompt rather than
    // added to each request, because this text never changes between turns and a
    // request that grows on every turn cannot be cached (#89).
    '- Work from the todo list: record the plan as tasks before a multi-step job, update each status as it moves, and when the request changes revise the list -- add what is new, drop what is no longer wanted -- rather than starting a second plan beside it.',
    '- Finish every todo before you report. If one is genuinely still open, name it and say why; never report the work as complete while the list says otherwise.',
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

// Renders picked skills as extra system context. Bounded excerpts: the
// overview carries the method; the model can ask for the full text via
// use_skill if it needs the detailed sections.
//
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
];

// What a line typed into the composer means:
//   { kind: 'command', name, args }   a known command
//   { kind: 'skill', name }           /ponytail, when no command is named that
//   null                              plain text, sent to the model as usual
//
// Returning null for anything unrecognised is the important half: a message that
// merely starts with a slash -- a path, a date, a shrug -- is a message, and an
// app that swallowed it would be worse than a typo it never claimed to fix.
function resolveChatCommand(text, skillNames) {
  const line = String(text == null ? '' : text).trim();
  const match = /^\/([a-z][a-z0-9-]*)\s*([\s\S]*)$/i.exec(line);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const args = match[2].trim();
  if (CHAT_COMMANDS.some((c) => c.name === name)) return { kind: 'command', name, args };
  const known = (Array.isArray(skillNames) ? skillNames : []).map((n) => String(n).toLowerCase());
  if (known.includes(name)) return { kind: 'skill', name };
  return null;
}

function renderCommandsHelp() {
  return [
    'Commands',
    ...CHAT_COMMANDS.map((c) => '`' + c.usage + '` — ' + c.desc),
    '',
    'Or type `/` and a skill name — `/ponytail`, `/caveman`, `/humanizer` — to use it for the rest of this chat.',
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
  'use_skill',
  // Workspace reads only. A write is absent on purpose, so it keeps running on
  // its own and cannot interleave with another call. The task writers are
  // absent for the same reason.
  'workspace_list_files',
  'workspace_read_file',
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

// The browser re-encodes an attached image before it is sent, because the chat
// endpoint refuses bodies over 1MB while the attach menu allows images up to
// 8MB. The cap sits below the server's with room for the prompt and history
// still to fit, and the edge is what vision models are usually fed anyway.
const MAX_IMAGE_DATA_URL_CHARS = 700000;
const MAX_IMAGE_EDGE = 1600;

// Whether a model is *known* to read images. Absent is not the same as capable:
// the request would only fail, and the failure would read as the model being
// broken rather than the picture being unsupported.
function acceptsImages(model) {
  return !!(model && model.vision === true);
}

// The model that should answer a turn carrying an image, or null when this
// provider has none. A model that can already see is never swapped away from.
function modelForImage(models, preferredId) {
  const list = Array.isArray(models) ? models.filter((m) => m && m.id) : [];
  if (acceptsImages(list.find((m) => m.id === preferredId))) return preferredId;
  const capable = list.find(acceptsImages);
  return capable ? capable.id : null;
}

// Only an inline image or a plain http(s) link may ride in a request. A
// data:text/html or javascript: URL must never reach a provider.
function isSendableImageUrl(url) {
  return /^data:image\//i.test(String(url || '')) || /^https?:\/\//i.test(String(url || ''));
}

// Put an image on the turn as content parts, the shape every OpenAI-compatible
// provider understands. Pure -- neither the array nor its messages are
// touched, because the same conversation is re-sent when a model refuses.
//
// Throws on a URL that could not be sent rather than quietly returning a
// text-only turn: silently dropping the image is the bug this exists to fix.
function withImageTurn(messages, imageUrl, promptText) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  if (!last || last.role !== 'user') return list;
  if (!isSendableImageUrl(imageUrl)) {
    throw new Error('Refusing to send an image URL that is not a data:image or http(s) link');
  }
  // Already multimodal: leave the caller's own content parts alone.
  if (Array.isArray(last.content)) return list;
  const text = String(promptText || last.content || '').trim();
  return [
    ...list.slice(0, -1),
    {
      ...last,
      content: [
        { type: 'text', text: text || 'What is in this image?' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ];
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
      name: 'workspace_write_file',
      description: 'Write a text file in the workspace, creating it or replacing it whole. The content replaces the whole file, so send the complete new text, not a diff. The user is asked to approve every write before it happens.',
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
];

const WORKSPACE_TOOL_NAMES = WORKSPACE_TOOLS.map((t) => t.function.name);

function isWorkspaceTool(name) {
  return WORKSPACE_TOOL_NAMES.includes(name);
}

// A write is never parallel-safe, however it is spelled: two writes to one path
// in the same round is a race whose loser disappears without a trace.
function isWorkspaceWriteTool(name) {
  return name === 'workspace_write_file';
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

// Where an image can come from. Puter is the app's own account and is used
// when it is signed in; our server route fronts a provider with an
// image-capable model, so a setup that never signs in to Puter can still draw
// instead of being told to sign in to something it wasn't using.
const IMAGE_BACKENDS = ['puter', 'server'];

function imageBackendOrder(options) {
  // A destructuring default only covers `undefined`, so null and junk are read
  // here too: "no options" must mean "the route", never a crash or an empty
  // list of backends to try.
  const puterSignedIn = !!(options && options.puterSignedIn);
  // The server route is always behind Puter: Puter is already paid for by the
  // signed-in account, while the route costs an API key that may not be set.
  return puterSignedIn ? ['puter', 'server'] : ['server'];
}

// When every backend fails, the useful thing to report is what was tried and
// what stopped each one. Reporting only the last error meant a provider-only
// setup was told "Puter is not signed in" -- true, and not the reason.
function imageFailureMessage({ puterError = '', serverError = '' } = {}) {
  const tried = [];
  if (puterError) tried.push('Puter (' + puterError + ')');
  if (serverError) tried.push('the server image route (' + serverError + ')');
  if (!tried.length) return 'Could not generate an image: no backend was available.';
  return 'Could not generate an image. Tried ' + tried.join(' and ') + '.';
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
    case 'workspace_list_files':
      return args.path ? `Listing the workspace folder "${args.path}"` : 'Listing the workspace files';
    case 'workspace_read_file':
      return `Reading "${args.path || '?'}" from the workspace`;
    case 'workspace_write_file':
      return `Writing "${args.path || '?'}" to the workspace`;
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

function isUsableChatModelId(id) {
  return typeof id === 'string' && !!id && !UNUSABLE_CHAT_MODEL_PATTERN.test(id);
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
  if (!rules || (!rules.exact && !rules.newestOf && !rules.freeOnly)) return models || [];
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
  return chosen.length ? chosen : models || [];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MODES,
    DEFAULT_MODE,
    isValidMode,
    modePrompt,
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
    MAX_IMAGE_DATA_URL_CHARS,
    MAX_IMAGE_EDGE,
    acceptsImages,
    modelForImage,
    isSendableImageUrl,
    withImageTurn,
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
    PUTER_PROVIDER,
    needsPuterAccount,
    IMAGE_BACKENDS,
    imageBackendOrder,
    imageFailureMessage,
    WORKSPACE_TOOLS,
    WORKSPACE_TOOL_NAMES,
    isWorkspaceTool,
    isWorkspaceWriteTool,
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
    MAX_HISTORY_MESSAGES,
    buildChatHistory,
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
    MAX_PROVIDER_FAILOVERS,
    failoverProviderOrder,
    nextFailoverProvider,
    isFailoverWorthyFailure,
    flattenToolTurn,
  };
}
