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
- 📱 [On a phone](#on-a-phone)
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
      Ask anything and get a streamed, markdown-rendered reply at compact density, set to a <b>760px reading measure</b> inside a window you can actually see the edges of. Scroll up while a reply is still being written and it stays where you put it — a count of what arrived appears above the composer, and one tap takes you back down. Web research rides every turn — the model searches (DuckDuckGo + Wikipedia) and reads pages itself, citing sources, instead of guessing or sticking to your repos. Starts on a prompt hero with suggestion cards, copy or retry any response, Ctrl+P palette for models and actions, turn stats (model · seconds · chars) in the status bar, and System/Light/Dark plus tokyonight and gruvbox theme packs in the header — on every screen size, including the smallest phone. One **Session** surface (a chip in the composer, a button in the header) holds the skills this chat uses, the plan it recorded, and whether the next message is read as a drawing — the two floating cards and three composer switches they replace.
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
      Grouped under named sections — Model, Chat, Workspace, Skills, Account, GitHub, Server — with a chip rail across the top that jumps to any of them, so fourteen rows no longer read as one undifferentiated scroll. Default model, sign-in state, and a one-click "clear history" are all local; nothing leaves your browser.
    </td>
    <td valign="top">
      <h3>♿ Accessible by default</h3>
      Keyboard navigation on the model picker, a focus-trapped help dialog, and live-region announcements for new messages.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🖼️ Image generation</h3>
      Toggle the image icon next to the input to generate a picture instead of chatting. A labelled placeholder holds the spot while it renders (instant failures say so instead of flashing past). Click any result to zoom in, download, copy, edit with a brush mask, or make variations — every image lands in the Gallery view, newest first. <b>Drawing follows the conversation</b>: the service answering the chat draws, with the model the chat is on, and nothing else is asked of you — one picker, not two. Pictures go through the server's own image route, walking Nara → OpenRouter → NVIDIA → HuggingFace → OmniRoute → Ollama until one of them answers. <b>Puter is opt-in</b>, because its monthly credit allowance does not roll over and images are the dearest thing on it: switch on <b>Session → Image → Draw with Puter</b> for the occasional high-end picture, and a route that fails says so rather than quietly spending credits. The status line says which one did, and when every backend fails the message lists each one with what stopped it — see <a href="#image-providers">Image providers</a>.<br><br>
      <b>Ask for a size and get it.</b> Write it the way you would say it — <code>1536x1024</code>, <code>16:9</code>, a square icon, a tall phone wallpaper, a wide banner — and the request carries it to whichever service draws. A small chip appears in the composer as you type it (`16:9`, with the pixels behind it on hover), so the shape is visible while it can still be changed rather than only in the status line after the picture arrives; it stays away for a turn that is going to be a chat, because a hint about a size nobody will send is worse than no hint. Nothing on screen says the shape you asked for used to be ignored; that is what a request with no dimensions in it does, and every service has a default of its own. A picture that comes back a different shape says so on the status line (<code>asked for 16:9 (1536x864), drawn 1:1 (1024×1024)</code>), because the one thing you cannot do is tell from looking at it.
      <br><br>
      Attach a picture and say what you want changed — "make the sky purple", "add a hat", "recolour the car" — and the turn is read by the model, which decides whether that means draw something new or change what you gave it, and writes the prompt the image model actually receives (the same job the `<code>revised_prompt</code>` field does in OpenAI's API). No attachment and no need to re-upload: follow-up instructions edit <i>the last picture in the chat</i>, so "now make it look warmer" works the way it does in ChatGPT. A refusal comes back as what to reword rather than which backend failed.
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
      Puter needs no key at all. Add a key for Nara, OpenRouter, NVIDIA, Mistral or HuggingFace and they appear in a picker — so one running dry never stops the work. A local Ollama joins with just a base URL and needs no key, and a self-hosted OmniRoute gateway fronts hundreds of providers — including the `auto` router — behind one endpoint. Keys stay on the server.
    </td>
    <td valign="top">
      <h3>📱 Built for a phone</h3>
      One small-screen definition covers a portrait phone <b>and</b> a landscape one — the landscape case matters because at 844×390 the screen is <i>wider</i> than the 640px breakpoint, so keying everything to width alone left it with a mouse-sized UI. Both get off-canvas side panels with a scrim, 44px finger targets, 16px fields everywhere (so iOS never zooms a focused one), finger-sized rows, and no hover-only deletes. The composer's controls are two groups — actions (attach) and settings — so on a phone the settings move to a second row and the one button every message reaches for cannot scroll off the edge; every control in the strip is one height, and the model picker is first in the settings. Draw-by-force, auto-skills and the plan now live in one **Session** panel (one chip in the composer, one button in the header) instead of three controls in the strip. Plus safe-area insets, a Send key on soft keyboards, no double-tap delay, a layout that resizes with the keyboard instead of hiding behind it, wrapped links and capped image heights. Desktop keeps its own density: 30px controls, three columns, no forced 16px text.
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
| Switch model | Click the model pill in the composer, or open the **Models** tab |
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
| Jump to anything | `Ctrl+P`, or **Command palette** in the drawer — type a model name or an action (a phone has no Ctrl+P, so the drawer carries it too) |
| Find a setting | The section chips across the top of **Settings** — Model, Chat, Workspace, Skills, Account, GitHub, Server |
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
npm run smoke # optional clean-profile Chrome smoke check (Node 22+ and Chrome required)
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
| `NARA_IMAGE_MODEL` | *(e.g. `gpt-image-2.5`)* | Image-capable alias for the Nara image routes. Without one, Nara is not a candidate for drawing at all (the rest of the order still is), rather than passing on Nara's "Image model is required". Its upstream supports only a fixed set of dimensions — `1024x1024`, `1640x856`, `1024x1280`, `2048x1024` — and a size outside that list is swapped for the nearest one it offers, with the swap reported in `notes` rather than losing the picture (see [Image providers](#image-providers)). |
| `NARA_IMAGES_BASE_URL` | *(https://api-images.bynara.id)* | Override for the Nara images host (self-hosted endpoint, proxy, or tests). |
| `NARA_IMAGE_SIZE` | *(unset)* | The size a request is drawn at when the prompt asks for none. Read per service, so it never decides what another provider is asked for. |
| `IMAGE_PROVIDER` | *(unset)* | Pins **one** image provider for the whole deployment, honoured exactly: a chain that falls through behind a named service would spend a second key on a decision the operator already made. It outranks the conversation's own service, which the page sends as a mere preference. Set it to `nara`, `openrouter`, `nvidia`, `huggingface`, `omniroute` or `ollama`. Unset means the order below. |
| `OPENROUTER_IMAGE_MODEL` | *(google/gemini-2.5-flash-image)* | Which model OpenRouter draws with. Same key as its chat. |
| `OPENROUTER_IMAGES_BASE_URL` | *(https://openrouter.ai/api/v1)* | Override for OpenRouter's image host. |
| `NVIDIA_IMAGE_MODEL` | *(black-forest-labs/flux.1-schnell)* | Which NVIDIA model draws. |
| `NVIDIA_IMAGES_BASE_URL` | *(https://ai.api.nvidia.com/v1)* | Override for NVIDIA's image host — including a self-hosted visual-genai NIM. |
| `HF_IMAGE_MODEL` | *(black-forest-labs/FLUX.1-schnell)* | Which HuggingFace text-to-image model draws. A repo id, not a router alias. |
| `HF_IMAGES_BASE_URL` | *(https://router.huggingface.co/hf-inference)* | Override for HuggingFace's text-to-image task route. |
| `OMNIROUTE_IMAGE_MODEL` | *(unset)* | Which image model your gateway has connected. OmniRoute is never a candidate until one is named — it is your gateway's catalogue, and nothing here can know what is loaded there. |
| `OLLAMA_IMAGE_MODEL` | *(unset)* | A local image model (a `*-image` tag). Same rule: named or not offered. |
| `OPENROUTER_API_KEY` | *(unset)* | Adds OpenRouter — **free tier only**. The picker pins all 19 `:free` models (verified 2026‑09‑12), led by Nemotron 3 Ultra 550B, Inkling / Inkling Small (1M ctx), Nemotron 3.5 Lightning (1M ctx), Gemma 4 31B, Laguna S/XS 2.1 and North Mini Code. `OPENROUTER_FREE_ONLY=0` lifts the free-only gate. |
| `NVIDIA_API_KEY` | *(unset)* | Adds NVIDIA's hosted models — live catalogue (GLM, DeepSeek, Kimi, MiniMax, Devstral, Qwen, Nemotron, Gemma, Mistral, gpt-oss and the rest, as served). |
| `HF_TOKEN` | *(unset)* | Adds HuggingFace Inference Providers — one key across every serverless model on the Hub's OpenAI-compatible router. The free tier is monthly credits (~$0.10), so the picker pins the router's **full priced catalogue — 138 models, cheapest first** (verified 2026‑09‑12), led by the five **zero-priced** offerings (Qwen3.8‑27B, Ling‑3.0‑flash‑VL/Fin, Ternary‑Bonsai) that never touch credits, then gpt‑oss‑20b, Gemma 3, Llama 3.1 8B and up through GLM 5.3, DeepSeek V4 Pro, Kimi K3 and the 550B Nemotron. The `free` chip on huggingface.co/models is a community tag no provider honours — all 29 of those models were checked against the router and none is served. `HF_BASE_URL` overrides the router; `HF_MODELS` replaces the pinned list. |
| `MISTRAL_API_KEY` | *(unset)* | Adds Mistral. |
| `OLLAMA_API_KEY` | *(unset)* | Key for Ollama. A key alone means **Ollama Cloud** (`https://ollama.com/v1`) — the hosted catalogue appears. A key with no `OLLAMA_BASE_URL` never touches a local install; to reach one, set `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`) and the live local catalogue appears — GLM, DeepSeek, Kimi, Qwen, MiniMax, Devstral, Nemotron, Mistral, gpt-oss, Muse Glimmer and the rest, whatever the server actually serves. The app also accepts a Railway root URL and falls back from OpenAI-compatible `/v1/models` to native `/api/tags`. |
| `DEEPGRAM_API_KEY` | *(unset)* | Adds Deepgram. Speech service; its chat endpoint answers 404. |
| `ASSEMBLYAI_API_KEY` | *(unset)* | Adds AssemblyAI. Speech service; its chat endpoint answers 404. |
| `YOUCOM_API_KEY` | *(unset)* | Adds You.com. Search and research service. |
| `ANTIGRAVITY_BASE_URL` | *(unset)* | Adds **Antigravity** through an OpenAI-compatible proxy — Claude Opus / Sonnet and Gemini 3, using a quota your Google account already has. Set it or `ANTIGRAVITY_API_KEY`. See [Antigravity](#antigravity). |
| `ANTIGRAVITY_API_KEY` | *(unset)* | Key for the Antigravity proxy, sent as `Bearer`. Required by the current proxy — empty means *no* auth header at all, never a bare `Bearer`, and the proxy will 401. |
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

**A mode is a tool surface, not a tone of voice.** Chat and Plan are not asked nicely to behave — the write tools are **not sent to the model at all**, and a call that arrives anyway is refused by the runner with a message naming the mode and how to leave it. That is the difference between a mode that can be talked out of its rules and one that cannot.

| | Research | Workspace | Repos | Task list | Skills |
| --- | --- | --- | --- | --- | --- |
| **Chat** | `web_search`, `web_fetch` | read, search | read, search, commits | — | — |
| **Plan** | the same | the same | the same | `task_*` | `use_skill` |
| **Build** | the same | **+ write, edit, delete** | **+ commit, delete** | `task_*` | `use_skill` |

The split follows opencode, which is where the three modes come from: **Chat researches** (search, read pages, cite primary sources, answer — no plan document, no commits), **Plan investigates and proposes** but cannot change anything, and **Build executes** the agreed plan with the write tools in hand. The task list is deliberately a Plan-mode tool: writing down a plan is the point of the mode, so the task tools are not in the write group and are not refused. A tool in no group is offered in every mode — the table is a lock on writes, never on a read tool added later.

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

**Pinning a skill to a chat.** Auto-picking is per request and forgotten by the next question. The **Session → Skills** tab (one chip in the composer, one button in the header; typing `/` and a name works too) does the other thing: it pins a skill to the **conversation**, so `/ponytail` on the first message is still applying on the ninth — in Chat mode too, where no auto-skills fire at all, and with auto-skills switched off entirely. A pinned skill is saved with the chat, survives a reload, and a new chat starts with none of them, so a choice is never inherited by a conversation that did not make it. Up to five at once; past that the oldest is turned off and the app says which. Pinned chips sit above the composer with an `×` each, the picker is searchable and toggles items on and off, and a skill the model loads itself with `use_skill` is pinned too, visibly — otherwise the next turn would fetch the same text again.

**Offers, learned from what you pin.** Pinning the same skill in two *different* chats is a habit, and once a skill is one the app offers it while you type — a dashed `Try ponytail?` chip with **Add** and `×`, scored against the text being written so accepting applies to *that* request. Declining is remembered for the chat. Four things keep it from becoming a suggestion engine with opinions: habit is counted by **chat** rather than by click (un-pinning and re-pinning in one conversation is one intention), **only deliberate pins count** (a skill the model loaded for itself with `use_skill` is the app's doing, not a preference), the offer is **a question and never an action** — a skill that switched itself on would spend prompt budget on every request of a chat that never asked for it — and the habit store is bounded to the most recent 60 skills. It is browser-local (`freeopenaiSkillUsage`), so it does not travel between devices and carries nothing identifying about the requests themselves.

**Which skills are answering.** The Session panel's Skills tab lists every skill that has applied to this conversation, tagged `pinned` or `auto` and showing how many requests each rode along with — the picker above it filters the installed library with a search box, and the auto-skills switch sits beside the list it governs. The log exists because the router's choices are invisible by design — a skill leaves no trace in the reply — so an answer that came out oddly should be traceable to a method rather than guessed at. Tap an `auto` row to pin it, a `pinned` row to let it go. The record is per conversation and lives in your browser (`freeopenaiSkillUse`); a new chat starts it empty.

**Commands.** Typed into the composer: `/help`, `/skill <name>`, `/skill off <name>`, `/skills`, `/mode chat|plan|build`, `/clear`. Or skip the verb: `/ponytail` and `/caveman` are the shorthand, since typing the name is how people actually reach for a skill. Anything else that starts with a slash — `/usr/bin is missing` — is sent to the model as the ordinary message it is; the app never swallows text it did not understand. Commands are answered locally, so opening the skill picker costs nothing.

- `GET /api/skills` — the installed catalogue (source, name, description)
- `GET /api/skills/content?name=<skill>` — one skill's full SKILL.md
- `SKILLS_CACHE_TTL_MS` — cache lifetime override (default 6h)
- **`GITHUB_TOKEN`** — *set this if the picker ever looks empty.* The catalogue is read from each repo's git tree, and GitHub allows **60 unauthenticated tree requests an hour per address**. Eleven sources spend that in about five refreshes, and the budget is per address — so on a container host, an office or a VPN it is shared with everyone behind it, and the library goes quiet part way through the day. A token raises the same limit to 5000, and you already have a GitHub account if you are using the repo tools. The refusal is now logged once per refresh with the variable named, instead of leaving a picker that is simply empty.
- Add your own in `SKILL_SOURCES` (chatlib.js): `dir` is the folder holding the skills and `pick: [...]` narrows a big repo to a chosen few. Nesting and root-level `SKILL.md` files are handled; the name comes from the folder holding the file.

### 🐙 Working with GitHub

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (from a [GitHub OAuth App](https://github.com/settings/developers) whose callback URL is `https://<your-app>/api/github/callback`) and a **Connect GitHub** row appears in Settings.

Once connected, the model can work with your repos directly:

| Tool | What it does |
| --- | --- |
| `github_list_repos` | Lists public repos across every connected account |
| `github_list_files` | Lists a folder, so it can find a path |
| `github_read_file` | Reads one file |
| `github_search_code` | Searches code across a repo, so it finds the right file instead of guessing paths |
| `github_list_commits` | Lists recent commits, with messages and dates |
| `github_commit_file` | Writes and commits — **always asks you first** |
| `github_delete_file` | Deletes a file and commits the removal — **always asks you first** |

Up to **three accounts** can be connected at once. Which one acts on a repo is resolved in a fixed order: an explicitly named account, then the repo's owner, and otherwise it refuses and asks — it never tries tokens in turn until one works, because guessing wrong on a write means committing under the wrong identity.

> Untick **Expire user access tokens** when registering the OAuth App. Refresh tokens aren't implemented, so an expiring token would silently disconnect after 8 hours.

### 🗂️ The workspace

Every chat can also read and write a small **workspace**: a flat set of text files the model keeps notes and drafts in.

| Tool | What it does |
| --- | --- |
| `workspace_list_files` | Lists a folder, with the size of each file |
| `workspace_read_file` | Reads one file |
| `workspace_search_files` | Greps the workspace, with the line each match is on |
| `workspace_write_file` | Creates or replaces a file — **always asks you first** |
| `workspace_edit_file` | Replaces one exact string in a file — **always asks you first** |
| `workspace_delete_file` | Removes a file — **always asks you first** |

`workspace_edit_file` exists because of what a whole-file write costs: re-sending a long file to a model to change one line is expensive and the model often truncates it. An edit sends the old text and the new text, and the change is refused if the old text appears zero times or more than once — an ambiguous anchor would silently edit the wrong one.

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

The list is the **Plan tab of the Session panel**, a glass pop-up over the chat rather than a column of the layout, because a plan you have to go and open is a plan nobody keeps current. Each row carries its id and what it still waits on, its note opens in place, and a hairline at the top fills as tasks finish. Rows order themselves — in progress, then to do, then blocked, then done — so the next thing to pick up is the first thing you read. Tick the circle to finish a row, `×` to drop it. The panel folds away with the Session button in the header or the chip in the composer, becomes a drawer over the chat on a phone, and its open/closed state and section are remembered per browser. Escape closes it, but a click elsewhere deliberately does not: the plan is meant to be read while the work happens.

It is kept in the browser like the workspace and rides in the system prompt when it isn't empty, so a later turn — or a different chat — can pick the work up where it stopped. **When a reply arrives while the list it touched this turn still has items open, the app hands it back to the model once and asks it to finish them or say plainly which are open**, because "done, all sorted" reads as complete while three unticked rows sit beside it. The check is armed only by a turn that actually wrote to the list, so an old open task from another conversation never interrupts an answer about something else.

No approval is asked for a change: it alters nothing outside the conversation, and a dialog in front of every status change would make planning unusable. **Settings → Tasks** shows the count and points at the panel rather than repeating the list, since two renderings of one list is two places for it to be wrong.

### ⬇️ Reading while it writes

A reply that arrives while you are reading something above it is the case every streaming app gets wrong. This one used to write the scroll position from ten places, nine of them unconditional, so a streamed reply dragged you back to the bottom roughly every 40ms and you could not read anything until it finished. There was also no "am I at the bottom?" answer anywhere, which is why a scroll-to-bottom control could not exist: it had nothing to be drawn from.

The policy now lives in `chatlib.js` as rules that are tested without a browser — *at the bottom* means within 120px of the newest line, a transcript too short to scroll is always at the bottom, and only two things may move you against your own scrolling: **the message you just sent**, and **something you asked for** (tapping the pill, opening a saved chat). Everything else — a streamed chunk, a tool notice, a picture finishing — obeys the pin. One seam (`appendToTranscript`) is where every arrival goes, so this is a decision rather than an accident of which function appended it.

When output lands while you are reading above it, a pill appears above the composer: **`3 new`** when there is a count to give, `New output` while a turn is still running, `Newest` when you have scrolled up in a reply that has stopped growing. It is anchored to the reading column rather than the window edge, so on a wide screen it sits where the text is.

Two details that took a real browser to find. Off-screen bubbles are laid out lazily for scroll performance, so the bottom of the transcript is a *moving* maximum: a single write to it lands a few lines short, and a jump therefore settles over a few frames, bounded so it can never spin. And a **rotation** re-lays the whole transcript, which fires a scroll event with a clamped position that reads as "the reader scrolled away" — so the pin is read *before* the re-layout and restored after it, or turning your phone would drop you into the middle of an old reply.

**A turn says what it is doing.** The three dots said "busy", which is the same for a two-second lookup and a stuck provider; beside them a label now names the step — `Thinking…`, the tool being run, `Writing the reply…` — and goes away with the row.

**Generated pictures are kept, not just described.** Every Puter image arrives as a `data:` URL, with the whole picture inside the string, and history kept only `http(s)` links — so the picture was dropped the moment it was saved. The bubble showed it (still in memory) while the Gallery, which reads saved history, had nothing but the prompt. A generated image is now re-encoded down to a 1024px JPEG, stored, and the newest eight per chat are kept; a remote link is left as it stands, because those bytes were never ours. When browser storage fills up, **the pictures go before the history does** — a chat with no image is still a chat, a chat with no history is a loss — and every step of that is a rule in `chatlib.js` with its own test rather than a try/catch nobody reads.

**An image request is read, not matched.** The first version decided with a regex. If the words contained no verb-and-noun pair from a fixed list, the turn fell through to a vision chat — so "make the sky purple" with a photo attached answered *about* the photo, and never reached an image model at all. And whatever survived that filter was sent on as the prompt verbatim, so "make it warmer" arrived at the image model with nothing to warm. One small model call now reads the turn and returns `{"action": "generate" | "edit" | "chat", "prompt": "…"}` — the action ChatGPT gets from its image tool's `action: "auto"`, and the rewritten prompt it gets back as `revised_prompt`. The keyword rules stay underneath as a *floor* rather than a fallback, because the bug they fix is worth keeping fixed: with a picture attached, no reading of a request may turn an edit into a fresh text-only render (the poster-of-a-car bug). A plan may only move a turn *into* image work. The call is made only for turns that could plausibly be image work — something attached, a draw request, a picture already in the chat, or the image toggle — so an ordinary chat message never pays for it, and any failure at all leaves the keyword decision in charge (`resolveImageAction` in `chatlib.js`, tested without a browser).

**Follow-ups edit the last picture, and one pipeline draws them all.** "Now make it look realistic" has no attachment to work from, and re-uploading your own output by hand is not something anyone does — so the newest picture stored in the chat is the source when nothing is attached, which is multi-turn editing. Because that source can be a remote link rather than a data URL, the edit route now fetches it (through the same private-address guard the page reader uses, since the URL comes from the browser). The composer, the brush editor and the Variations button all go through one chain, which is what makes that true everywhere at once: the brush editor used to POST straight at the server route, so a Puter user with no Nara key painted a region and got "Image editing needs NARA_IMAGE_MODEL" — naming a backend they were not using. A painted mask now reverses the chain (Puter has no mask field at all), is scaled to the source picture's own size rather than the 640px canvas it was painted on, and if the route cannot take it the brush is dropped and Puter is asked without it — with the drop said out loud instead of silently changing the result.

**The right model, at the right quality.** (Puter draws only when **Draw with Puter** is on; this is what it does when it is.) Puter draws at `low` when nothing asks for better, and nothing did — every picture this app produced was rendered at the bottom tier while paying the same credits. `quality: "high"` is now asked for explicitly, on both backends. The model is picked by the job too: Puter documents **Sunburst** for editing precision and **Flare** for fast generation, where the app pinned `gpt-image-2`/`gpt-image-1.5` for both. Edits name the picture through `input_images`, the field Puter's docs identify as the one that routes through the image *edit* endpoint, rather than `input_image`, a shorthand whose silent fallback to text-to-image would hand back a plausible new picture where an edit was asked for — a failure that looks like success. A refusal (`moderation_flagged` and the prose wordings for it) ends the chain immediately and says what to reword, because the same prompt asked of another model or another service can only come back refused again.

**Every key draws, not just Nara's.** The image route was Nara's and only Nara's: an operator with an OpenRouter, NVIDIA or HuggingFace key could chat on it and not draw, and asking for a picture answered *"Image generation needs NARA_IMAGE_MODEL"* — naming a service they had not configured. Each provider now declares how it draws in an `image` block of its own (an OpenAI-shaped body, HF's `{inputs, parameters}` task route, or NVIDIA's `{prompt} → {artifacts}` GenAI shape), the route walks the order and takes the first service that answers with a picture, and every answer is normalized to the OpenAI payload the browser already reads. Which one drew comes back with the picture and is said on screen, because that is the one fact about an image nothing else can recover. The order falls through on anything that is a fact about *that* service — a forbidden key, a model the account cannot reach, a bill, a 5xx, a dead socket — and stops on a refusal, since every service is being handed the same prompt. See [Image providers](#image-providers).

<a name="antigravity"></a>

### 🛰️ Antigravity (Claude Opus and Gemini through a proxy)

Antigravity models are reached through an OpenAI-compatible proxy that you run yourself. The gateway is [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (see `deploy/cliproxyapi/` for the Railway service): it holds the Google accounts and serves `POST /v1/chat/completions` in OpenAI's shape, so this app can talk to it as an ordinary provider. (It replaced the archived `frieser` proxy, whose retired model names kept failing.)

The app needs no Google credentials of its own — the proxy owns them. Set the base URL and the key, and the provider appears. The key is required: unlike the old proxy, this one answers nothing without it.

```bash
# terminal 1: the proxy (it opens on http://localhost:8317)
# from a CLIProxyAPI checkout: go run ./cmd/server -config config.yaml
# (or the Docker image this repo builds in deploy/cliproxyapi)

# terminal 2: this app, pointed at it
ANTIGRAVITY_BASE_URL=http://localhost:8317 ANTIGRAVITY_API_KEY=<the proxy's api key> npm start
```

`Antigravity` then appears in the provider picker with Claude Opus 4.6 thinking, Sonnet 4.6, Gemini 3-flash, 3.1-pro-low and the pro-tier `gemini-pro-agent` — every pinned id is probed against the live service before it ships, and retired upstream names stay out so no picker row can only fail. Both `/v1` and a bare `http://host:port` work as the base URL — the version segment is added when it is missing, and a non-default port goes in the URL.

| Setting | Value |
| --- | --- |
| `ANTIGRAVITY_BASE_URL` | `http://localhost:8317` (local) or the URL of wherever the proxy runs |
| `ANTIGRAVITY_API_KEY` | **Required** — the proxy's `api-keys` value, sent as `Bearer`. Empty means *no* auth header at all, never a bare `Bearer`, and the proxy will 401. |
| `ANTIGRAVITY_MODELS` | Optional comma-separated override when your proxy's model names differ from the pinned list |

Until that variable (or `ANTIGRAVITY_API_KEY`) is set, **Antigravity does not appear in the picker at all** — the provider stays out of it entirely rather than showing up and failing, so "I can't see the Opus models" on a deploy almost always means the variable is missing.

**Running the proxy alongside a deployed app.** [`deploy/cliproxyapi/`](deploy/cliproxyapi/) builds the gateway with its accounts seeded from a variable and explains the Railway service: the variables, the private-network base URL, and how to read the logs when it does not come up. It exists because a hosted instance cannot create accounts — the proxy's OAuth is a localhost loopback — so they are signed in once locally and carried over.

**A local proxy is not reachable from a deployed app.** `http://localhost:8317` from the Railway container means the container itself, where no proxy is running. So either run this app locally against the proxy (the command above), or put the proxy somewhere the app can reach and point `ANTIGRAVITY_BASE_URL` at it. Don't publish the proxy to the open internet without its API key set: it holds your Google accounts, and anyone who finds an unkeyed URL is spending your quota. Put it behind your own authentication, or reach it over a private network. When the proxy runs as a service on the same Railway project, point `ANTIGRAVITY_BASE_URL` at the private-network name — `http://antigravity-proxy-v2.railway.internal:8317` for a service named `antigravity-proxy-v2` — and set `ANTIGRAVITY_API_KEY` to the same value as the service's key. You'll know the app is still set to an old tunnel/URL when a chat fails with `ENOTFOUND: the host name did not resolve`.

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

**Quick-tunnel URL rotates on every restart.** When the gateway is reached from a deployed app through a local quick tunnel, the `trycloudflare.com` URL changes whenever the cloudflared container is recreated (a reboot, or `docker compose up --force-recreate`). After the machine restarts, read the new URL from `docker logs app-cloudflared-1` (look for `https://…trycloudflare.com`) and update `OMNIROUTE_BASE_URL` on Railway.

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
| **A classifier does not pay flagship rates** | Asking for a picture in passing — with something attached, or in plain words — runs one small call first that decides whether the turn is a drawing, an edit or a chat, and writes the prompt the image model receives. That is a classification, not the conversation, and it now runs on the cheapest model the service lists rather than on your flagship. An ordinary chat message never makes the call at all. A planner that fails is simply no plan, and the keyword decision stands, so the cheap model risks nothing. |
| **A work step goes to a cheaper model** | A tool turn is not one call but up to twelve, and each one re-sends the whole conversation — so the rounds that only read what a tool returned are the expensive ones. Those steps are sent to the cheapest model the provider lists, while the model you picked plans the turn and is the one the app falls back to the moment a step goes wrong. Below, and switchable in **Settings → Cheaper models for tool steps**. |

### 🪜 Which model answers which step

A tool turn has three kinds of call, and they are worth different amounts of money. The **plan** is the first call, with nothing read yet, so it decides what the turn is even going to do. A **work** step is any later call that has tool output in hand: it reads the result and chooses the next move. The **answer** is a call made with tools withheld — the reply you are waiting for.

Only the work step moves. It is also the one that costs the most, because by then the whole conversation is in front of the model and a tool call is all that comes back. The choice is by published price — free first, then the cheapest input-weighted cost, since a round of this size is mostly input — and only among models that can actually take tools. Where a provider publishes *no* prices at all, which is the case for the allowance-backed ones (Nara, NVIDIA, the Antigravity proxy), the small model of the family is used instead, by name. That is a heuristic and it is last: any published price beats it. An unpriced model is never treated as free — the router refuses to guess rather than hand every step to whichever premium model happens to publish nothing. The same catalogue as the picker is filtered, so an embedding or image model is never a candidate.

The trade is real and it is measured by the people who designed this shape: NVIDIA's [Switchyard](https://github.com/NVIDIA-NeMo/Switchyard) reaches 72.7% on Terminal-Bench 2.1 at $68.19 against a 76.0% / $98.06 baseline — **30.5% cheaper for 3.3 points of accuracy**. So it is a switch, and the app is on the record about it: the first routed step of a turn says so in the conversation and names *both* models, and the status bar reports the model that actually produced the reply rather than the one the picker shows. Since a work step can be the step that answers, that is often the cheaper model — which is the honest consequence of the trade, not a bug.

Four things send a step back to your model, and all four are observed rather than guessed: the cheap model **refused** that step (a refusal is never allowed to move your selection — it only takes that model out of circulation), it came back with **nothing**, it sent **arguments the tools cannot use** (which `parseToolArgs` has to swallow to keep the turn alive, and which was invisible until now), or it **asked again for something it already had**. The first is re-asked immediately on your model; the others hand the *next* step back, because that is the one that has to make sense of the result. A whole turn carrying an image is never routed at all: the model was already switched to one that can read the picture.

Two things outside that loop also move. The **image planner** is a classifier rather than a step of the conversation, so it is not held to the work stage — it is ranked the same way, among models that need not take tools at all. And **Puter now honours routing**, which it did not: the browser branch read the model you had picked and ignored the routed one entirely, so every saving the switch describes was silently skipped on the one provider where a step is paid for in credits out of a fixed monthly allowance. Puter publishes no prices, so several of its models tie as "the small one in the family"; the app's own default (`gpt-5.4-nano`) breaks that tie rather than whichever id happens to sort first.

When a question fails part-way through a tool loop, the answers it already collected are kept — so retrying replays those lookups instead of buying them a second time, while a genuinely new question starts from nothing. The status bar reports what the provider cached, so the saving is visible: `gpt-5.4-nano · 3s · 812 chars · 120 tok · 12.4k cached`. A provider that caches nothing reports nothing.

<a name="image-providers"></a>

### 🎨 Appearance

The palette is a near-neutral grey ladder rather than white-on-black: the chrome (the chat rail, the top bar, the status bar) sits one step **darker** than the conversation, and the composer and the user's bubble sit one step **above** it — `#171717` / `#212121` / `#303030` in dark, `#f9f9f9` / `#ffffff` / `#f4f4f4` in light. Nothing is pure black in dark mode and nothing is pure white in light mode, which is what stops a long transcript from reading as a headlamp, and the composer is lifted off the transcript rather than sharing its grey.

The header's sun/moon button opens a picker with **System / Light / Dark** plus the two theme packs (Tokyo Night, Gruvbox). It names the three the way ChatGPT does instead of cycling, because a cycle is the wrong shape for five: reaching Gruvbox from Tokyo Night meant passing through every other theme on the way. System follows the OS and keeps following it while the tab is open. The choice is stored as `puterChatTheme` in your browser, and the browser's own chrome colour (`<meta name="theme-color">`) follows it, so the status bar is not a black frame around a grey app.

**The toggle is on every screen size.** It used to be the first control dropped below 380px, on the reasoning that Ctrl+P still reaches it — which is no reasoning at all on a phone, where the appearance of the app is the one setting you cannot get to any other way. On a phone the picker opens as a sheet at the bottom of the screen; on a desktop it is a dropdown anchored under the button, right-aligned and pulled back inside the viewport. `npm run smoke` now asserts, at 360, 390, 844×390 and 1440 wide, that the toggle is visible, on screen, that the picker opens onto the viewport with all five rows usable, and that every icon button in the header is the same size at that width.

### 📱 On a phone

The composer's control row is where a phone runs out of width. It holds five things — the model, the provider, the effort, the mode, and the Session chip — which want 383px at their desktop size, and a 390px screen gives the row 350px. It used to overflow by that difference into a horizontal scroller nothing signalled: at 360px the mode chip sat *entirely* past the right edge, with not even a sliver poking out to suggest it was there.

The cause was a cascade bug rather than a missing rule. Three clamps existed — 84px at 640, 68px at 380, 92px in landscape — and **none of them ever applied**: they were written as `.model-trigger span#modelLabel` while the desktop rule was `.composer-controls .model-trigger #modelLabel`, and one id with two classes beats one id with one class and an element. A media query adds no specificity of its own, so every phone rendered the desktop widths. Nothing caught it: eslint does not read CSS, the unit tests do not render, and the smoke test only checked that the controls existed.

What the row does now, in order: **tighten, then wrap.** Padding comes off the chips and the decorative glyph comes off the model button — the labels stay, because "Chat" and "Session" are the whole content of those chips, and the chevron stays because it is what says the button opens — which gets the common case onto one line at no cost in height. When that is still not enough, at 320px or with a long provider name, the row wraps rather than hiding its tail. Hiding a control was the wrong trade: the provider picker is the only way to change service, since the model dropdown lists models alone. The threshold is 440px, taken from the content rather than a round number, which covers every phone in portrait from 320 to 430.

**Landscape gets its second row back as height.** The shared phone layout puts the attach button on its own line so it cannot be pushed off the edge, which is right at 360px. In landscape the problem is the opposite one: the row needs 421px and has 808px, so the split bought nothing and cost 44px of a 390px viewport. The transcript grows from 167px to 211px — about a quarter more of the conversation — and the split is kept below 641px wide, where the original reasoning still holds.

Two checks now make this class of bug hard to reintroduce. `npm test` walks the stylesheet, scores specificity, and fails when a declaration inside a `@media` is beaten by one outside it — ignoring rivals that need a state, since `.chat-shell.history-hidden .history-sidebar` only applies while the sidebar is closed and cannot be said to win. And `npm run smoke` measures every control in the row at all five viewports rather than asking whether it exists; it caught the 390px case immediately, which the existence check had been passing for months.

### 🖼️ Image providers

Every provider this app chats on can also draw, because they are all asked the same question through the same route: the server's `/api/llm/images/{generations,edits}`, behind which sits an order — **Nara → OpenRouter → NVIDIA → HuggingFace → OmniRoute → Ollama** — with the chat's own service moved to the front of it. There is no second picker to configure: a request for a picture is still a request to whoever is answering the chat.

**Puter is the one service that is not in that order unless you put it there.** It draws in the *browser* on the visitor's own account, which costs the operator nothing — but a Puter account gets a fixed monthly allowance of credits that does not roll over, and images are the dearest thing on it, where every other provider here runs on a free key. So a drawing nobody pointed at Puter goes to the route, and a route that fails says so rather than quietly billing the allowance: an automatic fallback is exactly how a month's credits disappear into pictures nobody chose to pay for.

Being *on* Puter for chat is not that choice either. Chat there is cheap and images are not, so the picker that decides the conversation must not also decide to spend credits on every drawing. The switch is **Session → Image → Draw with Puter**, off by default and remembered per browser; while it is on, the session chip says `Puter images` so it cannot be left on by accident. With it on, Puter draws first and the route stays behind it — except for a painted brush mask, which the route gets regardless, because Puter's image options have no mask field at all and asking it first would silently edit the whole picture instead of the region you painted.

The chat's model is a *preference* there, not a pin. Most chat models on these services can draw; the ones that cannot answer with a 400, which is never billed, so the provider is asked once more with the image model it would have picked by itself before the order carries on. The chat's model id is offered only to the provider the chat is on — ids come from per-provider catalogues, so an OpenRouter name handed to Nara is a 404 dressed up as a bad request. The first configured service that answers with a picture wins, and anything that is not a refusal — a key that is not allowed, a model the account cannot reach, a bill, a 5xx, a dead socket — moves to the next one. A *refusal* stops the whole chain, because every service is being handed the same prompt and paying a second key to hear it refused again is not a retry.

Ordering that way means an `OPENROUTER_API_KEY` alone draws, with no `NARA_API_KEY` in sight — which is the bug this replaced: the route used to be Nara's and only Nara's, so a key that could chat could not draw, and the answer named a service the operator had not configured.

What differs between the services is the shape of the request, and each provider declares its own in its `image` block rather than the route branching on a name:

| Shape | Request | Answer |
| --- | --- | --- |
| `openai-images` | `{model, prompt, size?, quality?, n?}` | `{data:[{b64_json\|url}]}` |
| `hf-inference` | `{inputs, parameters:{width, height, num_images}}` | the picture's own bytes |
| `nvidia-genai` | `{prompt, mode:"base", aspect_ratio?}` | `{artifacts:[{base64}]}` |

Every answer is normalized to the OpenAI images payload, because that is what the browser already reads — one reader for three services is one place a picture can go missing. NVIDIA tries the NVCF GenAI shape first and the OpenAI-compatible one on a 404, since a self-hosted visual-genai NIM documents the second while the hosted FLUX models speak the first.

**Edits** are the same shape question asked once more. Nara takes multipart file parts (`image`, optional `mask`, plus `model`/`size`/`quality`/`n` as fields); OpenRouter takes the source as an `input_references` URL on the generations endpoint. A painted brush mask is a file part or it is nothing, so a service that takes a reference gets the edit *without* the mask and says so in the response's `notes` — dropping it silently would edit the whole picture while the user watched a region they drew being ignored.

**`size` comes from the request, not from a control.** There is no size picker in the composer, so the prompt is where it is read from — `1536x1024`, `16:9`, `square`, `tall`, `wide`, `landscape`, `banner`, `poster` — with pixels beating a ratio and both beating a shape word, and nothing at all for a prompt that asks for no shape. The three services want it three ways (an OpenAI pixel pair, Puter's `ratio: {w, h}`, a Together model's width/height), so one reading is held and answered per service rather than re-derived in each path. An *edit* reads only what was spelled out — "make the poster blue" is about a picture that already exists, and reshaping it because the sentence contains a shape word would crop something nobody asked about.

**A size a service does not offer is swapped, not refused.** Nara declares four dimensions. Handing it a fifth used to mean the draw failed on a service that was ready and had credits, refused for a reason nobody typed; it now draws the nearest shape it does offer and says so in the response's `notes` (`asked for 1536x1024 — Nara draws 1640x856`), which reaches the status line. `quality` and `n` stay preferences, and a 400 that arrives while one was sent buys exactly one more attempt without it. A 400 is never billed, which is what makes that retry free.

**The route says who drew.** Every successful response carries `provider`, `providerLabel`, the `model` and any `notes` alongside the pictures, because that is the one fact about an image that cannot be recovered from the image afterwards. The page turns them into the status line (`Image ready — OpenRouter`). `GET /api/llm/images/providers` reports which services are ready, with which model, and what each is missing when it is not — it is the operator's view of the order, and the reason a failure can name variables that would actually fix it rather than a service that was never configured.

**Saving a picture saves the picture you got.** The Download button on an image (in the message row, and again in the lightbox) offers **PNG, JPG or PDF**, and all three re-encode at the bitmap's own pixel dimensions — never a fixed square, never a "reasonable" 1024px. That was the bug: a picture drawn at 1536×1024 could only be saved as a 1024×1024, because the lightbox's `<a download>` could hand back the bytes it was given and nothing else. The menu prints the true size above the format list (`Save at 1536 × 1024`), so asking for a size and not getting it is visible *before* you save rather than after.

- **PNG** keeps alpha; **JPG** (quality 0.92) is smaller; **PDF** is one page whose page *is* the picture — one point per pixel, no sheet behind it, no margin around it. A4 with a 24pt margin printed the drawing as a stamp in the middle of a white page, which is what "the PDF is the size I asked for" was about. A picture larger than 2400pt on its longest side gets a proportionally smaller page rather than a four-foot one; it still holds nothing but the picture.
- The PDF embeds the JPEG untouched as a `/DCTDecode` stream rather than re-encoding it: an image that has already been through one lossy pass should not take a second one on the way to the printer. It is written by hand — five objects, a fixed-width xref table — because that is smaller than the dependency.
- The filename carries the dimensions: `freeai4u-a-neon-tokyo-street-1536x1024.jpg`. Whether the picture came back at the size you asked for is the first thing a folder listing should answer.
- A picture hosted on another site cannot be read into a canvas without CORS. Rather than refusing the save, the app hands the URL to the browser and says so — `opens as-is instead of converting to PDF` in the status line.

The generation overlay was rebuilt at the same time. It used to count seconds toward a fifty-five second budget and grow a progress ring toward it; both were fiction, since a generation that finishes in nine seconds and one that times out at fifty-five drew the same bar. What is left is a machine resolving — a floor grid drifting toward the viewer, three rings turning against each other, a volumetric sweep, motes rising through the well, a hexagonal iris opening and closing — with a stage word cycling on its own stagger rather than a `setInterval`. Under `prefers-reduced-motion` it holds still and shows one word, instead of inheriting the page-wide 1ms animation duration, which turns an infinite animation into a strobe.

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

**What a load actually transfers.** The whole UI is one file — a 520KB `index.html` — plus a 208KB `chatlib.js`, and both used to go out raw on every visit. Most of that is whitespace and the long comments this codebase is written in, so it compresses about seven to one: a first load now transfers **175KB instead of 728KB**. Brotli when the browser takes it, gzip otherwise, identity when it takes neither — parsed rather than pattern-matched, because a `;q=0` is a refusal and sending a body the client cannot read is worse than sending a big one. Each encoding is produced once and kept in memory, keyed on the file's mtime and size, so a 520KB compress does not happen per request and a deploy invalidates it without anyone remembering to.

Every static response also carries an **ETag**. `Cache-Control: no-cache` is right here and is not what it sounds like — it means revalidate before reuse, not never store, which matters because the whole UI ships inside `index.html` and a copy reused blind would run yesterday's code after a deploy. But with no validator to revalidate *against*, every reload was a full download of bytes the browser already held. Now an unchanged deploy answers `304` with no body at all. `npm test` checks this over a real socket: that the compressed bodies decode back to the exact page, that `Content-Length` describes the encoded body rather than the original, that `HEAD` agrees with `GET`, that the single-page fallback shares the page's validator, and that a missing `.js` is still a 404 rather than HTML that would fail to parse.

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
