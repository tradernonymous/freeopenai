// Shared pure logic used by index.html (browser) and the test suite (Node).
// No DOM/Node APIs here so it can run in either environment unmodified.

// Curated subset of the models Puter.js supports for puter.ai.chat(); see
// https://developer.puter.com/tutorials/free-unlimited-openai-api/#list-of-supported-text-generation-models
// for the full list (several dozen ids across the GPT-5.x/4.1/o-series/Codex lines).
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
const TOOL_ROUNDS_EXHAUSTED_PROMPT =
  'Stop using tools now and answer directly. Summarise what you found, what you ' +
  'changed if anything, and what is still left to do. Be specific about file ' +
  'paths so the next request can pick up from here.';

const GITHUB_TOOL_NAMES = GITHUB_TOOLS.map((t) => t.function.name);

function isGithubTool(name) {
  return GITHUB_TOOL_NAMES.includes(name);
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
  return choice && choice.message ? { message: choice.message, raw: data } : null;
}

// OpenRouter publishes real prices, so cost is a fact rather than a guess at
// the name. Only 21 of its ~430 models are actually free, and the ":free"
// suffix alone was not a reliable signal. Cerebras and NVIDIA return no
// pricing: their free tier is an account-level allowance, so everything they
// list is free within it, which is why a missing price counts as free.
function isFreeModel(model) {
  if (!model) return false;
  const pricing = model.pricing;
  if (pricing && (pricing.prompt !== undefined || pricing.completion !== undefined)) {
    return Number(pricing.prompt || 0) === 0 && Number(pricing.completion || 0) === 0;
  }
  // No published price. Cerebras and NVIDIA are in this position and both meter
  // an account-level allowance rather than charging per model, so everything
  // they list is free within it.
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
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
    MAX_TOOL_ROUNDS,
    TOOL_ROUNDS_EXHAUSTED_PROMPT,
    isGithubTool,
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
  };
}
