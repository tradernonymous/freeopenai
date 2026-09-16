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
  <img src="https://img.shields.io/badge/tests-970%20passing-22c55e?style=for-the-badge" alt="970 tests passing">
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
- 📲 [The Android app](#android-app)
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
      Ask anything and get a streamed, markdown-rendered reply — headings, tables, task lists, strikethrough, autolinked URLs, nested and continued lists, a safe HTML subset (collapsible details, highlights, links), and syntax-highlighted code blocks (bare fences highlighted by language detection) with a language chip, copy button, and sandboxed live preview for HTML — at compact density, set to a <b>760px reading measure</b> inside a window you can actually see the edges of. Scroll up while a reply is still being written and it stays where you put it — a count of what arrived appears above the composer, and one tap takes you back down. Web research rides every turn — the model searches (DuckDuckGo + Wikipedia) and reads pages itself, citing sources, instead of guessing or sticking to your repos. Starts on a prompt hero with suggestion cards, copy or retry any response, Ctrl+P palette for models and actions, turn stats (model · seconds · chars) in the status bar, and System/Light/Dark plus tokyonight, gruvbox and green theme packs in the header — on every screen size, including the smallest phone. One **Session** surface (a chip in the composer, a button in the header) holds the skills this chat uses, the plan it recorded, and whether the next message is read as a drawing — the two floating cards and three composer switches they replace.
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
      Attach a picture, a PDF/DOCX document, or any text file — code, config, logs — and it rides along with your next message. What it is decides how it attaches, not what it is named, and the chip says what it will cost the request (`~25.0k tokens`) before you send it.
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
      Just describe the picture — <i>"draw a neon Tokyo street at 16:9"</i> — and it is drawn instead of answered. Nothing needs switching on: <b>Session → Image → Read the next message as a drawing</b> is there for the turn whose wording could go both ways, which is the exception rather than the rule. A labelled placeholder holds the spot while it renders (instant failures say so instead of flashing past). Click any result to zoom in, download, copy, edit with a brush mask, or make variations — every image lands in the Gallery view, newest first. <b>Drawing follows the conversation</b>: the service answering the chat draws first, and the model the chat is on is offered to it as a preference before it falls back to that service's own image model — one picker, not two. Puter, when you switch it on, draws with the image model its own list names for the job — **Sunburst** to edit, **Flare** to draw — because its images endpoint takes an image model and the picker beside it offers chat ones. Pictures go through the server's own image route, walking Nara → Cloudflare → OpenRouter → NVIDIA → HuggingFace → OmniRoute → Ollama until one of them answers. <b>Puter is opt-in</b>, because its monthly credit allowance does not roll over and images are the dearest thing on it: switch on <b>Session → Image → Draw with Puter</b> for the occasional high-end picture, and a route that fails says so rather than quietly spending credits. The status line says which one did, and when every backend fails the message lists each one with what stopped it — see <a href="#image-providers">Image providers</a>.<br><br>
      <b>Ask for a size and get it.</b> Write it the way you would say it — <code>1536x1024</code>, <code>16:9</code>, a square icon, a tall phone wallpaper, a wide banner — and the request carries it to whichever service draws. A small chip appears in the composer as you type it (`16:9`, with the pixels behind it on hover), so the shape is visible while it can still be changed rather than only in the status line after the picture arrives; it stays away for a turn that is going to be a chat, because a hint about a size nobody will send is worse than no hint. Nothing on screen says the shape you asked for used to be ignored; that is what a request with no dimensions in it does, and every service has a default of its own. A service that ignores it anyway is answered by cutting, not by apologising: a 1024×1024 drawing for a 16:9 request already contains a 1024×576 picture, and that picture is the one you asked for — see <a href="#image-providers">Image providers</a>. The status line still reports both halves when it happens (<code>asked for 16:9 (1536x864), drawn 1:1 (1024×1024) — cut to 16:9 (1024×576)</code>), because which shape you got and which shape arrived are different facts.
      <br><br>
      <b>Every drawing is read back against what you asked for.</b> The prompt an image model receives is a rewrite of your words, so the app now shows a model that can see the picture what you asked, what was sent, and asks one question: does the picture show it? One line comes back — <i>Checked: this looks like what you asked for</i>, or <i>Checked: the sign reads HLLO, not HELLO</i> — under the prompt that drew it. It is a cheap model that does the looking — the same free-first, cheapest-known ordering a tool-reading step goes through — and it never reports a guess: a service with nothing that can see, a refusal, or an answer that is not one of the two verdicts leaves no note at all. A difference comes with a <b>Fix it</b> beside it, which redraws through the same runner that made the picture — for an edit, that means the same source, and for a brushed edit the same mask — with the difference folded into the prompt verbatim. Nothing is redrawn until you tap, one tap is one render, and the Edit button stays there for changing it yourself.<br><br>
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
      Puter needs no key at all. Add a key for Nara, OpenRouter or NVIDIA and they appear in a picker — so one running dry never stops the work — and a self-hosted OmniRoute gateway fronts hundreds of providers, including the `auto` router, behind one endpoint. Keys stay on the server.
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
| Attach a file | Paperclip icon — a picture, a PDF/DOCX, or any text file |
| Generate an image | Just describe it — <i>"draw a cat on a skateboard"</i>. **Session → Image** forces a drawing when the wording could go both ways |
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

**An attachment says what it costs before it is sent.** A pasted file is the one thing in a prompt that nothing trims: the history behind it is budgeted to 24k tokens, and the attachment arrives whole — so the chip carries the estimate (`~1.2k tokens`), and one that alone outweighs that entire history is tinted with the reason on hover rather than silently sent. It is the same estimate the history budget is spent in — four characters to a token — which is what makes the two numbers readable against each other, and it is shown for text only: a picture is bytes no character count can speak for.

**A drawing is read back against the request, not against its prompt.** The image model is given a rewrite of what the user said, and the picture is judged — by the person who asked — against what they said: two different things, and nothing compared them. A drawing that met its prompt but missed the request looked exactly like a good one, and the only signal was the user noticing. Now one short question goes out with the picture, the request and the prompt — *does the picture show what the request asked for?* — and the answer is one line under the picture: `Checked: this looks like what you asked for.` or `Checked: the sign reads HLLO, not HELLO` with a **Fix it** beside it. The reviewer is the cheapest model the service lists that can actually see, ranked the way a tool-reading step is (free, then price, then the small model of a family; a model whose price is unknown comes last rather than never), so a picture is never reviewed by the flagship the conversation happens to be on. Best effort in every direction, and quiet in every failure: nothing that can see, a refusal, or a reply that is not one of the two verdicts leaves no note rather than a guess, and a miss is never met with an automatic redraw — re-spending the user's key on their behalf is not this feature's call. What a difference *does* come with is a **Fix it** button on that same line: it redraws with the difference folded into the prompt that drew the picture (`imageCheckFixPrompt`, the difference verbatim rather than paraphrased, so a retry cannot lose the one fact it exists for), through whichever runner produced it — a drawing redraws, an edit re-edits the same source, a brushed edit re-edits it with the same mask — and the note it lands on is checked against the same request. The tap is the consent: nothing renders on its own, the button is dead while its render runs so a double tap cannot bill twice, and it comes back afterwards, because a fix that missed too is a fair reason to try again. Variations are not checked, because they are alternatives to a picture that already was.

**A file attaches as what it is, not as what it is called.** The gate used to be a list of nine extensions, and the same list filtered the file dialog — so `.py`, `.html`, `.css`, `.env`, `.toml`, `Makefile` and `Dockerfile` could not be selected at all, and a `.txt` holding a zipped archive was accepted and arrived in the prompt as mojibake. A picture is now decided by its MIME type (which the send path needs anyway to build a `data:` URL), a PDF or DOCX by its extension (the parser is what has to match the format), and everything else is text if the bytes decode as text — a BOM is handled, and a NUL byte or a decoder that gave up is what refuses it. The menu item only filters the dialog now: it never decides, so a PDF opened from **Files** is read and a picture opened from **Files** is attached as a picture, instead of being refused for arriving through the wrong door. The refusal names the fix (`That is not a text file — attach it as an Image or a Document`), and the decisions live in one place, `attachment-helpers.js`, rather than in a copy beside the page.

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
npm run smoke # the clean-profile Chrome smoke check CI runs (Node 22+ and a browser)
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
| `AUTH_USER_1` / `AUTH_PASS_1` | *(unset)* | Login gate. Set both halves and the app requires a sign-in; leave either unset and the app stays open to everyone. It also decides what a *direct* provider (Nara, OpenRouter, NVIDIA, OmniRoute) needs: with a login of its own the app has already identified the visitor and enforces that on every API route, so those providers work with no Puter account. With no login gate, the Puter sign-in stays required even for a direct provider, because there it is the only thing between an anonymous visitor and your API keys. |
| `AUTH_USER_2` / `AUTH_PASS_2` | *(unset)* | A second account. Optional. |
| `AUTH_USER_3` / `AUTH_PASS_3` | *(unset)* | A third account. Optional — three is the maximum. |
| `SESSION_SECRET` | *(random)* | Signs the login cookie. Set it so sessions survive a restart. |
| `WORKSPACE_RUN` | *(unset)* | Set to `1` to let the model run shell commands on the server (see [Running a command](#-running-a-command)). Requires a configured login — with no accounts set, every visitor would get a shell. |
| `WORKSPACE_RUN_TIMEOUT_MS` | `120000` | How long one command may run before it and its process tree are killed. 1s–10min. |
| `GITHUB_CLIENT_ID` | *(unset)* | GitHub OAuth App client id — enables the GitHub connector in Settings. |
| `GITHUB_CLIENT_SECRET` | *(unset)* | GitHub OAuth App client secret. |
| `NARA_API_KEY` | *(unset)* | Adds the Nara router — pinned to seven allowed models: agnes-2.5-flash, agnes-3-flash, atria-dawn, laguna-s-2.1, stepfun-3.7-flash, deepseek-v4.1-flash-free, muse-spark-1.3-contributor-free. |
| `NARA_IMAGE_MODEL` | *(read from Nara's catalogue)* | Image-capable alias for the Nara image routes. Without one, Nara's own catalogue is read for a model that reads as an image model; if it names none, Nara is skipped rather than passing on Nara's "Image model is required". Its upstream supports only a fixed set of dimensions — `1024x1024`, `1640x856`, `1024x1280`, `2048x1024` — and a size outside that list is swapped for the nearest one it offers, with the swap reported in `notes` rather than losing the picture (see [Image providers](#image-providers)). |
| `NARA_IMAGES_BASE_URL` | *(https://api-images.bynara.id)* | Override for the Nara images host (self-hosted endpoint, proxy, or tests). |
| `NARA_IMAGE_SIZE` | *(unset)* | The size a request is drawn at when the prompt asks for none. Read per service, so it never decides what another provider is asked for. |
| `CUSTOM_BASE_URL` | *(unset)* | Points the Custom endpoint provider at any OpenAI-compatible gateway — a self-hosted free-one-api, Ollama, llama.cpp or vLLM. Include the `/v1` segment when the gateway serves it there. The provider appears once this is set; `CUSTOM_API_KEY` is only sent when set, and `CUSTOM_MODELS` pins the picker to a comma-separated subset. |
| `FREEGPT4_BASE_URL` | *(unset)* | Points the FreeGPT4 provider at a self-hosted Free-GPT4-WEB-API gateway, which answers plain text over `GET /?text=` rather than OpenAI chat completions. The provider appears once this is set; `FREEGPT4_API_KEY` is only sent when set, and `FREEGPT4_MODELS` pins the picker. Replies arrive whole instead of streamed, from the gateway's configured default model, with no conversation memory and no image input. |
| `IMAGE_PROVIDER` | *(unset)* | Pins **one** image provider for the whole deployment, honoured exactly: a chain that falls through behind a named service would spend a second key on a decision the operator already made. It outranks the conversation's own service, which the page sends as a mere preference. Set it to `cloudflare`, `nara`, `openrouter`, `nvidia` or `omniroute`. Unset means the order below. |
| `OPENROUTER_IMAGE_MODEL` | *(google/gemini-2.5-flash-image)* | Which model OpenRouter draws with. Same key as its chat. |
| `OPENROUTER_IMAGES_BASE_URL` | *(https://openrouter.ai/api/v1)* | Override for OpenRouter's image host. |
| `NVIDIA_IMAGE_MODEL` | *(black-forest-labs/flux.1-schnell)* | Which NVIDIA model draws. |
| `NVIDIA_IMAGES_BASE_URL` | *(https://ai.api.nvidia.com/v1)* | Override for NVIDIA's image host — including a self-hosted visual-genai NIM. |
| `OMNIROUTE_IMAGE_MODEL` | *(read from the gateway's catalogue)* | Which image model your gateway has connected, as `provider/model` (e.g. `openai/gpt-image-2`). Usually unnecessary: the gateway lists what it has, so its own catalogue is read for one. **Its image endpoint serves a much smaller provider set than its chat endpoint**: OpenAI, xAI, Together, Fireworks, Nebius, Hyperbolic, NanoBanana, OpenRouter, and local SD WebUI / ComfyUI. A chat model id from any other namespace is refused with `400 Invalid image model … Use format: provider/model`, however valid it looks in the chat catalogue — a Cloudflare Workers AI id, for instance, cannot draw here at all. |
| `<PROVIDER>_IMAGE_MODEL` | *(read from the provider's catalogue)* | **Pins or overrides** the model a provider draws with. Nara and OmniRoute ship no default: without the variable their own catalogue is read for a model whose id reads as an image model, and the variable is the way to choose a different one. |
| `OPENROUTER_API_KEY` | *(unset)* | Adds OpenRouter — **free tier only**. The picker pins all 19 `:free` models (verified 2026‑09‑12), led by Nemotron 3 Ultra 550B, Inkling / Inkling Small (1M ctx), Nemotron 3.5 Lightning (1M ctx), Gemma 4 31B, Laguna S/XS 2.1 and North Mini Code. `OPENROUTER_FREE_ONLY=0` lifts the free-only gate. |
| `NVIDIA_API_KEY` | *(unset)* | Adds NVIDIA's hosted models — live catalogue (GLM, DeepSeek, Kimi, MiniMax, Devstral, Qwen, Nemotron, Gemma, Mistral, gpt-oss and the rest, as served). |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | *(unset)* | Adds **Cloudflare Workers AI** on its official free allowance (10,000 Neurons a day, no card). Both are needed: the token from the dashboard's *Workers AI* template **with your account selected under Account Resources**, and the 32-character account id. Chat models are pinned (gpt-oss 120B/20B, Llama 3.3 70B, Llama 4 Scout, Qwen2.5 Coder 32B, QwQ 32B, Mistral Small 3.1, Gemma 3); `CLOUDFLARE_MODELS` replaces the list. It is also the **first image service tried**: FLUX.1 [schnell] via `/ai/run`, pinned with `CLOUDFLARE_IMAGE_MODEL`. It does not edit pictures. |
| `DEEPGRAM_API_KEY` | *(unset)* | Adds Deepgram. Speech service; its chat endpoint answers 404. |
| `ASSEMBLYAI_API_KEY` | *(unset)* | Adds AssemblyAI. Speech service; its chat endpoint answers 404. |
| `YOUCOM_API_KEY` | *(unset)* | Adds You.com. Search and research service. |
| `OMNIROUTE_BASE_URL` | *(unset)* | Adds **OmniRoute** — a self-hosted AI gateway that fronts hundreds of upstream providers behind one OpenAI-compatible endpoint, including the `auto` model that routes each request to the best connected provider. Set it or `OMNIROUTE_API_KEY`. See [OmniRoute](#omniroute). |
| `OMNIROUTE_API_KEY` | *(unset)* | Optional key, sent as `Bearer`. A fresh OmniRoute install answers without one (`REQUIRE_API_KEY=false`); when the gateway is hardened to require a key, set it here — and an unset key means *no* auth header at all, never a bare `Bearer`. |
| `OMNIROUTE_MODELS` | *(the lead list)* | Comma-separated ids that replace the lead list — the `auto` variants and the free-tier flagships — when your gateway's catalogue routes different names. |
| `OPENROUTER_FREE_ONLY` | `1` | Free models only. Also means **no drawing**: OpenRouter's Image API has no free tier — its own docs say so, and none of its image models carries a `:free` id — so a free-only key is not offered as an image candidate. Set `0` once the key has credits. |

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
| **Chat** | `web_search`, `web_fetch` | read, search | read, search, commits, branches | — | — |
| **Plan** | the same | the same | the same | `task_*` | `use_skill` |
| **Build** | the same | **+ write, edit, delete** | **+ commit, delete, create branch** | `task_*` | `use_skill` |

The split follows opencode, which is where the three modes come from: **Chat researches** (search, read pages, cite primary sources, answer — no plan document, no commits), **Plan investigates and proposes** but cannot change anything, and **Build executes** the agreed plan with the write tools in hand. The task list is deliberately a Plan-mode tool: writing down a plan is the point of the mode, so the task tools are not in the write group and are not refused. A tool in no group is offered in every mode — the table is a lock on writes, never on a read tool added later. The rule is enforced by a test rather than by care: every name in a write group has to read as a write, and `github_create_branch` is why that check asks about the verb (`create`, `commit`, `delete`, `write`, `edit`) instead of requiring the suffix `_file` — a tool that changes a repository without touching a file would otherwise have been argued out of the group that keeps it out of Plan mode.

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
| `github_list_branches` | Lists branches and says which is the default |
| `github_commit_file` | Writes and commits — **always asks you first** |
| `github_delete_file` | Deletes a file and commits the removal — **always asks you first** |
| `github_create_branch` | Creates a branch from another or from the default — **always asks you first** |

**Branches.** Every read and write takes an optional `branch`; without one, GitHub's default branch is used, which is what every call here did before. The commit tool looks up the file's sha *on the branch it is writing to* — a sha read from a different branch names a different blob, and GitHub rejects that commit as a conflict that reads like someone else changed the file.

`github_create_branch` exists because its absence was reported by the agent itself. Asked to put work on `main` in a repository whose only branch was `claude/…`, it replied that branch creation "requires the GitHub web UI or the git CLI" and handed over a list of clicks. It was right about its tools and wrong about the API — a branch is one POST to `/git/refs` — so the tool surface was the only thing missing. Creating a branch that already exists is reported as an outcome rather than an error, because a `422` there reads as a failure and makes a model retry under a different name.

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

### 🖥️ Running a command

The one tool that reaches a real machine. It exists because a note-taking scratch space cannot *do* anything: writing a script and running it — generating a PDF, producing a file, running a test — needs a filesystem and a shell, and the browser-local workspace has neither by design.

| Tool | What it does |
| --- | --- |
| `run_command` | Runs a shell command on the server and returns stdout, stderr, the exit code, the shell it used and the files the workspace now holds — **always asks you first** |

**Off until an operator turns it on, and only where there is a login.** Two independent conditions, and neither is a default:

| Variable | Default | What it does |
| --- | --- | --- |
| `WORKSPACE_RUN` | *(unset)* | Set to `1` to enable `run_command` at all. A push therefore never turns a deployment into a shell by itself. |
| `WORKSPACE_RUN_TIMEOUT_MS` | `120000` | How long one command may run before it and its whole process tree are killed. Clamped between 1s and 10min. |

The second condition is the one that matters: the app must already have `AUTH_USER_1`/`AUTH_PASS_1` configured. `isAuthenticated` treats an app with *no* accounts as open to everyone, so on such a deployment a shell route would hand a shell to anybody holding the URL — and the container's environment holds your provider keys. `WORKSPACE_RUN=1` without a login is refused with that sentence, not with a 500.

**What a command is not allowed to see.** It gets a scrubbed environment — `PATH`, a locale, a temp dir, and `HOME` pointed at the workspace — and never the app's own environment, so a script cannot read `NARA_API_KEY`, `GITHUB_TOKEN` or `SESSION_SECRET`. `NODE_OPTIONS` and `LD_PRELOAD` are scrubbed for the sharper reason: either one runs code *around* the command you approved. The working directory is confined to the workspace (`..` is refused, not resolved away), stdout and stderr are capped at 32 kB each, and one command runs at a time so a hung install cannot be stacked behind.

**Where the files go, and where they don't.** Commands run in `workspace/` beside the app — a directory inside the container, so it is **gone on the next deploy**. That is the honest place for a scratch directory on a service that rebuilds its container, and it is why the panel says so. Produced files are listed with their size in the tool result (so the model can hand you a link), announced in the chat itself (`Wrote report.pdf (12.0 KB) — Settings → Server files`) whenever a command added or changed one, and listed in **Settings → Server files**, where each one downloads through `/api/workspace/file`. A downloaded `.pdf` arrives as a PDF, not as a blob, because "generate a PDF and give it to me" is the thing this was built for. The chat line is the part that matters: the model knows about the file either way, and without it you would be taking the reply's word for something you cannot see.

**Build mode only, and only where the server offers it.** The shell is a write in every sense that matters, so it is not in the request at all in Chat or Plan mode, and a call that arrives anyway is refused by the same gate every other write goes through. The page also asks once at load what this server allows — the same request the panel uses — so on a deployment where `WORKSPACE_RUN` is unset the tool is not in the request either: a tool that can only answer "this is switched off" costs a round trip and a dialog you have to decline. The refusal stays wired for a server that changes its mind mid-session. Approval is remembered separately from file writes: allowing a note to be saved this session is not allowing a command to run.

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

**Generated pictures are kept, not just described.** Every Puter image arrives as a `data:` URL, with the whole picture inside the string, and history kept only `http(s)` links — so the picture was dropped the moment it was saved. The bubble showed it (still in memory) while the Gallery, which reads saved history, had nothing but the prompt. The bytes now go to an **IndexedDB index** (`image-store.js`) at the size they were drawn, and a conversation carries a few dozen bytes naming them — an id, the prompt, and how big the picture is. A remote link is still left as it stands, because those bytes were never ours. The newest eight pictures per chat are kept, and a browser with no index — a locked-down private window, an engine that refuses one — falls back to the compact inline copy, which is why that path still exists. When browser storage fills up, **the pictures go before the history does** — a chat with no image is still a chat, a chat with no history is a loss — and every step of that is a rule with its own test rather than a try/catch nobody reads.

> **Why it moved.** The stored copy used to be a 1024px JPEG at a quality that went as low as 0.3, because localStorage is about 5MB shared with every chat's text and a 1536x864 drawing is megabytes of base64. So the picture that came back in a reopened chat was not the picture that was drawn, and the Download menu was converting *that* copy: "Save at 1024 × 576" was the honest report of a 1536x864 request. `STORED_IMAGE_MAX_EDGE` survives only in the no-index fallback, where a reduced picture is still better than a lost one.

**An image request is read, not matched.** The first version decided with a regex. If the words contained no verb-and-noun pair from a fixed list, the turn fell through to a vision chat — so "make the sky purple" with a photo attached answered *about* the photo, and never reached an image model at all. And whatever survived that filter was sent on as the prompt verbatim, so "make it warmer" arrived at the image model with nothing to warm. One small model call now reads the turn and returns `{"action": "generate" | "edit" | "chat", "prompt": "…"}` — the action ChatGPT gets from its image tool's `action: "auto"`, and the rewritten prompt it gets back as `revised_prompt`. The keyword rules stay underneath as a *floor* rather than a fallback, because the bug they fix is worth keeping fixed: with a picture attached, no reading of a request may turn an edit into a fresh text-only render (the poster-of-a-car bug). A plan may only move a turn *into* image work. The call is made only for turns that could plausibly be image work — something attached, a draw request, a picture already in the chat, or the image toggle — so an ordinary chat message never pays for it, and any failure at all leaves the keyword decision in charge (`resolveImageAction` in `chatlib.js`, tested without a browser).

**Follow-ups edit the last picture, and one pipeline draws them all.** "Now make it look realistic" has no attachment to work from, and re-uploading your own output by hand is not something anyone does — so the newest picture stored in the chat is the source when nothing is attached, which is multi-turn editing. Because that source can be a remote link rather than a data URL, the edit route now fetches it (through the same private-address guard the page reader uses, since the URL comes from the browser). The composer, the brush editor and the Variations button all go through one chain, which is what makes that true everywhere at once: the brush editor used to POST straight at the server route, so a Puter user with no Nara key painted a region and got "Image editing needs NARA_IMAGE_MODEL" — naming a backend they were not using. A painted mask now reverses the chain (Puter has no mask field at all), is scaled to the source picture's own size rather than the 640px canvas it was painted on, and if the route cannot take it the brush is dropped and Puter is asked without it — with the drop said out loud instead of silently changing the result.

**The right model, at the right quality.** (Puter draws only when **Draw with Puter** is on; this is what it does when it is.) Puter draws at `low` when nothing asks for better, and nothing did — every picture this app produced was rendered at the bottom tier while paying the same credits. `quality: "high"` is now asked for explicitly, on both backends. The model is picked by the job too: Puter documents **Sunburst** for editing precision and **Flare** for fast generation, where the app pinned `gpt-image-2`/`gpt-image-1.5` for both. Edits name the picture through `input_images`, the field Puter's docs identify as the one that routes through the image *edit* endpoint, rather than `input_image`, a shorthand whose silent fallback to text-to-image would hand back a plausible new picture where an edit was asked for — a failure that looks like success. A refusal (`moderation_flagged` and the prose wordings for it) ends the chain immediately and says what to reword, because the same prompt asked of another model or another service can only come back refused again.

**Every key draws, not just Nara's.** The image route was Nara's and only Nara's: an operator with an OpenRouter or NVIDIA key could chat on it and not draw, and asking for a picture answered *"Image generation needs NARA_IMAGE_MODEL"* — naming a service they had not configured. Each provider now declares how it draws in an `image` block of its own (an OpenAI-shaped body, or NVIDIA's `{prompt} → {artifacts}` GenAI shape), the route walks the order and takes the first service that answers with a picture, and every answer is normalized to the OpenAI payload the browser already reads. Which one drew comes back with the picture and is said on screen, because that is the one fact about an image nothing else can recover. The order falls through on anything that is a fact about *that* service — a forbidden key, a model the account cannot reach, a bill, a 5xx, a dead socket — and stops on a refusal, since every service is being handed the same prompt. See [Image providers](#image-providers).

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

**The model list here orders the picker, and only free-tier namespaces follow it.** It used to be a plain allowlist, which made sense while the gateway was assumed to front a handful of flagships. It is the wrong shape for a gateway: you already chose what it fronts, in its own dashboard, so a second allowlist here can only overrule that — and did. Connecting Mistral published 48 `mistral/…` ids that could not be picked by name. Now the free-first routers (`auto/best-free`, `auto/coding:free`) and the free-tier flagships lead, and the rest of the live catalogue follows them — **but only from namespaces on a free tier** (`restPrefixes`: `auto/`, `kr/`, `gh/`, `mistral/`, `groq/`, `gemini/`, `samba/`, `ollamacloud/`, `cf/`, `llm7/`, `antigravity/`, `agentrouter/`, `openrouter/`). A connected OpenAI or Anthropic key would otherwise fill the picker with models that can only answer `402`; an id outside those namespaces is still reachable by naming it in `OMNIROUTE_MODELS`. A named id that is retired upstream stops leading instead of vanishing from the list.

**Not everything in a catalogue can hold a conversation.** Embedding, reranking, moderation, image and audio models sit in the same list as chat models and can only fail on a chat call, so one shared rule drops them before the picker and the router ever see them. Job words — `embed`, `rerank`, `whisper`, `tts` — catch most of it, but speech synthesis is named after the voice instead: `fish-audio/s2.1-pro-free` reads like an ordinary chat id, and a failover picked exactly that one and asked a text-to-speech endpoint to carry on with a coding task. So the voice families are named too (`fish-audio`, `orpheus`, `aura-N`, `elevenlabs`, `playai`, `kokoro`, `xtts`, `parler`, `speecht5`, `bark-`). Matching on "audio" would be the obvious rule and the wrong one — `gpt-4o-audio` and Voxtral answer chat completions perfectly well.

Inside those namespaces one more rule applies. The gateway publishes **no pricing at all** in `/v1/models`, so "is this free?" has no general answer here — but OpenRouter marks its free models in the id, and reaches the gateway as over a thousand ids on a key that is usually free-only. `freeOnlyPrefixes: ['openrouter/']` drops the paid ones. The page keeps the first 60 usable rows, so what leads the list is what can be picked by name.

Until that variable (or `OMNIROUTE_API_KEY`) is set, **OmniRoute does not appear in the picker at all** — the provider stays out of it entirely rather than showing up and failing, so "I can't see the auto models" on a deploy almost always means the variable is missing.

**Connecting providers to OmniRoute.** Run the gateway, open its dashboard at `http://localhost:20128`, sign in with the initial admin password, and connect whichever accounts/keys you want — OmniRoute keeps them in its own SQLite database, encrypted at rest. This app never sees them; it only talks to the gateway.

**Hardening the gateway.** A default install asks for no key, and anything that can reach it can spend every account you connected. If you expose it beyond your own machine, set `REQUIRE_API_KEY=true` in the gateway's environment, create an API key in its dashboard, and put that key in `OMNIROUTE_API_KEY` here.

**A local gateway is not reachable from a deployed app.** `http://127.0.0.1:20128` from the Railway container means the container itself, where no gateway is running. Either run this app locally against the gateway (the command above), or run the gateway somewhere this app can reach — a second service on the same Railway project (private network), a VPS, or your own server — and point `OMNIROUTE_BASE_URL` at it. Don't publish an unhardened gateway to the open internet.

**Quick-tunnel URL rotates on every restart.** When the gateway is reached from a deployed app through a local quick tunnel, the `trycloudflare.com` URL changes whenever the cloudflared container is recreated (a reboot, or `docker compose up --force-recreate`). After the machine restarts, read the new URL from `docker logs app-cloudflared-1` (look for `https://…trycloudflare.com`) and update `OMNIROUTE_BASE_URL` on Railway.

**One home for the compose stack, and one `.env` that matters.** `docker-compose.yml` pins `name: app`, so the project name follows the file rather than the directory it is run from. That is deliberate: the stack was first started from a different folder, and without the pin a `docker compose up` from this repo would have named the project after this directory, created an empty second `freeopenai_omniroute-data` volume and collided on port 20128 — indistinguishable, from the dashboard, from OmniRoute having been wiped. With the pin, this repo *adopts* the running containers: `docker compose ps` here lists them, and `up` reuses the same volume:

```bash
docker compose up -d omniroute cloudflared
```

**Losing `.env` while the containers are up is recoverable; losing both is not.** `JWT_SECRET` and `API_KEY_SECRET` sign the dashboard logins and every API key held in `app_omniroute-data`, so generating fresh ones invalidates the key a deployed app is using — the gateway then answers `401` with its data apparently intact, which reads as a much stranger fault than it is. A running container still holds the values it was started with:

```bash
docker inspect app-omniroute-1 --format '{{range .Config.Env}}{{println .}}{{end}}'
```

Recover them into `.env` from there rather than inventing new ones. Once the container is removed, they are gone, and the only way back is a fresh admin password and a new API key on every client.

<a name="image-providers"></a>

### 🎨 Appearance

The palette is a near-neutral grey ladder rather than white-on-black: the chrome (the chat rail, the top bar, the status bar) sits one step **darker** than the conversation, and the composer and the user's bubble sit one step **above** it — `#171717` / `#212121` / `#303030` in dark, `#f9f9f9` / `#ffffff` / `#f4f4f4` in light. Nothing is pure black in dark mode and nothing is pure white in light mode, which is what stops a long transcript from reading as a headlamp, and the composer is lifted off the transcript rather than sharing its grey.

The header's sun/moon button opens a picker with **System / Light / Dark** plus the three theme packs (Tokyo Night, Gruvbox, Green). It names the three the way ChatGPT does instead of cycling, because a cycle is the wrong shape for five: reaching Gruvbox from Tokyo Night meant passing through every other theme on the way. System follows the OS and keeps following it while the tab is open. The choice is stored as `puterChatTheme` in your browser, and the browser's own chrome colour (`<meta name="theme-color">`) follows it, so the status bar is not a black frame around a grey app.

**The toggle is on every screen size.** It used to be the first control dropped below 380px, on the reasoning that Ctrl+P still reaches it — which is no reasoning at all on a phone, where the appearance of the app is the one setting you cannot get to any other way. On a phone the picker opens as a sheet at the bottom of the screen; on a desktop it is a dropdown anchored under the button, right-aligned and pulled back inside the viewport. `npm run smoke` now asserts, at 360, 390, 844×390 and 1440 wide, that the toggle is visible, on screen, that the picker opens onto the viewport with all six rows usable, and that every icon button in the header is the same size at that width.

### 📱 On a phone

The composer's control row is where a phone runs out of width. It holds five things — the model, the provider, the effort, the mode, and the Session chip — which want 383px at their desktop size, and a 390px screen gives the row 350px. It used to overflow by that difference into a horizontal scroller nothing signalled: at 360px the mode chip sat *entirely* past the right edge, with not even a sliver poking out to suggest it was there.

The cause was a cascade bug rather than a missing rule. Three clamps existed — 84px at 640, 68px at 380, 92px in landscape — and **none of them ever applied**: they were written as `.model-trigger span#modelLabel` while the desktop rule was `.composer-controls .model-trigger #modelLabel`, and one id with two classes beats one id with one class and an element. A media query adds no specificity of its own, so every phone rendered the desktop widths. Nothing caught it: eslint does not read CSS, the unit tests do not render, and the smoke test only checked that the controls existed.

**The row is now one line, always, with attach at the head of it.** Reading left to right: attach, the model, the provider, the effort, the session chip, the mode. Attach is the control every message needs, so it sits at the left edge where a thumb already is, next to the model picker. It used to be a group of its own on a line of its own — which did keep it from being pushed off the edge, and spent 44px of a phone's height on one button with most of the row empty beside it. The composer drops from **162px to 112px**, and the transcript gets all fifty back.

What holds it to one line is the model name, which gives up exactly the width the row is short by. It is the right control to squeeze because it is the only one that degrades gracefully: it already ellipsises, and the full list is one tap away in its own dropdown. A chip reading "Cha…" would not. So a long provider name like `Antigravity` costs the model name some characters rather than costing a control its place.

Three details make that work, and each was a bug on the way:

- **The flex item is the wrapper, not the button.** The model picker sits inside an unclassed `position: relative` div that hosts its dropdown, so a rule aimed at `.model-trigger` read correctly and did nothing — the button is not a child of the row. It has a name now.
- **`flex-basis: 0`, not shrink.** Letting the controls shrink to fit put the pressure where content was widest, which collapsed the provider select to 10px while the model button overflowed its group. Starting the model at zero and letting it grow into what the fixed controls have not used is deterministic: the row is exactly full at every width.
- **Wrapping had to go.** A wrapping flex line does not shrink to stay one line — it wraps and leaves the items at their natural width. The two are alternatives, not a belt and braces.

Attach draws at 34×44 rather than 44×44: the row needs the width back, but a 34px square beside 44px chips reads as a control that did not line up, so only the width gives. Its finger target stays a full 44px through the same `::after` box the header's icon buttons use, and `npm run smoke` asserts that — a shrunken glyph with a shrunken target would be the wrong trade. Hiding a control was never an option: the provider picker is the only way to change service, since the model dropdown lists models alone.

**Landscape gets its second row back as height.** The shared phone layout puts the attach button on its own line so it cannot be pushed off the edge, which is right at 360px. In landscape the problem is the opposite one: the row needs 421px and has 808px, so the split bought nothing and cost 44px of a 390px viewport. The transcript grows from 167px to 211px — about a quarter more of the conversation — and the split is kept below 641px wide, where the original reasoning still holds.

One more width came free along the way: the model button was carrying the **iOS zoom guard**, the `font-size: 16px` that stops iOS zooming the viewport when a field is focused. That guard is for fields — `input`, `select`, `textarea` — and the model picker is a `<button>`, which iOS never zooms for. It did nothing there except make the widest control in the row a third wider than it needed to be, on every phone. Its dropdown holds a real search input, and that still has it.

Two checks now make this class of bug hard to reintroduce. `npm test` walks the stylesheet, scores specificity, and fails when a declaration inside a `@media` is beaten by one outside it — ignoring rivals that need a state, since `.chat-shell.history-hidden .history-sidebar` only applies while the sidebar is closed and cannot be said to win. And `npm run smoke` measures every control in the row at all five viewports rather than asking whether it exists: that it is on screen, that attach leads, that the row is one line and cannot overflow, and that nothing has collapsed. It caught the 390px case immediately, which the existence check had been passing for months.

<a name="android-app"></a>

### 📲 The Android app

`android/` is a small Android app (**FreeAI4U**) that wraps your deployed site in a locked-down WebView and adds the one thing a browser tab cannot do: **sign in once and stay signed in.** It is the site — every feature the web app has on a phone is there because it *is* the web app — so nothing here is a second chat client to keep in step with the first. An earlier build did reimplement chat natively; it was replaced because a 10,000-line page cannot be kept in parity by hand, and the user wanted parity.

**Install it (first time)**

1. On the phone, open **https://github.com/tradernonymous/freeopenai/releases/tag/apk-latest** and tap `freeai4u.apk`.
2. Chrome asks whether it may install apps from this source — allow it. OPPO's ColorOS adds its own warning for any app outside its store; tap **Install anyway** (it may make you wait a few seconds first).
3. If the older testing build is still on the phone (the one from the Actions artifact), uninstall it first: it is a different package (`com.freeai4u.app.debug`) under a different key, and the two do not update each other.
4. Open the app. The server address is already filled in; type the username (`AUTH_USER_1`) and its password once and tap **Sign in.** From then on the app opens straight into the chat.

**Updating.** Open the same link, download, install over the top — the app keeps its data. Every push to `main` that touches `android/` rebuilds it, so the release always holds the latest build; the build number is in the release notes.

**How it stays signed in.** The server's sessions last seven days. The app checks its session on every launch through `GET /api/session`, which reports who is signed in and — when the session is past half its life — issues a fresh one, so a phone that opens the app at least weekly never sees the login again. If the session has lapsed anyway (a fortnight away, a server restart with a new `SESSION_SECRET`), the app signs in again on its own with the password it holds. That password is kept only for this, and only on the phone: it is sealed with an AES-256-GCM key that lives in the Android Keystore (hardware-backed on any recent phone), so the preferences file holds ciphertext that nothing outside this app, on this device, can open. Backup is off, so it never leaves the phone. Sign out inside the app (Settings → Sign out) and the phone forgets both the password and the session; the server and the username stay, so the next sign-in is one field.

Why the password is not simply built into the APK: an APK can be unpacked by anyone who has it, so a value baked in at build time is published, not protected — and it is the first thing a security scanner flags. What *is* baked in are the two harmless defaults: the server address and, optionally, the username, from the repository variables `APK_SERVER_URL` and `APK_USERNAME`.

**What the shell locks down.** `INTERNET` is the only permission — files come in through the system picker and go out through MediaStore into `Downloads/FreeAI4U/`, neither of which needs storage access. HTTPS only, system trust anchors only (a "helpful" proxy CA on the device cannot sit between the app and the server); `http://` is refused outside your own network. No file or content URLs in the WebView, no mixed content, no geolocation, no JavaScript bridge of any kind — the app never hands the page a handle into itself. Navigation stays on the configured server: a link in a reply opens in the phone's browser, GitHub's sign-in is the one exception (the page's "connect GitHub" flow round-trips through it and back), and the popup Puter's sign-in needs opens in its own locked-down WebView that may load Puter and nothing else. The window is flagged secure, so screenshots, screen recordings and the recents thumbnail all come out blank. The build is non-debuggable in both variants, minified and shrunk in release.

**Building and signing.** CI (`.github/workflows/android.yml`) builds on every push that touches `android/`, runs the JVM unit tests (`ApiTest` — URL policy, session contract, download decoding, launch decisions) and, when the repository holds a signing key, builds the release APK and publishes it to the rolling `apk-latest` release. The key is a PKCS12 keystore held in four secrets — `APK_KEYSTORE_BASE64`, `APK_KEYSTORE_PASSWORD`, `APK_KEY_ALIAS`, `APK_KEY_PASSWORD` — and **it must be backed up off GitHub**: Android only installs an update signed with the same key as the app it replaces, so a lost key means uninstalling (and losing the app's data) to move to a new one. Without the secrets the workflow builds the debug variant as an artifact instead, so a fork still builds. Each build's `versionCode` is the run number plus 100, which is what lets every build install over the one before.

### 🖼️ Image providers

Every provider this app chats on can also draw, because they are all asked the same question through the same route: the server's `/api/llm/images/{generations,edits}`, behind which sits an order — **Nara → OpenRouter → NVIDIA → OmniRoute** — with the chat's own service moved to the front of it. There is no second picker to configure: a request for a picture is still a request to whoever is answering the chat.

**Where drawing for free stands.** A free key is the whole point of this app, and pictures are where free keys run out first. **Puter** draws in the browser on the visitor's own monthly allowance, which is why the app asks before spending it (the Draw-with-Puter switch below). **NVIDIA** draws on signup credit that runs out once — a `404` from `/genai/<model>` on a key that used to draw is that credit gone, not a wrong model id. **OpenRouter's Image API has no free tier at all** (its docs say so, and no image model there carries a `:free` id), so a free-only key is never asked to draw. **OmniRoute's** images endpoint serves a much smaller provider set than its chat does (OpenAI, xAI, Together, Fireworks, Nebius, Hyperbolic, NanoBanana, OpenRouter and local SD WebUI / ComfyUI), every one of them on paid or one-off credit — and Google's image models are *not available* on the Gemini API free tier, so the NanoBanana connector needs a paid key. The daily-refilling and keyless drawers this app once carried (Cloudflare Workers AI, Pollinations) and the monthly-credit ones (HuggingFace) were removed at the operator's request; the four services above are the whole order.

**Every provider that is configured can draw, and nobody has to name a model to make that true.** OpenRouter and NVIDIA ship an image model already named; for Nara and OmniRoute, the model comes from the provider's *own catalogue* — read once, for the service the request would ask first, and cached for the same twenty minutes the model picker uses. (Google's own key is the exception, and it is a declared store rather than a discovered one: its pictures are not on the endpoint its chat uses.) It is read only when the service has no image model of its own, so a provider with a default or a variable costs nothing, and a catalogue that answers "none" is not read again until it expires. `<PROVIDER>_IMAGE_MODEL` still exists and still wins — it is how a model is *pinned* or overridden, rather than the only way to have one — and `<PROVIDER>_IMAGES_BASE_URL` still handles a host that is not the one its chat uses.

The model is read from the id a catalogue publishes (`gemini-2.5-flash-image`, `gpt-image-1`, `black-forest-labs/flux-1-schnell`), and a model that only *reads* pictures is never mistaken for one that makes them: a vision id says "image" and answers with prose. On a catalogue with several, the most specific id wins — `gpt-image-1` beats a model that merely contains "image" — and within that, the catalogue's own order, which is newest-first nearly everywhere. The read goes to the same key and the same host its chat uses, which is why a proxy or a gateway needs nothing declared at all. `/api/llm/images/providers` reads first too, so its answer means "its catalogue has nothing to draw with" rather than "nobody has looked yet". 

That used to be impossible for all of them, and it is what the report meant. Only the seven could draw, the list was code, and the conversation's own provider was *dropped* rather than asked — so a chat on a Google key, a proxy in front of one, or any OpenAI-shaped gateway could produce a picture only through Puter, in the browser, on the visitor's own account: the one service the reader had not chosen. Naming a provider outright failed the same way, answering `Unknown image provider "gemini". Wired up: nara, cloudflare, …` about a service that had been configured, was reachable, and could draw.

**When nothing can draw, the sentence leads with the provider the chat is on.** A deployment whose chats run through a proxy has no Nara key and never will, so a list of seven services it does not have is advice it cannot take — and it never once mentioned the provider the user had just been chatting on. The conversation's provider now comes first, with its own variable: `nara (Nara has no image model named — set NARA_IMAGE_MODEL.)` — and that is only said after its catalogue has been read and had nothing to offer, so it is the one variable that would actually fix it.

**Puter is the one service that is not in that order unless you put it there.** It draws in the *browser* on the visitor's own account, which costs the operator nothing — but a Puter account gets a fixed monthly allowance of credits that does not roll over, and images are the dearest thing on it, where every other provider here runs on a free key. So a drawing nobody pointed at Puter goes to the route, and a route that fails says so rather than quietly billing the allowance: an automatic fallback is exactly how a month's credits disappear into pictures nobody chose to pay for.

Being *on* Puter for chat is not that choice either. Chat there is cheap and images are not, so the picker that decides the conversation must not also decide to spend credits on every drawing. The switch is **Session → Image → Draw with Puter**, off by default and remembered per browser; while it is on, the session chip says `Puter images` so it cannot be left on by accident. With it on, Puter draws first and the route stays behind it — except for a painted brush mask, which the route gets regardless, because Puter's image options have no mask field at all and asking it first would silently edit the whole picture instead of the region you painted.

**A service is only a candidate once it has an image model** — its `_IMAGE_MODEL`, the default documented for it, or one read from its own catalogue. That is what makes it able to draw; the chat's model is a *preference* offered to it, not the thing that qualifies it. A provider with no image model used to become a candidate by borrowing the chat's id, so chatting on a gateway's router alias (`auto/minimax`) sent that alias to an images endpoint and spent a round trip being told `400 Invalid image model: auto/minimax` on every single draw — and `/api/llm/images/providers` reported the service as not ready while the draw went on trying it. Report and draw now agree, because both read the same answer.

The chat's model is offered as a *preference*, not a pin. Most chat models on these services can draw; the ones that cannot answer with a 400, which is never billed, so the provider is asked once more with the image model it would have picked by itself before the order carries on. **Except on the services that run a picture by name on an endpoint that serves nothing else** — NVIDIA's `/genai/<model>`. There the conversation's model is not a weaker choice but a different request: a text model sent through an image endpoint answers `200` with prose in it, and a `200` with no picture in it is this route's word for "that service did not do the job" — so the chat's id never reaches those three, and `<PROVIDER>_IMAGE_MODEL` still decides what does. Which model produced the picture is what the answer reports — the chat model that was asked first, or the provider's own image model that answered second. The chat's model id is offered only to the provider the chat is on — ids come from per-provider catalogues, so an OpenRouter name handed to Nara is a 404 dressed up as a bad request. The first configured service that answers with a picture wins, and anything that is not a refusal — a key that is not allowed, a model the account cannot reach, a bill, a 5xx, a dead socket — moves to the next one. A *refusal* stops the whole chain, because every service is being handed the same prompt and paying a second key to hear it refused again is not a retry.

Ordering that way means an `OPENROUTER_API_KEY` alone draws, with no `NARA_API_KEY` in sight — which is the bug this replaced: the route used to be Nara's and only Nara's, so a key that could chat could not draw, and the answer named a service the operator had not configured.

What differs between the services is the shape of the request, and each provider declares its own in its `image` block rather than the route branching on a name:

| Shape | Request | Answer |
| --- | --- | --- |
| `openai-images` | `{model, prompt, size?, quality?, n?}` | `{data:[{b64_json\|url}]}` |
| `nvidia-genai` | `{prompt, mode:"base", aspect_ratio?}` | `{artifacts:[{base64}]}` |

Every answer is normalized to the OpenAI images payload, because that is what the browser already reads — one reader for every service is one place a picture can go missing. NVIDIA tries the NVCF GenAI shape first and the OpenAI-compatible one on a 404, since a self-hosted visual-genai NIM documents the second while the hosted FLUX models speak the first.

**Edits** are the same shape question asked once more. Nara takes multipart file parts (`image`, optional `mask`, plus `model`/`size`/`quality`/`n` as fields); OpenRouter takes the source as an `input_references` URL on the generations endpoint, and so does a self-hosted gateway — the same body, verified against a live one. **A service that declares no edit shape at all is not asked to edit.** It used to be sent the prompt alone, which is a fresh drawing wearing the word *edit* — the picture on screen is what the request was about, so instead it is stepped past by name (`cannot edit, only generate`) and the services that can actually take the picture are the ones that answer. That is what makes the edit button honest on a keyless deployment, where the drawer that needs no key is a generate-only device. A painted brush mask is a file part or it is nothing, so a service that takes a reference gets the edit *without* the mask and says so in the response's `notes` — dropping it silently would edit the whole picture while the user watched a region they drew being ignored.

**`size` comes from the request, not from a control.** There is no size picker in the composer, so the prompt is where it is read from — `1536x1024`, `16:9`, `square`, `tall`, `wide`, `landscape`, `banner`, `poster` — with pixels beating a ratio and both beating a shape word, and nothing at all for a prompt that asks for no shape. The three services want it three ways (an OpenAI pixel pair, Puter's `ratio: {w, h}`, a Together model's width/height), so one reading is held and answered per service rather than re-derived in each path. An *edit* reads only what was spelled out — "make the poster blue" is about a picture that already exists, and reshaping it because the sentence contains a shape word would crop something nobody asked about.

**A shape a service ignores is cut, not reported.** Every service is asked for the shape and some ignore it — a model with one square output size cannot honour 16:9, and no setting this app can send will change that. The picture is measured when it arrives, and when its shape is off by more than the rounding tolerance the largest rectangle of the shape you asked for is cut out of the middle of it: nothing is upscaled, nothing is padded, and a service that drew small still drew small — it just drew the shape that was asked for. That is the one place a drawn picture is re-encoded, in the format it arrived in, and only when there is a cut to make, so the transcript, the gallery, the download menu and the PDF page all measure the same picture afterwards. A cut that would leave a sliver (under 64px on a side) is refused and reported instead, because a 23-pixel-tall banner is a file you have to notice and draw again. An *edit* benefits from the same rule in the direction that matters most: the source picture's own shape is what it is measured against, so an edit that comes back square no longer contradicts the size it was asked for.

**A size a service does not offer is swapped, not refused.** Nara declares four dimensions. Handing it a fifth used to mean the draw failed on a service that was ready and had credits, refused for a reason nobody typed; it now draws the nearest shape it does offer and says so in the response's `notes` (`asked for 1536x1024 — Nara draws 1640x856`), which reaches the status line. `quality` and `n` stay preferences, and a 400 that arrives while one was sent buys exactly one more attempt without it. A 400 is never billed, which is what makes that retry free.

**Two reasons a draw used to fail on every provider at once.** Both were live at the same time, which is why "generate an image" reported one long sentence naming every service:

- **OpenRouter answered `402 Insufficient credits. This account never purchased credits.`** Its Image API has no free tier, so a key limited to free models cannot draw with it — and that is a fact about the account, so every later attempt gets the same answer. A free-only key is no longer offered as an image candidate at all, which saves a guaranteed-failing round trip and stops it leading the order. `OPENROUTER_FREE_ONLY=0` is the way back in once there are credits on the key, the same variable that opens the paid chat catalogue.
- **NVIDIA answered `422 {"type":"extra_forbidden","loc":["body","aspect_ratio"]}`.** Two bugs stacked: the NVCF shape sends a shape as `aspect_ratio` rather than a `size`, so it sat outside the one mechanism that can take a preference back off a request — and the retry that drops preferences only looked for a `400`, while a FastAPI-shaped service reports an unknown field as `422`. So the retry re-sent the very field that caused the refusal, for every model, every time. `aspect_ratio` is a preference like the others now, and `422` buys the same free second attempt `400` does.

When nothing can draw, the message now asks `imageCandidateFor` for each provider's reason rather than guessing at one. The guess produced `openrouter (set OPENROUTER_IMAGE_MODEL)` for a provider that has a default model and was really being held back by its key — advice that could not have worked.

**The route says who drew.** Every successful response carries `provider`, `providerLabel`, the `model` and any `notes` alongside the pictures, because that is the one fact about an image that cannot be recovered from the image afterwards. The page turns them into the status line (`Image ready — OpenRouter`). `GET /api/llm/images/providers` reports which services are ready, with which model, and what each is missing when it is not — it is the operator's view of the order, and the reason a failure can name variables that would actually fix it rather than a service that was never configured.

**Saving a picture saves the picture you got.** The Download button on an image (in the message row, and again in the lightbox) offers **PNG, JPG or PDF**, and all three re-encode at the bitmap's own pixel dimensions — never a fixed square, never a "reasonable" 1024px. That was the bug: a picture drawn at 1536×1024 could only be saved as a 1024×1024, because the lightbox's `<a download>` could hand back the bytes it was given and nothing else. The menu prints the true size above the format list (`Save at 1536 × 1024`), so asking for a size and not getting it is visible *before* you save rather than after. What it converts is the picture's own bytes, on the first draw and after a reload alike — the stored copy used to be the 1024px re-encode, so the second visit silently downloaded a smaller picture than the first.

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
                prompt budgeting) — used by the page and by the tests
attachment-helpers.js
                every attachment decision, and the only copy of them: what a
                picked file becomes (image, document or text), whether its bytes
                are text, what a picture may be sent as, and what stored history
                keeps — loaded by the page as its own script and required by the
                tests, so both run the same code
auth.js         session-cookie signing and credential checking
github.js       AES-256-GCM sealing for the stored GitHub token
server.js       zero-dependency static server + the login and GitHub routes
test/           node --test suite for server.js, chatlib.js, auth.js, github.js,
                the GitHub tools, the conversation store, and a boot check that
                runs index.html's script against a stub DOM
.github/        CI: lint + tests on every push and a PR, and the browser smoke,
                which renders the page in headless Chrome and is the only check
                that can see the wiring between a rule and the DOM it changes
```

</details>

<br>

<img src="docs/readme/divider.svg" alt="" width="100%">

<a name="disclaimer"></a>

## ⚠️ Disclaimer

FreeAi4U is an unofficial client — it is not affiliated with OpenAI or Puter. Usage is billed to your own Puter account under Puter's terms, not this project's. Conversations are stored only in your browser — the text in `localStorage` (the last 50, each capped at 200 messages) and the pictures themselves in an IndexedDB index beside them. Clearing site data or switching browsers loses them; there is no server-side copy to restore from.

<p align="center">
  <sub>MIT licensed · Built on <a href="https://puter.com">Puter.js</a> · <a href="#contents">Back to top ↑</a></sub>
</p>
