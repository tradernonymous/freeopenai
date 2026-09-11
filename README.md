<p align="center">
  <img src="docs/readme/hero.svg" alt="FreeOpenAI. Free access to OpenAI models, no key required." width="100%">
</p>

<p align="center">
  <b>A free, serverless chat UI for OpenAI models — no API key, no backend, no bill in your name.</b><br>
  Sign in once through Puter · pick a model · chat · your Puter account covers the usage.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/Puter.js-v2-6C5CE7?style=for-the-badge" alt="Puter.js v2">
  <img src="https://img.shields.io/badge/tests-196%20passing-22c55e?style=for-the-badge" alt="196 tests passing">
  <img src="https://img.shields.io/badge/API%20keys-none%20needed-f472b6?style=for-the-badge" alt="No API keys">
  <img src="https://img.shields.io/badge/license-MIT-0ea5e9?style=for-the-badge" alt="MIT">
</p>

<p align="center">
  <a href="#quickstart"><img src="https://img.shields.io/badge/🚀%20Quick%20start-run%20it%20locally-0b1030?style=flat-square&labelColor=22d3ee" alt="Quick start"></a>
  &nbsp;
  <a href="#deploy"><img src="https://img.shields.io/badge/☁️%20Deploy-Railway%20in%203%20steps-0b1030?style=flat-square&labelColor=8b5cf6" alt="Deploy"></a>
  &nbsp;
  <a href="#features"><img src="https://img.shields.io/badge/🧠%20How%20it%20works-no%20backend%2C%20no%20keys-0b1030?style=flat-square&labelColor=f472b6" alt="How it works"></a>
</p>

<br>

<a name="contents"></a>

## 🧭 Contents

