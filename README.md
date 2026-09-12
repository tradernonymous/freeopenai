<p align="center">
  <img src="docs/readme/hero.svg" alt="FreeAi4U. Free access to OpenAI models, no key required." width="100%">
</p>

<p align="center">
  <b>A free, serverless chat UI for OpenAI models — no API key, no backend, no bill in your name.</b><br>
  Sign in once through Puter · pick a model · chat · your Puter account covers the usage.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/Puter.js-v2-6C5CE7?style=for-the-badge" alt="Puter.js v2">
  <img src="https://img.shields.io/badge/tests-214%20passing-22c55e?style=for-the-badge" alt="214 tests passing">
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
      Ask anything and get a streamed, markdown-rendered reply in a centered 768px column at compact density. Web research rides every turn — the model searches (DuckDuckGo + Wikipedia) and reads pages itself, citing sources, instead of guessing or sticking to your repos. Starts on a prompt hero with suggestion cards, copy or retry any response, Ctrl+P palette for models and actions, turn stats (model · seconds · chars) in the status bar, and dark/light plus tokyonight/gruvbox/auto themes in the header.
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
      Toggle the image icon next to the input to generate a picture instead of chatting. A labelled shimmer placeholder holds the spot while it renders (instant failures say so instead of flashing past). Click any result to zoom in, download, copy, edit with a brush mask, or make variations — every image lands in the Gallery view, newest first. Puter draws when it is signed in; when it isn't, or when it refuses (credits, access), the request falls through to the server's own image route, so a picture can still arrive instead of a failure that names the wrong problem. When every backend fails the message says which ones were tried and what stopped each.
    </td>
    <td valign="top">
      <h3>🧠 Reasoning summaries</h3>
      Reasoning-capable models return their thinking separately. While it works, one moving line above the reply shows the tail of what it is thinking; when the answer arrives it folds away behind a <b>Reasoning</b> summary you can click open. Switch the whole thing off in <b>Settings → Reasoning summary</b>.
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
      <h3>🔌 Many providers</h3>
      Puter needs no key at all. Add a key for Nara, OpenRouter, NVIDIA, Mistral, HuggingFace or AI Gateway and they appear in a picker — so one running dry never stops the work. A local Ollama joins with just a base URL and needs no key, and a self-hosted OmniRoute gateway fronts hundreds of providers — including the `auto` router — behind one endpoint. Keys stay on the server.
    </td>
    <td valign="top">
      <h3>📱 Built for a phone</h3>
      A slide-out drawer, safe-area insets, 16px inputs so iOS doesn't zoom, a Send key on soft keyboards, no double-tap delay, a layout that resizes with the keyboard instead of hiding behind it, wrapped links, capped image heights, and controls that shrink rather than shove each other off a 375px screen.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>⚡ SSE streaming</h3>
      Direct-provider replies arrive token-by-token via Server-Sent Events — no waiting for the full answer before text appears.
    </td>
    <td valign="top">
      <h3>🛑 Stop / cancel</h3>
      Hit the red stop button or press Escape mid-reply to abort a generation instantly. The upstream fetch is cancelled server-side too.
    </td>
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
| `RATE_LIMIT_MAX_ATTEMPTS` | `6` | Retries per call for a transient answer — 429, a 5xx, or no response at all. 1–10. Backoff grows per attempt with jitter; a provider's `Retry-After` header is honoured when one is sent. |
| `AUTH_USER_1` / `AUTH_PASS_1` | *(unset)* | Login gate. Set both halves and the app requires a sign-in; leave either unset and the app stays open to everyone. It also decides what a *direct* provider (Nara, Antigravity, OpenRouter, Ollama …) needs: with a login of its own the app has already identified the visitor and enforces that on every API route, so those providers work with no Puter account. With no login gate, the Puter sign-in stays required even for a direct provider, because there it is the only thing between an anonymous visitor and your API keys. |
| `AUTH_USER_2` / `AUTH_PASS_2` | *(unset)* | A second account. Optional. |
| `AUTH_USER_3` / `AUTH_PASS_3` | *(unset)* | A third account. Optional — three is the maximum. |
| `SESSION_SECRET` | *(random)* | Signs the login cookie. Set it so sessions survive a restart. |
| `GITHUB_CLIENT_ID` | *(unset)* | GitHub OAuth App client id — enables the GitHub connector in Settings. |
| `GITHUB_CLIENT_SECRET` | *(unset)* | GitHub OAuth App client secret. |
| `NARA_API_KEY` | *(unset)* | Adds the Nara router — pinned to five allowed models: agnes-2.5-flash, laguna-s-2.1, ling-3.0-flash-fin-free, nemotron-3.5-lightning-free, stepfun-3.7-flash. |
| `NARA_IMAGE_MODEL` | *(unset)* | Image-capable alias for `/api/llm/images/generations` and `/api/llm/images/edits`. Required — both refuse clearly without it, rather than passing on Nara's "Image model is required". |
| `NARA_IMAGES_BASE_URL` | *(https://api-images.bynara.id)* | Override for the Nara images host (self-hosted endpoint, proxy, or tests). |
| `OPENROUTER_API_KEY` | *(unset)* | Adds OpenRouter — **free tier only**. The picker pins all 19 `:free` models (verified 2026‑09‑12), led by Nemotron 3 Ultra 550B, Inkling / Inkling Small (1M ctx), Nemotron 3.5 Lightning (1M ctx), Gemma 4 31B, Laguna S/XS 2.1 and North Mini Code. `OPENROUTER_FREE_ONLY=0` lifts the free-only gate. |
| `NVIDIA_API_KEY` | *(unset)* | Adds NVIDIA's hosted models — live catalogue (GLM, DeepSeek, Kimi, MiniMax, Devstral, Qwen, Nemotron, Gemma, Mistral, gpt-oss and the rest, as served). |
| `HF_TOKEN` | *(unset)* | Adds HuggingFace Inference Providers — one key across every serverless model on the Hub's OpenAI-compatible router. The free tier is monthly credits (~$0.10), so the picker pins the router's **full priced catalogue — 138 models, cheapest first** (verified 2026‑09‑12), led by the five **zero-priced** offerings (Qwen3.8‑27B, Ling‑3.0‑flash‑VL/Fin, Ternary‑Bonsai) that never touch credits, then gpt‑oss‑20b, Gemma 3, Llama 3.1 8B and up through GLM 5.3, DeepSeek V4 Pro, Kimi K3 and the 550B Nemotron. The `free` chip on huggingface.co/models is a community tag no provider honours — all 29 of those models were checked against the router and none is served. `HF_BASE_URL` overrides the router; `HF_MODELS` replaces the pinned list. |
| `MISTRAL_API_KEY` | *(unset)* | Adds Mistral. |
| `AI_GATEWAY_API_KEY` | *(unset)* | Adds Vercel AI Gateway — one Bearer key across providers (Laguna S 2.1, Ling 3.0 Flash Sante/Fin, Fish Audio S2.1 Pro among them). |
| `OLLAMA_API_KEY` | *(unset)* | Key for Ollama. A key alone means **Ollama Cloud** (`https://ollama.com/v1`) — the hosted catalogue appears. A key with no `OLLAMA_BASE_URL` never touches a local install; to reach one, set `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`) and the live local catalogue appears — GLM, DeepSeek, Kimi, Qwen, MiniMax, Devstral, Nemotron, Mistral, gpt-oss, Muse Glimmer and the rest, whatever the server actually serves. The app also accepts a Railway root URL and falls back from OpenAI-compatible `/v1/models` to native `/api/tags`. |
| `DEEPGRAM_API_KEY` | *(unset)* | Adds Deepgram. Speech service; its chat endpoint answers 404. |
| `ASSEMBLYAI_API_KEY` | *(unset)* | Adds AssemblyAI. Speech service; its chat endpoint answers 404. |
| `YOUCOM_API_KEY` | *(unset)* | Adds You.com. Search and research service. |
| `ANTIGRAVITY_BASE_URL` | *(unset)* | Adds **Antigravity** through an OpenAI-compatible proxy — Claude Opus / Sonnet and Gemini 3, using a quota your Google account already has. Set it or `ANTIGRAVITY_API_KEY`. See [Antigravity](#antigravity). |
| `ANTIGRAVITY_API_KEY` | *(unset)* | Optional key, sent as `Bearer`. The proxy holds the Google credentials itself, so this is empty for a default local install — and empty means *no* auth header at all, never a bare `Bearer`. |
| `ANTIGRAVITY_MODELS` | *(the pinned list)* | Comma-separated ids that replace the pinned list, for a proxy release whose model names differ. |
| `OMNIROUTE_BASE_URL` | *(unset)* | Adds **OmniRoute** — a self-hosted AI gateway that fronts hundreds of upstream providers behind one OpenAI-compatible endpoint, including the `auto` model that routes each request to the best connected provider. Set it or `OMNIROUTE_API_KEY`. See [OmniRoute](#omniroute). |
| `OMNIROUTE_API_KEY` | *(unset)* | Optional key, sent as `Bearer`. A fresh OmniRoute install answers without one (`REQUIRE_API_KEY=false`); when the gateway is hardened to require a key, set it here — and an unset key means *no* auth header at all, never a bare `Bearer`. |
| `OMNIROUTE_MODELS` | *(the pinned list)* | Comma-separated ids that replace the pinned list — the `auto` variants and the direct flagships — when your gateway's catalogue routes different names. |

> Each provider stays out of the picker until its key is set. Any `*_API_KEY` also accepts a matching `*_BASE_URL` override, for a self-hosted endpoint or a proxy.
>
> **OpenRouter free tier, one note.** The picker never offers a paid model by default: the allowlist carries only `:free` ids, a `freeOnly` gate double-checks the live catalogue, and OpenRouter's own rate limits apply (about 20 requests/min; 50/day without any top-up, 1,000/day once you've ever bought $10 of credits). If a pinned id is retired upstream it silently drops out of the picker — and if every pinned id were retired at once, the picker degrades to the full live catalogue instead of going empty.
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

### 🩺 Is the deploy actually current?

A 200 from your Railway URL only proves *something* is running. `GET /api/health` answers the real question, needs no login, and is never cached:

```bash
curl -s https://<project>.up.railway.app/api/health
# {"ok":true,"version":"1.0.0","commit":"4b97790…","branch":"main","uptimeSeconds":142,"providers":[…]}
```

`commit` is Railway's `RAILWAY_GIT_COMMIT_SHA`, so comparing it against `git rev-parse main` tells you whether the merge you just made is live instead of guessing from timestamps — and `uptimeSeconds` resets on every deploy, which is the quickest way to see that a redeploy happened at all. `branch` and `commit` are `null` when the server is not running on Railway.

The response carries provider **ids** only. It deliberately never includes keys, base URLs, account names, paths, or even which providers are configured — a public endpoint that lists which of your API keys exist is reconnaissance.

### 🦙 Ollama on Railway (the 502 fix)

`Could not load models: 502: Could not reach Ollama: fetch failed (ENOTFOUND: the host name did not resolve) — this is the endpoint you configured, so check that it is running and reachable from the server` is the app's own error when its HTTP call to the Ollama base URL fails at the socket level.

The parenthetical is the underlying socket error, and it is the part that names which problem you have: `ENOTFOUND` / `EAI_AGAIN` means the name does not resolve — case 1 below; `ECONNREFUSED` means it resolves but nothing is listening on that port — case 2; `ETIMEDOUT` or `EHOSTUNREACH` means the path is blocked, or the instance is asleep — case 4. On Railway it is nearly always one of the four, in this order:

1. **The base URL still points at localhost.** The default `http://localhost:11434/v1` is correct on your laptop; from the Railway app container it must be the Ollama service's URL: `OLLAMA_BASE_URL=https://<ollama-service>.up.railway.app/v1`, or `http://ollama.railway.internal:11434/v1` for the private network (same Railway project, cheaper and faster).
2. **Ollama listens on loopback inside its own container.** Set `OLLAMA_HOST=0.0.0.0:11434` on the Ollama service or it refuses every off-container connection — which the app sees exactly as `ECONNREFUSED`, because it reached the host and found no listener.
3. **No models are installed.** Railway containers wipe on every deploy, so `ollama pull ...` at runtime disappears on the next one. Attach a volume to the Ollama service at `/root/.ollama`, add a start command like `ollama serve & sleep 8 && ollama pull qwen3:8b && ollama pull gemma3:4b`, and pull small models — Railway has no GPUs, so 8B-class is the practical ceiling.
4. **The free-plan instance was asleep.** Railway's trial/free services sleep and refuse connections while cold — the first request wakes them and can 502 once.

<details>
<summary><b>Step by step</b></summary>

<br />

1. Railway project → **+ New → Docker Image** → `ollama/ollama`, or **+ New → GitHub Repo** with a Dockerfile based on `ollama/ollama`.
2. On the Ollama service → **Settings → Networking → Generate Domain** and set `OLLAMA_HOST=0.0.0.0:11434`. You may use either the generated public URL or the private service name from the app service.
3. On the Ollama service → **Storage → + New Volume**, mount path `/root/.ollama`, so pulled models survive deploys.
4. Add a start command that seeds a small model before serving: `sh -c "ollama serve & sleep 8 && ollama pull qwen3:8b && ollama pull gemma3:4b && wait"`. Verify the service itself with `curl https://<ollama-service>.up.railway.app/api/tags` — you should see the pulled models listed.
5. On the **freeopenai** service, set **the app's** variable (not the Ollama service's):