- ✨ [Features](#features)
- 🧠 [Models](#models)
- ⌨️ [Using the app](#usage)
- 🚀 [Quick start](#quickstart)
- ⚙️ [Configuration](#config)
- ☁️ [Deploy to Railway](#deploy)
- 🏗️ [Architecture](#architecture)
- ⚠️ [Disclaimer](#disclaimer)

<br>

<a name="features"></a>

<img src="docs/readme/banner-features.svg" alt="Features" width="100%">

<br>

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>💬 Chat</h3>
      Ask anything and get a streamed, markdown-rendered reply in a centered 768px column at compact density. Starts on a prompt hero with suggestion cards, copy or retry any response, Ctrl+P palette for models and actions, turn stats (model · seconds · chars) in the status bar, and dark/light plus tokyonight/gruvbox/auto themes in the header.
    </td>
    <td width="33%" valign="top">
      <h3>🔐 Sign in with Puter</h3>
      Google, Telegram, or a Magic Key — no account with this app, no API key, no server-side secret. Your Puter account meters the usage.
    </td>
    <td width="33%" valign="top">
      <h3>🔀 Model switching</h3>
      Swap between the GPT-6 / 5.6 / 4o families, the Codex coding models, and Claude from the header, the Models tab, or Settings. Your pick is remembered next visit.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>📎 Attachments</h3>
      Attach an image, a PDF/DOCX document, or a small text file (<code>.txt .md .csv .json .js .ts .log .yml</code>) and it rides along with your next message.
    </td>
    <td valign="top">
      <h3>⚙️ Settings</h3>
      Default model, sign-in state, and a one-click "clear history" — all local, nothing leaves your browser.
    </td>
    <td valign="top">
      <h3>♿ Accessible by default</h3>
      Keyboard navigation on the model picker, a focus-trapped help dialog, and live-region announcements for new messages.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🖼️ Image generation</h3>
      Toggle the image icon next to the input to generate a picture instead of chatting. A labelled shimmer placeholder holds the spot while it renders (instant failures say so instead of flashing past). Click any result to zoom in, download, copy, edit with a brush mask, or make variations — every image lands in the Gallery view, newest first.
    </td>
    <td valign="top">
      <h3>🧠 Reasoning summaries</h3>
      Reasoning-capable models return their thinking separately. It appears as a collapsed <b>Reasoning</b> strip above the reply — click to show or hide it.
    </td>
    <td valign="top">
      <h3>🔒 Private deployments</h3>
      Set <code>AUTH_USER_1</code> / <code>AUTH_PASS_1</code> and the whole app sits behind a username/password login, so a public Railway URL isn't open to the world.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🐙 GitHub connector</h3>
      Connect up to three GitHub accounts in Settings and the model can browse, read, and commit files in your public repos straight from the chat. Tokens are encrypted into an httpOnly cookie and every write asks first.
    </td>
    <td valign="top">
      <h3>🎚️ Reasoning effort</h3>
      On models that take one, a picker sets how hard to think — <code>none</code> through <code>xhigh</code>. It stays hidden on models that would ignore it.
    </td>
    <td valign="top">
      <h3>📄 PDF in and out</h3>
      Attach a PDF or DOCX and its text rides along with your message. Save any conversation back out as a PDF from the drawer — no library, just the browser's own printer.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🗂️ Saved chats</h3>
      Every conversation is kept in a sidebar, titled by your first message. Reopen, delete, or start a new one without losing the last. Hide the sidebar when you want the room.
    </td>
    <td valign="top">
      <h3>🔌 Four providers</h3>
      Puter needs no key at all. Add a key for Nara, OpenRouter, NVIDIA or Mistral and they appear in a picker — so one running dry never stops the work. Keys stay on the server.
    </td>
    <td valign="top">
      <h3>📱 Built for a phone</h3>
      A slide-out drawer, safe-area insets, 16px inputs so iOS doesn't zoom, a Send key on soft keyboards, no double-tap delay, a layout that resizes with the keyboard instead of hiding behind it, wrapped links, capped image heights, and controls that shrink rather than shove each other off a 375px screen.
    </td>
    <td valign="top">
      <h3>⚡ SSE streaming</h3>
      Direct-provider replies arrive token-by-token via Server-Sent Events — no waiting for the full answer before text appears.
    </td>
    <td valign="top">
      <h3>🛑 Stop / cancel</h3>
      Hit the red stop button or press Escape mid-reply to abort a generation instantly. The upstream fetch is cancelled server-side too.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>⏱️ Model-catalog cache</h3>
      Provider model lists are cached in memory with a configurable TTL, so switching providers or reloading the page doesn't re-fetch the catalogue every time.
    </td>
  </tr>
</table>

<br>

<a name="models"></a>

<img src="docs/readme/banner-models.svg" alt="Models" width="100%">

<br>

This is the curated Puter.js list — no OpenAI account or key required on your end. Add a provider key and its own catalogue is fetched live instead, ranked free-first.

| Model | Description | Id |
| --- | --- | :---: |
| **GPT-6 Astra** | Newest, most capable — complex reasoning, coding, computer use | `gpt-6-astra` |
| **GPT-5.6 Sol** | Flagship of the 5.6 family | `gpt-5.6-sol` |
| **GPT-5.6 Terra** | Mid-tier | `gpt-5.6-terra` |
| **GPT-5.6 Luna** | Smallest, cheapest of the 5.6 family | `gpt-5.6-luna` |
| **GPT-5.4 Nano** | Fast, cheap — the default | `gpt-5.4-nano` |
| **GPT-4o** | Balanced, general-purpose | `gpt-4o` |
| **GPT-4o Mini** | Fast and cheap | `gpt-4o-mini` |
| **GPT-5.3 / 5.2 Codex** | Coding-tuned | `openai/gpt-5.3-codex`, `openai/gpt-5.2-codex` |
| **GPT-5.1 Codex Max** | Coding, max context | `openai/gpt-5.1-codex-max` |
| **Claude Opus 5** | Anthropic, most capable | `claude-opus-5` |
| **Claude Sonnet 5** | Anthropic, balanced | `claude-sonnet-5` |
| **Claude Haiku 4.5** | Anthropic, fast | `claude-haiku-4-5` |

Each family has its own id convention on Puter.js: the GPT models take a bare id, the **Codex** models need an `openai/` prefix ([tutorial](https://developer.puter.com/tutorials/free-unlimited-codex-api/)), and the **Claude** models take a bare id again ([tutorial](https://developer.puter.com/tutorials/free-unlimited-claude-35-sonnet-api/)). Puter.js supports several hundred more ids beyond this curated list (o1, o3, the 4.1 line, Gemini, Llama, DeepSeek, Grok, Mistral) — see the [tutorials index](https://developer.puter.com/tutorials/) if you want to wire up additional ones.

> A model id restored from a previous session is checked against this list before use — a stale or tampered value always falls back to the default instead of silently failing.

<br>

<a name="usage"></a>

<img src="docs/readme/banner-usage.svg" alt="Using the app" width="100%">

<br>

| Action | How |
| --- | --- |
| Send a message | Type and press `Enter` (`Shift+Enter` for a newline) |
| Switch model | Click the model pill in the chat header, or open the **Models** tab |
| Attach a file | Paperclip icon — an image, a PDF/DOCX, or a text file |
| Generate an image | Image icon next to the input — describes what to draw instead of chatting |
| View / download an image | Click any generated image to zoom in, with a download link |
| Copy a reply | Copy icon under any assistant message |
| Retry a reply | Retry icon under any assistant message — resends the same prompt (or regenerates the image) |
| Start a new chat | The **+** in the sidebar, or **New chat** in the drawer — the previous chat is kept |
| Reopen an old chat | Click it in the sidebar |
| Delete one chat | The **×** on its sidebar row |
| Hide the sidebar | The ☰ button at the left of the chat bar |
| Show a model's thinking | Click the **Reasoning** strip above a reply (reasoning-capable models only) |
| Connect GitHub | **Settings** tab → **Connect GitHub** → load or commit a file in any of your public repos |
| Ask the model to use GitHub | Once connected, just say it in chat — *"read my README and fix the typos"*. Each repo action shows in the transcript, and commits ask first. |
| Set reasoning effort | The picker beside the model pill, on models that support it |
| Save the chat as a PDF | **Save chat as PDF** in the drawer — prints through your browser, so on a phone it lands in the share sheet |
| Sign in / out | Account icon, top right, or the **Settings** tab |

<br>

<a name="quickstart"></a>

<img src="docs/readme/banner-quickstart.svg" alt="Quick start" width="100%">

<br>

```bash
git clone https://github.com/tradernonymous/freeopenai.git
cd freeopenai
npm install
npm start
# → http://localhost:3000
```

**Run the tests**

```bash
npm test      # node --test — server logic + shared chat helpers
npm run lint  # eslint
```

<br>

<a name="config"></a>

<img src="docs/readme/banner-config.svg" alt="Configuration" width="100%">

<br>

Nothing to configure to get running — no API key, no `.env` file. Everything below is optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port the static server listens on |
| `PROVIDER_TIMEOUT_CHAT_MS` | `55000` | Total budget per chat request, streaming or not. |
| `PROVIDER_TIMEOUT_HEADERS_MS` | `25000` | Per-attempt deadline for upstream response headers on streams. |
| `PROVIDER_STALL_MS` | `60000` | Aborts a stream quiet longer than this, with a stall message instead of silence. |
| `PROVIDER_TIMEOUT_MODELS_MS` | `20000` | Budget for model-catalogue fetches. |
| `RATE_LIMIT_MAX_ATTEMPTS` | `4` | 429 retries per call, 1–10. Backoff grows per attempt. |
| `AUTH_USER_1` / `AUTH_PASS_1` | *(unset)* | Login gate. Set both halves and the app requires a sign-in; leave either unset and the app stays open to everyone. |
| `AUTH_USER_2` / `AUTH_PASS_2` | *(unset)* | A second account. Optional. |
| `AUTH_USER_3` / `AUTH_PASS_3` | *(unset)* | A third account. Optional — three is the maximum. |
| `SESSION_SECRET` | *(random)* | Signs the login cookie. Set it so sessions survive a restart. |
| `GITHUB_CLIENT_ID` | *(unset)* | GitHub OAuth App client id — enables the GitHub connector in Settings. |
| `GITHUB_CLIENT_SECRET` | *(unset)* | GitHub OAuth App client secret. |
| `NARA_API_KEY` | *(unset)* | Adds the Nara router — pinned to five allowed models: agnes-2.5-flash, laguna-s-2.1, ling-3.0-flash-fin-free, nemotron-3.5-lightning-free, stepfun-3.7-flash. |
| `NARA_IMAGE_MODEL` | *(unset)* | Image-capable alias for the Edit flow (`/api/llm/images/edits`). Required — edits refuse clearly without it. |
| `NARA_IMAGES_BASE_URL` | *(https://api-images.bynara.id)* | Override for the Nara images host (self-hosted endpoint, proxy, or tests). |
| `OPENROUTER_API_KEY` | *(unset)* | Adds OpenRouter — pinned to ten allowed models: Qwen 3 Coder, Nemotron 3 Ultra, Laguna S/XS 2.1, gpt-oss-120b, North Mini Code, Gemma 4 31B, GLM 5.2, MiniMax M3, Nemotron 3.5 Lightning. |
| `NVIDIA_API_KEY` | *(unset)* | Adds NVIDIA's hosted models. |
| `MISTRAL_API_KEY` | *(unset)* | Adds Mistral. |
| `DEEPGRAM_API_KEY` | *(unset)* | Adds Deepgram. Speech service; its chat endpoint answers 404. |
| `ASSEMBLYAI_API_KEY` | *(unset)* | Adds AssemblyAI. Speech service; its chat endpoint answers 404. |
| `YOUCOM_API_KEY` | *(unset)* | Adds You.com. Search and research service. |

> Each provider stays out of the picker until its key is set. Any `*_API_KEY` also accepts a matching `*_BASE_URL` override, for a self-hosted endpoint or a proxy.
>
> The last three are speech and search services rather than LLMs. They're wired up so a key can settle it, but a chat request to Deepgram or AssemblyAI returns `404` because neither has a chat completions endpoint.
>
> Model lists are read from each provider at runtime, and free models are floated to the top. Where a provider publishes prices — OpenRouter — that decides it. Where one publishes none, the app assumes an account allowance and shows the catalogue, letting the provider be the one to refuse. That assumption is not always right: a catalogue with no prices can still refuse on billing or plan limits.
>
> A refusal naming one model retires that model. A refusal about the account — "a payment method is required" — suspends the whole provider and switches back to Puter, rather than spending a failed request per model.

> GitHub tokens are sealed with AES-256-GCM using `SESSION_SECRET` and stored in an httpOnly cookie — browser JavaScript never sees them. The connector asks for the `public_repo` scope only, every commit needs an explicit confirmation, and each token is bound to the app account that connected it, so a shared browser can't leak repo access between users.

<br>

<a name="deploy"></a>

<img src="docs/readme/banner-deploy.svg" alt="Deploy to Railway" width="100%">

<br>

```bash
# 1 · push this repo to your own GitHub account (or use it as-is)

# 2 · in Railway: New Project → Deploy from GitHub repo → select the repo

# 3 · Railway auto-detects package.json and runs `npm start` — no env vars needed
```

Your app is live at `https://<project>.up.railway.app` a few seconds later.

### 🐙 Working with GitHub

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (from a [GitHub OAuth App](https://github.com/settings/developers) whose callback URL is `https://<your-app>/api/github/callback`) and a **Connect GitHub** row appears in Settings.

Once connected, the model can work with your repos directly:

| Tool | What it does |
| --- | --- |
| `github_list_repos` | Lists public repos across every connected account |
| `github_list_files` | Lists a folder, so it can find a path |
| `github_read_file` | Reads one file |
| `github_commit_file` | Writes and commits — **always asks you first** |

Up to **three accounts** can be connected at once. Which one acts on a repo is resolved in a fixed order: an explicitly named account, then the repo's owner, and otherwise it refuses and asks — it never tries tokens in turn until one works, because guessing wrong on a write means committing under the wrong identity.

> Untick **Expire user access tokens** when registering the OAuth App. Refresh tokens aren't implemented, so an expiring token would silently disconnect after 8 hours.

### 🩹 Provider quirks the app works around

Puter fronts several providers, and they disagree in ways that surface as raw API errors. These are handled rather than passed through:

| Quirk | What the app does |
| --- | --- |
| Claude returns `message.content` as an array of blocks, not a string | Normalizes both shapes, so replies don't render as `[object Object]` |
| Claude asks for tools with `tool_use` blocks, not `message.tool_calls` | Normalizes to one shape the tool loop understands |
| Some Claude models reject the effort setting with a `thinking.type` error | Retries once without it, then hides the picker for that model |
| A reply object carries `model`, `id`, `usage` | Strips them before echoing the turn back, which the provider rejects otherwise |
| Codex model ids need an `openai/` prefix | Baked into the model list |
| A free-tier provider answers `429 Too Many Requests` | The server retries with backoff (up to 4 attempts, ~17s worst case) and the page gives it one more try, so a rate-limited NVIDIA burst rides itself out instead of failing every message. |
| The user stops a streaming reply | The red stop button (or Escape) aborts the fetch, and the server cancels the upstream request the moment the client disconnects, so a cancelled answer doesn't keep burning tokens. |

<br>

<a name="architecture"></a>

<img src="docs/readme/banner-architecture.svg" alt="Architecture" width="100%">

<br>

**Request path.** Browser loads `index.html` → Puter.js authenticates the user and meters usage → the page calls `puter.ai.chat()` directly from the browser → the reply streams back into the chat. When a direct-provider key is configured, the chat goes through `server.js`, which streams the upstream SSE body straight to the client so tokens still appear one at a time without a full-page wait. `server.js` caches the model catalogue in memory to avoid re-fetching on every provider switch.

<details>
<summary><b>🗂️ Project layout</b> &nbsp;·&nbsp; click to expand</summary>

```text
index.html      chat UI: markup, styles, and all client-side logic
login.html      username/password screen, shown once AUTH_USER_1/AUTH_PASS_1 are set
chatlib.js      shared, dependency-free logic (model list, HTML escaping,
                attachment allowlist) — used by the page and by the tests
auth.js         session-cookie signing and credential checking
github.js       AES-256-GCM sealing for the stored GitHub token
server.js       zero-dependency static server + the login and GitHub routes
test/           node --test suite for server.js, chatlib.js, auth.js, github.js,
                the GitHub tools, the conversation store, and a boot check that
                runs index.html's script against a stub DOM
.github/        CI: lint + tests on every push and pull request
```

</details>

<br>

<img src="docs/readme/divider.svg" alt="" width="100%">

<a name="disclaimer"></a>

## ⚠️ Disclaimer

FreeOpenAI is an unofficial client — it is not affiliated with OpenAI or Puter. Usage is billed to your own Puter account under Puter's terms, not this project's. Conversations are stored only in your browser's `localStorage` — the last 50, each capped at 200 messages. Clearing site data or switching browsers loses them; there is no server-side copy to restore from.

<p align="center">
  <sub>MIT licensed · Built on <a href="https://puter.com">Puter.js</a> · <a href="#contents">Back to top ↑</a></sub>
</p>