| Variable | Value |
| --- | --- |
| `OLLAMA_BASE_URL` | `https://<ollama-service>.up.railway.app` **or** `https://<ollama-service>.up.railway.app/v1` |
| `OLLAMA_API_KEY` | *(leave unset — keyless is fine, the URL alone enables the provider)* |

6. Redeploy freeopenai, open the provider picker, and choose **Ollama**. It first tries `/v1/models`; if that route is missing, it automatically reads native `/api/tags`. If both fail, the status now reports the upstream reachability error rather than pretending a model is available. The model selector only lists chat-capable models that the service actually returned.

</details>

### 🧩 Modes & skills (opencode-style)

The composer has a mode chip that cycles **Chat → Plan → Build**, the same three modes opencode uses:

| Mode | What it does | Skills applied |
| --- | --- | --- |
| **Chat** | Default assistant — ask anything | Nothing auto-picked — but pinned skills still apply |
| **Plan** | Reasons about the task, writes an implementation plan, changes nothing | planning/writing skills as matched |
| **Build** | Executes with the full tool loop, TDD-first discipline | methodology core + best-matched skills |

Skills are pulled from open libraries — no setup, cached 6h, degrading to the last-good copy if GitHub is down. **136 skills** across eleven libraries, loaded in about half a second cold and 3 ms warm:

| Library | What it contributes |
| --- | --- |
| [anthropics/skills](https://github.com/anthropics/skills) | The full official set (frontend-design, docx, pdf, mcp-builder, …) |
| [obra/superpowers](https://github.com/obra/superpowers) | Development methodology: TDD, systematic debugging, verification before completion |
| [mattpocock/skills](https://github.com/mattpocock/skills) | Engineering practice: code review, diagnosing bugs, codebase and domain design |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | Copy, SEO, ads, analytics — the other half of an assistant's work |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | The lazy-senior-dev discipline (YAGNI, stdlib first) plus its review/audit/debt/gain companions |
| [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | Lite pick: `lean-build`, `surgical-patch`, `verify-and-stop`, `caveman-commit`, `caveman` |
| [blader/humanizer](https://github.com/blader/humanizer) · [petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop) | Writing: rewriting AI tells out of prose, and sharpening a draft without flattening it |
| [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design) · [tt-a1i/archify](https://github.com/tt-a1i/archify) | Diagrams as standalone HTML/SVG, from a description or a repository |
| [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) | Output shaped for a reader who needs the next action first |

How auto-application works: each request's text is scored against every skill's name + description (stemmed, name hits weighted 3×, generic verbs ignored). A skill needs **two shared words, or one that is part of its own name** — one generic word is a coincidence in a library this size. The top matches ride along as extra system context in Plan and Build modes; Build additionally seeds the process core (TDD, verification-before-completion, lean-build) once something has actually matched. In Build mode the model can also call the `use_skill` tool to load any skill's full text mid-task.

**The router is measured, not assumed.** A router fails quietly: its tests pass while it answers a JavaScript question with an SEO skill. `tools/skill-audit.js` runs twenty ordinary requests through the real library and reports which skills answered and whether any came from the wrong field — `node tools/skill-audit.js`. `test/skill-router.test.js` asserts the same run against a committed snapshot of the catalogue (`test/fixtures/skill-catalogue.json`), so a router change shows up as a diff in behaviour. Current state: **no request is answered from an unrelated field**, and a request matching nothing picks nothing. Three wrong picks remain, listed in the test as a ratchet: `ab-testing` and `ai-seo` on requests that merely contain the word "test" or "ai", and `sms` on a diagram request — one ambiguous word shared with a skill the library also uses generically, which word overlap alone cannot resolve.

**Pinning a skill to a chat.** Auto-picking is per request and forgotten by the next question. The **Skills** button in the composer (or typing `/` and a name) does the other thing: it pins a skill to the **conversation**, so `/ponytail` on the first message is still applying on the ninth — in Chat mode too, where no auto-skills fire at all, and with auto-skills switched off entirely. A pinned skill is saved with the chat, survives a reload, and a new chat starts with none of them, so a choice is never inherited by a conversation that did not make it. Up to five at once; past that the oldest is turned off and the app says which. Pinned chips sit above the composer with an `×` each, the picker is searchable and toggles items on and off, and a skill the model loads itself with `use_skill` is pinned too, visibly — otherwise the next turn would fetch the same text again.

**Offers, learned from what you pin.** Pinning the same skill in two *different* chats is a habit, and once a skill is one the app offers it while you type — a dashed `Try ponytail?` chip with **Add** and `×`, scored against the text being written so accepting applies to *that* request. Declining is remembered for the chat. Four things keep it from becoming a suggestion engine with opinions: habit is counted by **chat** rather than by click (un-pinning and re-pinning in one conversation is one intention), **only deliberate pins count** (a skill the model loaded for itself with `use_skill` is the app's doing, not a preference), the offer is **a question and never an action** — a skill that switched itself on would spend prompt budget on every request of a chat that never asked for it — and the habit store is bounded to the most recent 60 skills. It is browser-local (`freeopenaiSkillUsage`), so it does not travel between devices and carries nothing identifying about the requests themselves.

**Which skills are answering, on the left.** The card beside the chat lists every skill that has applied to this conversation, tagged `pinned` or `auto` and showing how many requests each rode along with. It exists because the router's choices are invisible by design — a skill leaves no trace in the reply — so an answer that came out oddly should be traceable to a method rather than guessed at. Tap an `auto` row to pin it, a `pinned` row to let it go. It folds away with the button in the header and is hidden entirely below 1100px, where the chat needs the width more. The record is per conversation and lives in your browser (`freeopenaiSkillUse`); a new chat starts it empty.

**Commands.** Typed into the composer: `/help`, `/skill <name>`, `/skill off <name>`, `/skills`, `/mode chat|plan|build`, `/clear`. Or skip the verb: `/ponytail` and `/caveman` are the shorthand, since typing the name is how people actually reach for a skill. Anything else that starts with a slash — `/usr/bin is missing` — is sent to the model as the ordinary message it is; the app never swallows text it did not understand. Commands are answered locally, so opening the skill picker costs nothing.

- `GET /api/skills` — the installed catalogue (source, name, description)
- `GET /api/skills/content?name=<skill>` — one skill's full SKILL.md
- `SKILLS_CACHE_TTL_MS` — cache lifetime override (default 6h)
- Add your own in `SKILL_SOURCES` (chatlib.js): `dir` is the folder holding the skills and `pick: [...]` narrows a big repo to a chosen few. Nesting and root-level `SKILL.md` files are handled; the name comes from the folder holding the file.

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

### 🗂️ The workspace

Every chat can also read and write a small **workspace**: a flat set of text files the model keeps notes and drafts in.

| Tool | What it does |
| --- | --- |
| `workspace_list_files` | Lists a folder, with the size of each file |
| `workspace_read_file` | Reads one file |
| `workspace_write_file` | Creates or replaces a file — **always asks you first** |

It lives in your browser (localStorage) beside the conversations, not on the server. The deployment is shared and its container is rebuilt on every push, so a server-side workspace would be both visible to other people and temporary. Files can be downloaded or deleted from **Settings → Workspace files**.

Paths are relative to the workspace root and a `..` is refused rather than resolved away, so nothing can reach outside it. Writes are capped (100 kB per file, 200 kB and 64 files in total) because the conversations share the same few megabytes of storage.

Reads run in parallel with other reads; writes never do, since two writes to one path in the same moment is a race whose loser vanishes.

### ✅ The task list

The model can also keep a **task list**: the plan for work that spans several turns and chats, so a follow-up doesn't have to be told the whole story again.

| Tool | What it does |
| --- | --- |
| `task_list` | Shows every task with its status, id and dependencies |
| `task_add` | Records a task, optionally waiting on an existing one by id |
| `task_update` | Moves a task to `todo`, `doing`, `done` or `blocked` |

A task that still waits on unfinished work cannot be marked `done` — the one status change that can make a plan look finished when it isn't. A dependency must name a task that already exists, and ids are handed out in order, so a cycle cannot be expressed in the first place.

The list sits **beside the chat**: a floating card on the right rather than a tab or a settings dialog, because a plan you have to go and open is a plan nobody keeps current. Each row carries its id and what it still waits on, its note opens in place, and a hairline in the header fills as tasks finish. Rows order themselves — in progress, then to do, then blocked, then done — so the next thing to pick up is the first thing you read. Tick the circle to finish a row, `×` to drop it. The card folds away with the button in the header, becomes a drawer over the chat on a phone, and its choice is remembered per browser.

It is kept in the browser like the workspace and rides in the system prompt when it isn't empty, so a later turn — or a different chat — can pick the work up where it stopped. **When a reply arrives while the list it touched this turn still has items open, the app hands it back to the model once and asks it to finish them or say plainly which are open**, because "done, all sorted" reads as complete while three unticked rows sit beside it. The check is armed only by a turn that actually wrote to the list, so an old open task from another conversation never interrupts an answer about something else.

No approval is asked for a change: it alters nothing outside the conversation, and a dialog in front of every status change would make planning unusable. **Settings → Tasks** shows the count and points at the panel rather than repeating the list, since two renderings of one list is two places for it to be wrong.

<a name="antigravity"></a>

### 🛰️ Antigravity (Claude Opus and Gemini through a proxy)

Antigravity models are reached through an OpenAI-compatible proxy that you run yourself. Two projects make up that stack, and they do different jobs:

- [**antigravity-auth**](https://github.com/cortexkit/antigravity-auth) signs a Google account in and stores the resulting tokens on your machine.
- [**antigravity-proxy**](https://github.com/frieser/antigravity-proxy) is the gateway: it holds those accounts and serves `POST /v1/chat/completions` in OpenAI's shape, so this app can talk to it as an ordinary provider.

The app needs no Google credentials of its own — the proxy owns them. Set the base URL and the provider appears:

```bash
# terminal 1: the proxy (it opens on http://localhost:3000)
bunx antigravity-proxy@0.7.0

# terminal 2: this app, pointed at it
ANTIGRAVITY_BASE_URL=http://localhost:3000 npm start
```

`Antigravity` then appears in the provider picker with Claude Opus 4.6 (thinking low / medium / high), Sonnet and the Gemini 3 family. Both `/v1` and a bare `http://host:port` work as the base URL — the version segment is added when it is missing. Docker works too (`docker run -d -p 3000:3000 frieserpaldi/antigravity-proxy:0.7.0`), and a non-default port goes in the URL.

| Setting | Value |
| --- | --- |
| `ANTIGRAVITY_BASE_URL` | `http://localhost:3000` (local) or the URL of wherever the proxy runs |
| `ANTIGRAVITY_API_KEY` | *(leave unset for a default local proxy)* |
| `ANTIGRAVITY_MODELS` | Optional comma-separated override when your proxy's model names differ from the pinned list |

Until that variable (or `ANTIGRAVITY_API_KEY`) is set, **Antigravity does not appear in the picker at all** — the provider stays out of it entirely rather than showing up and failing, so "I can't see the Opus models" on a deploy almost always means the variable is missing.

**Running the proxy alongside a deployed app.** [`deploy/antigravity-proxy/`](deploy/antigravity-proxy/) builds the gateway with its accounts seeded from a variable and explains the Railway service: the variables, the private-network base URL, and how to read the logs when it does not come up. It exists because a hosted instance cannot create accounts — the proxy's OAuth redirect is hardcoded to `localhost:3000` — so they are signed in once locally and carried over.

**A local proxy is not reachable from a deployed app.** `http://localhost:3000` from the Railway container means the container itself, where no proxy is running. So either run this app locally against the proxy (the command above), or put the proxy somewhere the app can reach and point `ANTIGRAVITY_BASE_URL` at it. Don't publish the proxy to the open internet to do that: it holds your Google accounts, a default install asks for no key, and anyone who finds the URL is spending your quota. Put it behind your own authentication, or reach it over a private network.

**Read this before you use it.** Using Antigravity through a proxy runs against Google's Terms of Service, and the projects' own documentation reports account suspensions, bans and shadow-bans. Those accounts are yours. The risk is yours too — this app simply speaks to whatever gateway you point it at.

One implementation note: the proxy publishes no model catalogue, so this provider is declared `catalogue: false` and serves its pinned list directly rather than asking for `/v1/models`. A proxy that never implemented that endpoint would otherwise produce a fetch error and an empty picker. `ANTIGRAVITY_MODELS` is the escape hatch when a proxy release renames things.

**If the picker says "this provider returned no chat models".** That message means the model list resolved to nothing, which is a configuration mistake rather than the proxy failing — and the likeliest spelling of it is a **stray space** in `ANTIGRAVITY_MODELS`, which is truthy, splits to an empty id and filters away. A declared list that resolves to nothing now falls back to the pinned list instead of publishing nothing, and an entry that could not address a model at all (a zero-width space or a smart quote left by a paste) is dropped rather than served as a row that cannot work. If the effective list is *still* empty — a provider with no pinned list of its own and nothing usable declared — the route answers with an error naming the variable and the character position that spoiled it, so the fix is readable from the message instead of looking like the provider is down. The same fallback applies to every provider with a declared list.

### 🚀 OmniRoute (hundreds of providers through one local endpoint)

[**OmniRoute**](https://github.com/diegosouzapw/OmniRoute) is a self-hosted AI gateway you run yourself. It fronts **352 providers / 1,312 model ids / 154 free tiers** behind one OpenAI-compatible endpoint, with automatic routing, quota-aware fallback and a dashboard you manage. The killer feature is the `auto` model: one id that routes every request to whichever connected provider best fits at that moment — so the picker stays small even though the reach is huge.

```bash
# terminal 1: the gateway (it opens on http://localhost:20128)
npm install -g omniroute && omniroute
# or Docker: docker run -d --name omniroute -p 127.0.0.1:20128:20128 \
#   -v omniroute-data:/app/data diegosouzapw/omniroute:latest

# terminal 2: this app, pointed at it
OMNIROUTE_BASE_URL=http://127.0.0.1:20128 npm start
```

`OmniRoute` then appears in the provider picker led by `auto` and its variants (`auto/coding`, `auto/fast`, `auto/cheap`, `auto/smart`, `auto/offline`), plus a handful of direct flagships. Node `>=22.22.2` (or `>=24`); the catalogue is fetched live from the gateway's `/v1/models` (deduplicated with `?prefix=alias`) and intersected with the pinned list, so a model your gateway doesn't publish simply stays out of the picker instead of failing on use.

| Setting | Value |
| --- | --- |
| `OMNIROUTE_BASE_URL` | `http://127.0.0.1:20128` (local) or wherever the gateway runs. Both with and without `/v1` work — the version segment is added when it is missing. |
| `OMNIROUTE_API_KEY` | *(leave unset for a default install with `REQUIRE_API_KEY=false`)* |
| `OMNIROUTE_MODELS` | Optional comma-separated override when your gateway's route names differ from the pinned list |

Until that variable (or `OMNIROUTE_API_KEY`) is set, **OmniRoute does not appear in the picker at all** — the provider stays out of it entirely rather than showing up and failing, so "I can't see the auto models" on a deploy almost always means the variable is missing.

**Connecting providers to OmniRoute.** Run the gateway, open its dashboard at `http://localhost:20128`, sign in with the initial admin password, and connect whichever accounts/keys you want — OmniRoute keeps them in its own SQLite database, encrypted at rest. This app never sees them; it only talks to the gateway.

**Hardening the gateway.** A default install asks for no key, and anything that can reach it can spend every account you connected. If you expose it beyond your own machine, set `REQUIRE_API_KEY=true` in the gateway's environment, create an API key in its dashboard, and put that key in `OMNIROUTE_API_KEY` here.

**A local gateway is not reachable from a deployed app.** `http://127.0.0.1:20128` from the Railway container means the container itself, where no gateway is running. Either run this app locally against the gateway (the command above), or run the gateway somewhere this app can reach — a second service on the same Railway project (private network), a VPS, or your own server — and point `OMNIROUTE_BASE_URL` at it. Don't publish an unhardened gateway to the open internet.

### 💸 What keeps a turn affordable

Every call is billed again with the whole conversation in front of it, so what a turn costs is mostly what it sends twice. Five rules keep that down, and each one is visible in the app rather than buried:

| Rule | What it does |
| --- | --- |
| **The stable part comes first** | The system message holds only what does not change: the base prompt and the mode. The task list and any active skills ride at the *end* of the request instead, on the live user turn. A prefix that changes every turn can never be reused, so the provider re-reads the entire conversation at full price every time; now everything up to the newest message can be. Where the provider caches automatically — OpenAI, Gemini 2.5, DeepSeek, Grok, Moonshot, Groq — those hits now actually happen. |
| **A tool call runs once** | Results are remembered for the duration of a question, keyed by the tool name and its arguments (argument *order* does not matter). A model that reads the same file twice, or asks for it twice in one round, gets the answer it already paid for, and the transcript says `Reused N earlier tool result(s) instead of repeating the call`. A commit asked for twice therefore commits once. |
| **A repeat is called out** | When the same call comes back a second time, the app says so *in the conversation* — a status toast is something the model never reads — so it uses what it already has instead of asking a third time. |
| **Oversized results are clipped** | A tool result longer than 20,000 characters is cut once, with the missing size stated, because every later round of the turn re-sends it. The limit is deliberately high enough that reading an ordinary source file still delivers the whole file; what it bounds is the file nobody meant to open. |
| **A read is remembered past the question that paid for it** | The follow-up to an answer about a file used to open by reading that file again — and once history trimming had dropped the earlier answer for weight, the model had no choice but to. Reads are now remembered for the conversation, so the next question answers out of the last one's work; the transcript says so, and the result itself carries its age (`[remembered from 4 minutes ago]`), because the model is the one that has to decide whether to trust it. Three rules keep that honest: a **write forgets what it touched** — the file it wrote, and any listing of a folder containing it — so a model that writes a file and reads it back is never handed the text from before its own write; a remembered read **expires after fifteen minutes**; and a fresh read is never labelled. It lives in the tab, not in storage: a reload is a fine time to stop trusting a file read twenty minutes ago. |
| **History has a weight cap, not just a count** | The last twelve turns travel, but only up to roughly 24,000 estimated tokens of them. Twelve turns of chat are cheap, twelve turns carrying a pasted file are not, and a request that overflows the model's window fails outright rather than costing less. The newest turn always travels, however large: without it, it is a different question. |
| **A work step goes to a cheaper model** | A tool turn is not one call but up to twelve, and each one re-sends the whole conversation — so the rounds that only read what a tool returned are the expensive ones. Those steps are sent to the cheapest model the provider lists, while the model you picked plans the turn and is the one the app falls back to the moment a step goes wrong. Below, and switchable in **Settings → Cheaper models for tool steps**. |

### 🪜 Which model answers which step

A tool turn has three kinds of call, and they are worth different amounts of money. The **plan** is the first call, with nothing read yet, so it decides what the turn is even going to do. A **work** step is any later call that has tool output in hand: it reads the result and chooses the next move. The **answer** is a call made with tools withheld — the reply you are waiting for.

Only the work step moves. It is also the one that costs the most, because by then the whole conversation is in front of the model and a tool call is all that comes back. The choice is by published price — free first, then the cheapest input-weighted cost, since a round of this size is mostly input — and only among models that can actually take tools. Where a provider publishes *no* prices at all, which is the case for the allowance-backed ones (Nara, NVIDIA, the Antigravity proxy), the small model of the family is used instead, by name. That is a heuristic and it is last: any published price beats it. An unpriced model is never treated as free — the router refuses to guess rather than hand every step to whichever premium model happens to publish nothing. The same catalogue as the picker is filtered, so an embedding or image model is never a candidate.

The trade is real and it is measured by the people who designed this shape: NVIDIA's [Switchyard](https://github.com/NVIDIA-NeMo/Switchyard) reaches 72.7% on Terminal-Bench 2.1 at $68.19 against a 76.0% / $98.06 baseline — **30.5% cheaper for 3.3 points of accuracy**. So it is a switch, and the app is on the record about it: the first routed step of a turn says so in the conversation and names *both* models, and the status bar reports the model that actually produced the reply rather than the one the picker shows. Since a work step can be the step that answers, that is often the cheaper model — which is the honest consequence of the trade, not a bug.

Four things send a step back to your model, and all four are observed rather than guessed: the cheap model **refused** that step (a refusal is never allowed to move your selection — it only takes that model out of circulation), it came back with **nothing**, it sent **arguments the tools cannot use** (which `parseToolArgs` has to swallow to keep the turn alive, and which was invisible until now), or it **asked again for something it already had**. The first is re-asked immediately on your model; the others hand the *next* step back, because that is the one that has to make sense of the result. A whole turn carrying an image is never routed at all: the model was already switched to one that can read the picture.

When a question fails part-way through a tool loop, the answers it already collected are kept — so retrying replays those lookups instead of buying them a second time, while a genuinely new question starts from nothing. The status bar reports what the provider cached, so the saving is visible: `gpt-5.4-nano · 3s · 812 chars · 120 tok · 12.4k cached`. A provider that caches nothing reports nothing.

### 🔀 Moving a request that a provider stopped answering

When a provider fails part-way through a tool loop — a 5xx, a rate limit that outlives the retries, a spent allowance, a refused account, a dead socket — the turn is carried to the next configured provider **with everything it already collected**, rather than ending in an error and throwing the work away. The transcript says which provider failed and where the request went, so a change you did not make yourself is never invisible.

Not every failure moves: a failure another account could plausibly answer does, while a *model* refusal does not. The model walker has already tried that model's siblings on the same provider, so moving would just multiply the attempts for a request that is going to fail everywhere. One turn may move twice at most, and a provider that already refused the whole account, or was already tried, is never asked again.

If the model that takes over cannot call tools, the calls and their results are folded into plain text instead — the steps keep their content and lose only their envelope, which is the difference between an answer and a request the new provider rejects outright. **Puter is the last resort** in that order, because it is the one provider that needs an account rather than a key, so a turn moved there for another reason would often fail on the sign-in instead.

### ⏸️ Continuing a turn that stopped

A tool loop that stops part-way — a provider 5xx, a timeout, or you pressing **Stop** — keeps everything it had already collected: the file it read, the search it ran, the listing it fetched. The transcript says so (`Kept 3 completed tool step(s)`), and the **Retry** button on that notice continues from where it stopped instead of asking the same question from the beginning, reusing every result already paid for. Stopping is deliberately treated the same as failing: a long tool loop you interrupt is usually one you want to steer, not one you want thrown away.

Three things bound that promise. A kept turn expires thirty minutes after it stopped, because a file read half an hour ago may have changed since. A turn too large to store alongside your saved chats is not kept at all — resuming is a courtesy, and losing the conversation list to it is not. And typing a *different* question drops it: the memo is keyed by the question, so nothing stale can leak into a new request.

<br>

### 🩹 Provider quirks the app works around

Puter fronts several providers, and they disagree in ways that surface as raw API errors. These are handled rather than passed through:

| Quirk | What the app does |
| --- | --- |
| Claude returns `message.content` as an array of blocks, not a string | Normalizes both shapes, so replies don't render as `[object Object]` |
| Claude asks for tools with `tool_use` blocks, not `message.tool_calls` | Normalizes to one shape the tool loop understands |
| Some Claude models reject the effort setting with a `thinking.type` error | Retries once without it, then hides the picker for that model |
| A reply object carries `model`, `id`, `usage` | Strips them before echoing the turn back, which the provider rejects otherwise |
| Codex model ids need an `openai/` prefix | Baked into the model list |
| A free-tier provider answers `429 Too Many Requests` — or a 5xx, or goes silent | The server retries with exponential backoff plus jitter, honouring any `Retry-After` the provider sends (up to 6 attempts), the page gives it one more try, and a provider that never settles reports its own message. A rate-limited NVIDIA burst rides itself out instead of failing every message. |
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

FreeAi4U is an unofficial client — it is not affiliated with OpenAI or Puter. Usage is billed to your own Puter account under Puter's terms, not this project's. Conversations are stored only in your browser's `localStorage` — the last 50, each capped at 200 messages. Clearing site data or switching browsers loses them; there is no server-side copy to restore from.

<p align="center">
  <sub>MIT licensed · Built on <a href="https://puter.com">Puter.js</a> · <a href="#contents">Back to top ↑</a></sub>
</p>
