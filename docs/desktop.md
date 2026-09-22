# Desktop app (Windows)

`NeuraOS Desktop` is a native Tauri 2 app: its own window, sidebar, tray icon and installer. The AI engine is the NeuraOS server (Railway by default) — the same one the web app and the Android app use — so chat, images and builds all run on free models with the keys staying server-side.

## Install

1. Download the installer from **[desktop-latest](https://github.com/tradernonymous/freeopenai/releases/tag/desktop-latest)**.
2. Double-click it. If Windows says *"Windows protected your PC"*: **More info → Run anyway** (the exe is not code-signed). The installer downloads and installs the **Microsoft WebView2 runtime** automatically if the machine does not have it — that runtime is what draws the window, and its absence is why older builds could open blank and close.
3. Sign in once if the server asks. The session is kept in the app's own profile.

> [!TIP]
> The portable exe skips the installer. If WebView2 is missing on the machine, the app says so with a download link instead of opening a blank window.

## What you get

- **Chat** with real token streaming, markdown + code blocks (copy button), Stop and Retry, and per-chat provider/model pickers with the free-tier limit on the row. Chats are saved on the machine and resume where you left them; History can export or import them as a JSON file.
- **Chat · Plan · Build** modes. Build mode starts a real remote build session: watch the steps live, read the diffs, **Approve / Reject** each change, answer the build's questions, cancel.
- **Local**: open a folder on this machine and read it — a real file tree, a read-only viewer, and a terminal that runs commands *here* (with a cwd that follows `cd`) rather than on the engine. Nothing is uploaded and nothing is written without asking. The panels in the sidebar are the local ones; the engine's own workspace and terminal live under Settings → Advanced.
- **Images** on the engine's free image models (Free FLUX first, Puter only when you switch it on), with a gallery and save-to-disk.
- **Builds** screen for the full session list, plan composer and live event stream.
- **Library**: every skill the engine serves, with its full SKILL.md, plus the chats stored locally.
- **Settings**: the engine address (Test + save), sign-in, provider health with free-tier limits, the rate-limit retry budget, and the memory the model saved — forget any fact.

The rail has five destinations. The screens that overlapped live inside one as its tabs: **Chat** holds Builds, **Code** holds Local and Files, **Library** holds Images. A destination reopens on the tab you last used.

| Shortcut | Does |
| :-- | :-- |
| `Alt+1` | Chat |
| `Alt+2` | Code |
| `Alt+3` | Design |
| `Alt+4` | Library |
| `Alt+5` | Settings |
| `Ctrl+K` | The command palette — every screen, tab, panel and action |
| `Ctrl+N` / `Ctrl+M` / `Ctrl+T` | New chat / pick the model / open or fold every tool card |
| `Ctrl+H` / ``Ctrl+` `` | History / terminal dock |
| `Ctrl+Shift+Z` | Zen mode |
| `Enter` / `Shift+Enter` | Send / newline in the composer |

Every shortcut above except the destinations comes from one table ([`shared/keymap.js`](../shared/keymap.js)). **Settings → Shortcuts** shows it, lets you remap any row, names a clash as soon as you make one, and has a master switch. With shortcuts off, Ctrl+K, Esc and Ctrl+Shift+Z still work, so you can always get back.

### The composer

The chat has no header any more. Everything about the next message is in the composer:

- **Modes.** Tab / Shift+Tab cycles **Chat → Plan → Build**, shown as a coloured label and border. Plan offers the model read-only tools only. Typing `!` at the start switches to **Shell**: the line runs in the open folder, and its output shows in the thread and goes to the model with your next message. `/design` sends the brief to the Design studio. Backspace at the start, or Esc, leaves a mode.
- **`/` commands.** `/new /history /plan /build /interview /implement /review /model /tools /mcp /copy /export /settings /help`, plus every skill as `/skill:<name>`. `/interview` → `/plan` → `/implement` → `/review` is a workflow: after each reply, a chip offers the next step.
- **`@` mentions.** One menu for this service's models, the other services, files at the top of the open folder (attached as text) and MCP servers.
- **Model chip** in the composer footer, with a dot that lights when tools are on. Send and Stop are one button, and Esc stops a reply.
- **Up** in an empty box brings back your last message. `/copy` and `/export md|json` include tool calls and their results.
- **Right-click** a reply for Copy, Explain, Rework, **Branch** (a new chat with the thread up to that point) and **To Design**.

## The local folder

Everything else this app does is the engine's work: chat, images, builds, and the engine's own workspace. The **Local** screen and the **Folder** / **Terminal** panels are the app's own, and they are the first surfaces here that work with no engine at all.

The shell owns the filesystem and the process, and it is confined to one folder. The rules are the engine's own `resolveInside()` + `protectedPath()`, ported rule for rule (`src-tauri/src/local.rs`):

- a path is always relative to the open folder — an absolute path, a drive letter or a NUL byte is refused outright;
- `..` may climb only while it stays inside the folder;
- the nearest existing ancestor is canonicalised and re-checked, so a symlink or a Windows junction cannot carry a write outside;
- `.git` internals and secrets files (`.env`) are readable but **never** written;
- a command that is destructive by nature (the list is the shell's: `git push`, `rm -rf`, `git reset --hard`, `Remove-Item -Recurse -Force`, `shutdown`, …) is refused unless the caller says a human approved it — and in the terminal that refusal is a prompt with **Run it anyway** / **Cancel**, in the rule's own words.

The frontend carries the same rules in `src/local-fs.js` so a path can be refused with a readable message before crossing into Rust, and `test/desktop-local.test.js` reads the Rust constants and asserts the two lists are identical — the same guard `test/desktop-net.test.js` puts on the host allowlist.

Two things the terminal does that a submit button does not: **`cd` is decided in the frontend** (a child process could never hand the change back), which is what makes `cd desktop && npm test` one line, and **output streams** — the shell emits a `local-run` event per line and the settled result replaces it, so the final block still carries the exit code, duration and truncation. Streaming is a nicety, not the mechanism: if no event ever arrives the result is still rendered.

Read-only is on purpose. `local_write_file` and `local_edit_file` exist in the shell for the coding agent (P7) to use behind its approval; the viewer is not that agent.

Verified through the real surface: `pwd` reflects `cd`, `git status` runs in the picked folder, a destructive command stops at the prompt, and `..\..\Windows\System32` is refused with the reason.

## First run (and every time the engine is unreachable)

The app shows a **connect surface** whenever the user can do something about the state, and never for the states they cannot:

| What the engine said | What you see |
| :-- | :-- |
| It never answered | *Connect to an engine* — the address field, ready to change |
| It wants a login | *Sign in to this engine* — the same card, with the form |
| It is failing on its side (5xx) | The app, with a banner saying so |
| Nothing yet (first probe in flight) | The app — no connect card flashes at a working install |

Settings stays reachable from the connect surface, and saving a new address there re-probes the shell, so fixing a wrong address moves the app on without a restart. The rule lives in `src/onboarding.js` (pure, tested); the wording lives in `src/connection.js`.

Earlier builds did the opposite: `loginRequired && !signedIn` hid *every* screen including Settings, so on a login-gated engine a fresh install was a locked door, and the banner said "cannot reach the engine" for what was actually a missing sign-in.

## The engine address

The desktop talks to `https://freeopenai-production.up.railway.app` by default. Settings → **Engine server** accepts any NeuraOS server: `https://` anywhere, `http://localhost` for a self-hosted engine. Test + save; the choice is remembered. The window title bar tells you when the engine cannot be reached.

## WebView2 (the blank-screen fix)

The window is drawn by Microsoft's WebView2 runtime. Machines without it used to show a blank window that vanished — nothing in any log. Now:

- the **installer** installs the runtime on first setup (`webviewInstallMode: downloadBootstrapper`), and
- the app itself checks the registry keys at startup and shows a message box with [the download link](https://go.microsoft.com/fwlink/p/?LinkId=2124703) if the runtime is still missing.

A crash log catches anything else that goes wrong before the window exists. It lives next to the app's own data (`%LOCALAPPDATA%\FreeAI4U\logs\freeai4u-crash.log`, or the Tauri log directory once the app is up) and is capped at 256 KB — a crash loop replaces it rather than filling the disk. The error dialog names the exact file.

Closing the window hides the app to the tray; **Quit** (tray menu) is a clean exit through Tauri, so the window position is saved and the WebView2 child processes are reaped.

## Updates

CI writes `desktop-version.json` into the `desktop-latest` release — the real version plus a `sha256` and byte size for every artifact, taken from the files it just built. The app fetches that file (three attempts with backoff, straight from the release CDN rather than the rate-limited GitHub API) and offers the update only when the published version is **strictly newer** than the running one. The banner names the installer, its size, and its sha256 on hover; dismissing it silences that version until a newer one appears.

The fetch runs **through the shell**, not the webview: a page may not read a release asset (`objects.githubusercontent.com` sends no `Access-Control-Allow-Origin`), which is why earlier builds never showed the banner even though the release published correct metadata. For the same reason the banner's **Download and install** button downloads the installer through the shell, checks the published `sha256` while it streams, and only then runs it — a mismatch deletes the file and reports it. In a plain browser (no shell) the button opens the release page instead, which is the honest fallback.

## The shell's network edge

Every "we cannot reach it" failure in this app had one shape: work a webview is not allowed to do, being done inside the webview. `remote_get` and `remote_download` (`src-tauri/src/net.rs`) do it in Rust instead, under rules a page cannot bend:

| Rule | Why |
| :-- | :-- |
| https anywhere on the allowlist; `http` only on loopback | a local llama.cpp or sd.cpp server is the only plain-http thing this app talks to |
| Every redirect hop is checked (redirects are followed by hand) | a release download redirects to `objects.githubusercontent.com`; reqwest's own policy would follow one to a host the allowlist never saw |
| `sha256` verified while streaming; a mismatch deletes the file | integrity that is checked, not just published |
| A download with no published digest reports `verified: false` | trust-on-first-use, labelled as such rather than dressed up |
| Only a file inside the app's own downloads folder can be executed | the installer command is not a general "run this path" |
| The file name is sanitised to a base name | a name cannot choose its own path |

`src/net-policy.js` is the frontend's copy of the same rules, so a URL can be refused with a readable sentence *before* it crosses the boundary. `test/desktop-net.test.js` asserts the two host lists are identical, so they cannot drift.

## The shell

Four things make the window read as a product rather than a panel of buttons:

- **One icon set** (`src/components/Icon.tsx`), drawn here rather than imported: 24x24, 1.6px stroke, `currentColor`, so an icon is the same weight as its label and the same colour as the state it sits in. The sidebar's icons used to be emoji (💬 🖼 🛠 …), which render differently on every Windows build and cannot be aligned, sized or coloured. The typeface is bundled the same way (`@fontsource-variable/inter`, imported in `main.tsx`), so the app looks the same on every machine instead of inheriting whatever Segoe build happens to be installed.
- **`Ctrl+K`** opens a command palette over every screen, action, panel, saved chat and skill (`src/commands.js` holds the registry and the matching rules; `Ctrl+K`, arrows, `Enter`, `Esc`). Before it, the whole keyboard story was the Alt keys in the table above.
- **Toasts** (`src/toasts.js`) replace a `setTimeout` hint in the sidebar: queued, dismissible, announced with `aria-live`, repeats refresh instead of stacking, and a failure can be sticky until it is dealt with.
- **A status bar**: which engine this build is pointed at, whether it answered — and what it *wants* (an engine that reports healthy while refusing every call says *sign-in required*, not *connected*) — plus an available update and the version.

Three more rules came out of using it, and they are what stop the window reading as a web page in a frame:

- **A choice is one control, not a row of buttons.** The chat header carried three always-present mode tabs (Chat / Plan / Build) that read as navigation while actually being a property of the next message; they became one pill, and since Phase 2 they are a coloured label inside the composer (`src/components/Composer.tsx`), cycled with Tab and explained on hover. The service-and-model pair is likewise one pill (`ModelPicker.tsx`), now in the composer footer, rather than two dropdowns that had to be read as a pair.
- **No operating-system chrome.** Every `<select>` is gone: they open an OS-styled menu with a system font and highlight colour, which is the one element in a hand-styled window that betrays it. `src/components/SelectPill.tsx` is the app's own control — pill, panel, filter, per-option note — used by Images (service, model, shape), Design (template, service, model) and Files (document type). `test/desktop-images.test.js` walks every `.tsx` and fails if a `<select>` comes back, comments excluded.
- **One failure, one place.** A failed turn is reported *in that turn*: which service and model were asked, the provider's own words, and what to do, with Retry and *try another model* as actions. The red bar at the bottom of the screen that repeated the same failure in shorthand — and, when nothing had failed, printed the engine's retry arithmetic as `rate-limit budget 20s`, which looked like a permanent fault and explained nothing — is gone. What the free tier meters is a quiet line beside the composer (`30,000 tokens/min · 12 of 1000 used today`), and the retry budget itself lives in Settings → *Limits the engine enforces*, where it belongs.

The app is held to its own design bar, by test: every frontend file passes the anti-slop linter this repo ships for generated artifacts (`test/desktop-shell.test.js`), and every text token pair clears WCAG AA in both themes. That gate found real defects when it was written — `--text-3` measured 3.88:1 where the 11-13px hints that use it need 4.5:1, and the light theme's status colours measured 4.1-4.3:1; all were corrected rather than exempted. The same pass made the linter itself more honest: a prompt that says *no lorem ipsum* is an instruction, not shipped placeholder copy, and is no longer reported as one.

## The content policy

`tauri.conf.json` carries a real CSP now instead of `null`, and it is written to allow exactly what the app does:

- `object-src 'none'`, `frame-src 'none'`, `base-uri 'self'`, `form-action 'self'` — no plugin, no frame, no injected base, no posting a form somewhere else.
- `script-src 'self' https://js.puter.com` — the only remote script this app can ever run is the Puter SDK the user asked for by clicking it (Images → Puter). Inline is permitted because the boot guard and the dev server both need it; the value here is that no *third-party origin* can be introduced.
- `connect-src 'self' https:` — the engine address is a setting, so the policy cannot name it in advance; https anywhere is the same reach the app already had. `http` is loopback only, and `ws://127.0.0.1:*`/`ws://localhost:*` are there for the dev server.
- `wss://*.puter.com` for the SDK, and `img-src` includes `data:`/`blob:` because that is how a drawn picture arrives.

## Diagnostics

Settings has a **Copy diagnostics** button. It copies a short report — build version, engine address, what the last engine answer meant, OS/arch, WebView2 version, where the data and cache directories are, and the tail of the crash log — built by `src/diagnostics.js` from facts the shell gathers (`src-tauri/src/diag.rs`). It is safe to paste: query strings are dropped from addresses and anything shaped like `hf_…`, `sk-…` or `Bearer …` is redacted. A failure should not need a screenshot.

## Local models

A model can run on this machine, and it answers in the Chat screen as **Local** — no engine, no network, no quota. Settings → **Local models** is where it is set up.

The binary is the user's. This app neither ships `llama-server.exe` nor downloads one behind their back: **Open the llama.cpp releases** takes them to the page, **I have the file…** takes the file they unzip into the app's own folder (checked by name first — a path is not a licence to run whatever is at it), and the app runs it from there, or from `PATH` if a copy is already installed. A verified download of a release whose digest we have not published would be a claim this app cannot make, so it does not make it.

**My models: Ollama Local and Unsloth Local.** Settings -> Local models starts with the list of models you chose to keep, and a toggle for where to find more:

- **Ollama** is a *connection*, not a folder. The shell asks Ollama's own server (`http://127.0.0.1:11434`, `GET /api/tags`) what it has -- the list `ollama list` and Unsloth Studio's "Connected" tab show -- and Ollama runs them, so nothing listed can be unsupported (its own-engine formats included). **Start Ollama** runs `ollama serve` when it is installed but not answering. All Ollama traffic goes through the shell (`src-tauri/src/ollama.rs`, loopback only): Ollama refuses a Tauri window's origin, and a reply is relayed chunk by chunk as `shell-chat` events.
- **Unsloth / GGUF folder** is *files*. **Browse...** to where the models are (Unsloth Studio's folder, the Hugging Face cache, anywhere); the GGUFs under it are listed with size and fit. They run from where they are with `llama-server -m`, and the app finds **Unsloth Studio's own `llama-server.exe`** (`~/.unsloth/llama.cpp/build/bin/Release`) so nothing has to be downloaded.

**Add** remembers a name or a path (`src/saved-models.js`; nothing is copied) and **Remove** forgets it. Added models appear in the **Chat, Design and Code** pickers under two providers, *Ollama Local* and *Unsloth Local* -- a provider exists only while it has a model. Picking an Unsloth Local model loads it (or swaps it in) before the first reply. Remote **Builds** run on the engine, which cannot reach a model on this PC, so they keep using the engine's providers.

**Run settings** (the gear next to the model in Chat, `components/RunSettings.tsx`, rules in `src/run-settings.js`): estimated memory with a RAM verdict and a GPU verdict once you type your VRAM, context length (Auto + slider), GPU layers and threads, sampling (temperature, top-p, top-k, min-p, repeat penalty), a system prompt, **Remember for this model**, presets, **Eject model**. Context/GPU layers/threads are load-time for llama-server, so changing them shows **Reload model**; Ollama takes everything per message, so it never reloads.

**The weights are the app's business** (Phase 0 of the roadmap). Settings → Local models has four ways in, top to bottom:

1. **Add from Hugging Face** — paste a repo (`unsloth/gemma-4-E4B-it-GGUF`), a model page link, a folder link or a `.gguf` file link (`src/local-models.js` `parseHfRef` reads all of them, and a `neuraos://model?repo=…&file=…` deep link). The app lists the repo's GGUF files with quant, size and whether they fit this machine, marks the one it would pick (`pickDefaultFile`: Unsloth's `UD-Q4_K_XL` first, never a split part, never a 1-bit quant — Unsloth's guide says those break tool calling), and **Download** streams it into `<app data>/models` with a progress bar (`models.rs` `local_model_download`, `local-download` events). A download lands in `<name>.part` and is renamed only when whole; a `.part` left by a pause or a crash is **Resumed** with a Range request. One download at a time.
2. **Recommended** — Unsloth Dynamic quants, one file each, smallest first, sizes read from the Hub.
3. **Downloaded** — what is in the models folder, with Start and Delete.
4. **Already on this PC** — GGUFs another tool downloaded (the Hugging Face cache, Unsloth Studio, LM Studio, or any folder you choose) run from where they are. Safetensors cannot: llama-server needs GGUF.

Start passes `-m <file>` for a file the app has, or `-hf <repo>:<quant>` for a repo it has not fetched (llama.cpp's own downloader, silently). Every start adds `--jinja` — without it the OpenAI `tools` field is ignored — and a random `--api-key` that the chat sends as a bearer token, so nothing else on the machine (or a web page in a browser) can use the port. The server is started on `--host 127.0.0.1` only, and the app reaps the child on quit: a model server left running after the window is gone is a process the user cannot see.

"Use this model" on Hugging Face lists local apps that Hugging Face itself maintains; NeuraOS appears there only after an upstream pull request, which needs a public release first. Until then the `neuraos://` scheme is registered (`tauri-plugin-deep-link`) and any link of that shape opens Settings with the model looked up; nothing downloads on the strength of a link.

`--ctx-size` and `--threads` come from the machine, and the **memory guard** is the part that matters: starting a model the machine cannot hold is the one way this feature can freeze a computer, so `src/local-models.js` estimates weights + KV cache + overhead against the memory the browser reports (which is rounded down and capped, so it is treated as a floor), refuses what does not fit, and says the numbers. A model that only just fits is called *tight* rather than comfortable.

Lifecycle in one rule: a server that has not answered `/health` is **starting**, never *ready* — a model that has not loaded cannot answer, and saying it is ready is how a first message disappears into a void.

## Tools in Chat (Phase 1)

A model in Chat can ask for things, on **every** provider -- the engine's, Hugging Face, Ollama Local, Unsloth Local. The rules are in [`src/tools.js`](../desktop/src/tools.js) (pure, node-tested), the loop in `src/agent-turn.ts`, the executor in `src/tool-run.ts`, the cards in `components/ToolCards.tsx`.

- **What is offered** depends on what is connected: `web_search` and `web_fetch` always; the nine `github_*` tools (the same names as the web app's) only while a GitHub account is connected; `list_files`, `read_file`, `write_file`, `edit_file`, `run_command` only while a folder is open in the app; and `mcp__<server>__<tool>` for every MCP server added in Settings.
- **Reading is free; changing asks.** Every file write, command and commit -- and every MCP tool, whose effects this app cannot know -- shows an **Allow / Deny** card in the conversation before it runs. A write can never be "always allowed"; an MCP *server* can be trusted ("Always for this server"). A Deny is told to the model as an answer, so it carries on without the tool.
- **Where each tool runs:** web, GitHub and MCP go to the engine (`/api/llm/websearch`, `/api/llm/fetch`, `/api/github/*`, `/api/mcp/call`); the file and command tools go to the shell, confined to the open folder by `local.rs`.
- **The loop** streams, collects tool calls out of the stream (OpenAI deltas or Ollama's whole calls), runs them, hands the results back and streams again, up to 8 rounds. A provider that refuses `tools` outright gets the turn again without them, once, and says so.

**Settings -> Connectors** holds the switch for tools, the **GitHub** accounts (several, like the web app; Connect opens the engine's sign-in in a *window of this app*, because the engine keys the connection to its session cookie and the system browser has another cookie jar), and the **MCP servers** (remote https servers reached through the engine; their tools are read when the server is added). MCP servers on this PC (stdio) are the next step of docs/adr/0001.

## Hugging Face integration

Library → **Hugging Face** lets the user sign in with one click when the build (or Settings → Connectors) has an OAuth client ID -- see *One-click Hugging Face sign-in* -- or with a Hugging Face **access token** ([`src/hf-auth.js`](../desktop/src/hf-auth.js) `beginOAuth` / `useToken`). **Sign in to Hugging Face** opens HF's token page with *Make calls to Inference Providers* already ticked; the pasted token is checked against `whoami-v2` before it is kept. The same button is in Chat and in Settings → Connectors. It lets the user search the Hub for GGUF models ([`src/hf-models.js`](../desktop/src/hf-models.js)), see available quants with sizes and RAM estimates, and download files for use with the local llama-server. Under the shell the token lives in the **OS credential store** (Windows Credential Manager, `src-tauri/src/secrets.rs`, service `NeuraOS Desktop`), read once at boot into memory; a token an older build left in `localStorage` is moved there on the first run and removed. In a plain browser build it stays in `localStorage` under `freeai4u.hf_token`. It is never sent to the engine. Because the token carries the Inference Providers permission, it also works for chat through the Hugging Face router (`src/hf-inference.js`).

The model browser shows each GGUF file's quant tag (`Q4_K_M`, `Q8_0`, `F16`, etc.), a rough RAM fit estimate (`fits 8GB`, `fits 16GB`), and whether the repo is gated. Gated repos require the HF token to unlock downloads.

### One-click Hugging Face sign-in

With an OAuth client id, **Sign in with Hugging Face** is one click: the shell listens on `http://127.0.0.1:47823/hf/callback` ([`src-tauri/src/hf_oauth.rs`](../desktop/src-tauri/src/hf_oauth.rs)), HF's authorize page opens in the browser, and after **Authorize** the token arrives on its own (authorization code + PKCE, no client secret; `beginOAuth` in [`src/hf-auth.js`](../desktop/src/hf-auth.js)). The shell checks the returned `state`, trades the code at `https://huggingface.co/oauth/token`, and the token is checked against `whoami-v2` and kept in the credential store like a pasted one (`source: "oauth"`); it is renewed with its refresh token when it runs out. Without a client id the button is the access-token flow above, with a **Set up one-click sign-in** link here.

Register the app once (it is free):

1. Open <https://huggingface.co/settings/applications/new> while signed in to the account that should own the app.
2. **Application name:** `NeuraOS`. **Homepage URL:** `https://github.com/tradernonymous/freeopenai`.
3. **Redirect URI:** exactly `http://127.0.0.1:47823/hf/callback` (127.0.0.1, not localhost; the port is fixed, so if something else holds 47823 the sign-in says so and the token paste still works).
4. **Scopes:** `openid`, `profile`, `read-repos` and `inference-api` (the last one is what lets the token call Inference Providers; `hf-auth.js` `SCOPE` asks for exactly these four).
5. Create it and copy the **Client ID**. There is no secret to keep: the app is a public client and PKCE is the proof.
6. Build it in: `gh variable set NEURAOS_HF_CLIENT_ID --body <client-id>`. The *Build Tauri app* step of `desktop.yml` passes it to the compiler (`option_env!("NEURAOS_HF_CLIENT_ID")`), so the next release has the button. To try it without a rebuild, paste the id into Settings → Connectors → Hugging Face → **OAuth client ID** (stored in `localStorage` as `freeai4u.hf_client_id`; it overrides the built-in one, and clearing it goes back).

## Desktop reach, parity and evals (Phases 5 and 6)

- **Quick window.** `Alt+Space` from any app opens a small always-on-top window on the model your latest chat uses (`src-tauri/src/quick.rs`, `screens/QuickAsk.tsx`). Esc hides it; **Continue in NeuraOS** saves the exchange as a chat and opens it in the main window. Change the chord in Settings → Shortcuts; a chord another app already owns is reported.
- **Notifications.** A tool waiting for your Allow, or a reply that took more than 15 seconds, shows a Windows notification and flashes the taskbar button -- only when the main window is not in front.
- **Read aloud** is on a reply's right-click ring, using the voices Windows has.
- **Reasoning.** Thinking a model streams (DeepSeek, Qwen, llama-server's default) appears as a folded *Thought* block and is not sent back in the history. `/reasoning off|low|medium|high` sets `reasoning_effort` for models that take it.
- **HTML blocks** in a reply have **Preview** (sandboxed, in place) and **To Design**.
- **Attachments.** The paperclip (or `/attach`) reads PDF, Word, Excel, PowerPoint and text files into the message, with a token estimate.
- **Compare** (`/compare`, or the ring): one prompt on two or three models -- local and cloud -- side by side with timings.
- **`/memory <fact>`** saves a fact; **`/share`** copies a read-only link.
- **Evals** (Library → Evals): eight tasks scored by code -- a number, a JSON object and array, an exact list, three lowercase words, extraction, a trick question, tool-call arguments -- across the models you pick, with pass rate, average time, a per-task grid and CSV export (`src/evals.js`).

The app's windows need a Tauri **capability** to hear shell events at all (`src-tauri/capabilities/default.json`, `core:default` for `main` and `quick`). Before it existed, no event -- GitHub sign-in finished, Ollama replies, download progress, deep links -- reached the frontend.

## Local coding agent

Code screen (sidebar → **Code**): describe a change, watch the agent plan it, approve real diffs, and have it edit files and run commands on this machine. The agent loop ([`src/coding-agent.js`](../desktop/src/coding-agent.js)) mirrors the engine's `agent-sessions.js` pattern: plan → steps → tool calls → approval gate → result feedback.

Tools: `list_files`, `read_file` (read-only, immediate), `write_file`, `edit_file`, `run_command` (mutating, approval-gated). Every write goes through the Rust shell's confinement rules ([`src-tauri/src/local.rs`](../desktop/src-tauri/src/local.rs)), and destructive commands show the approval card with a diff or command preview.

The agent reads `AGENTS.md` and `CLAUDE.md` project notes at the start, and the model source is the same `streamChat` / `streamLocalChat` in `api.ts` — the user picks the provider.

### Code helpers, editor, Docker sandbox, language servers (Phase 12e)

**Helper agents.** Three more built-ins in [`src/agents.js`](../desktop/src/agents.js), run with `/agent <id> …` in Chat or through `spawn_agent`. Each write, edit, command and push still shows its own Allow card.
- `test-writer` reads a file and finds the project's own test framework. It writes tests next to the file and runs them with `run_command`. It then fixes the *tests* at most twice.
- `doc-writer` adds docstrings or JSDoc using `edit_file` only. It changes comments and nothing else.
- `pr-opener` reads `git status` and `git diff`, then switches to a new branch. It commits the named files (never `git add -A`) and runs `git push -u origin <branch>`. It opens the PR with `github/create_pull_request` when the official GitHub MCP server is added as `github`. Otherwise it uses `gh pr create`, or as a last resort gives the compare URL. The built-in GitHub connector has no tool for creating a PR.

Recipes have no built-ins. To get recipe versions of the helpers, paste this into Library → Recipes → Import:

```json
{"recipes": [
  {"id": "write-tests", "name": "Write tests", "prompt": "Use the test-writer agent (spawn_agent) to write and run tests for {{file}}.", "params": [{"name": "file", "label": "File"}]},
  {"id": "add-docs", "name": "Add doc comments", "prompt": "Use the doc-writer agent (spawn_agent) to document {{file}} without changing behaviour.", "params": [{"name": "file", "label": "File"}]},
  {"id": "open-pr", "name": "Open a PR", "prompt": "Use the pr-opener agent (spawn_agent) to open a pull request for my uncommitted changes. {{notes}}", "params": [{"name": "notes", "label": "Notes", "default": " "}]}
]}
```

**Editor.** On the Local screen, **Edit** opens the file in Monaco. `monaco-editor` is loaded as a dynamic import the first time you use Edit, so it is never part of the main chunk. Its workers are Vite `?worker` bundles, and nothing comes from a CDN because the CSP forbids remote scripts. The language is picked from the file extension. Ctrl+S saves through `local_write_file`, so the shell's confinement rules apply. A dot shows unsaved changes, and **Discard** drops them. The read-only viewer is still the default. A file that was only partly read (over 1 MB) or is binary cannot be edited.

**Docker sandbox (opt-in).** To turn it on, go to the Code screen and tick **Run agent commands in Docker**. The image defaults to `node:22-bookworm`, and the setting is saved in `localStorage["freeai4u.docker_sandbox"]`. Once it is on, every approved `run_command` from the Code and Parallel screens runs as `docker run --rm -v "<root>:/work" -w /work <image> sh -lc "<command>"`. The wrapper lives in [`src/docker-sandbox.js`](../desktop/src/docker-sandbox.js). The first run checks `docker version` once. If Docker Desktop isn't running, it says so and runs nothing. What it isolates: everything outside the project, meaning the rest of the disk and your programs and home folder. **The project folder itself is mounted read-write, so a command can still change or delete project files.** A command containing `"`, `` ` ``, `$`, `%`, `\` or a line break is never put on that line, because the host shell (cmd or sh) would rewrite it, and it is never guessed at or escaped. Instead it runs in **script-file mode**: the command is written byte for byte to `.neuraos/sandbox-<id>.sh` in the project through the same confined write the agent's `write_file` uses, run as `docker run --rm -v "<root>:/work" -w /work <image> sh /work/.neuraos/sandbox-<id>.sh`, and the file is deleted afterwards (`del /q` or `rm -f` in the project folder), whether the command succeeded or not. Only the container's `sh` ever reads it. Two things are still refused: a NUL character, which no shell can carry, and a working folder that escapes the project (`..`, an absolute path). Git worktrees (Parallel) mount only the worktree, so `git` commands inside the container cannot reach the main `.git`.

**Language servers via MCP.** In Settings → Connectors, **Language server (LSP) MCP** fills in the "On this PC" form with the name `lsp`, the command `npx`, and the arguments `-y <package> <args>`. This app does not name an LSP-over-MCP npm package, because no such package could be confirmed. Pick a maintained server yourself, replace the placeholders, and choose Add and start. The form refuses to save while a placeholder is still in it. The server's tools reach agents as `lsp/*`.

### Local dictation and design exports (Phase 12f)

**Local Whisper.** Settings → Dictation sets up dictation that runs on this PC through your own [whisper.cpp release](https://github.com/ggml-org/whisper.cpp/releases/latest). The app bundles and downloads nothing. **Choose whisper-cli…** remembers the path in `<app data>/whisper/binary.txt`. `whisper-cli.exe` or `main.exe` on PATH are also found, but a `main.exe` only counts when `whisper.dll` is beside it. Put ggml models ([downloads](https://huggingface.co/ggerganov/whisper.cpp/tree/main), e.g. `ggml-base.en.bin`) in `<app data>/whisper-models` or next to the binary. The mic records as usual. [`src/dictate.ts`](../desktop/src/dictate.ts) decodes the recording and [`src/wav.js`](../desktop/src/wav.js) turns it into 16 kHz mono 16-bit WAV. [`whisper.rs`](../desktop/src-tauri/src/whisper.rs) then runs `whisper-cli -m <model> -f <wav> -otxt -of <tmp> -nt [-l <lang>]` directly, with no shell. The run gets a 120 s limit and is killed if it goes over. Temp files are removed whatever happens. `localStorage["freeai4u.dictation_engine"]` picks the engine: `auto` (the default) uses this PC when a binary and a model are found, then Hugging Face when you are signed in, then the Win+H hint. `local` and `hf` force one engine.

**Component palette.** The Design inspector has a **Components** tab: button, card, input, nav bar, hero, stat tile, table, modal, badge and footer, from [`design/components.js`](../desktop/src/design/components.js). Each one is styled only with the page's tokens (`var(--accent, …)`), so it follows the system and Tweaks, and each passes the anti-slop linter. Clicking one adds its CSS to the head once and its markup before `</main>` (else `</body>`), saved as a new version.

**Framework exports.** Export → **React component (.tsx + .css)** is a deterministic conversion. The page body becomes JSX (`className`, `htmlFor`, style objects, self-closing void tags), with the page CSS in `<Name>.css` and the tokens in `tokens.css`, all zipped together. Inline scripts and `on*` handlers are dropped, and a comment in the file says so. **Flutter widget (AI)** and **SwiftUI view (AI)** have no honest mechanical mapping, so they ask the model picked on the left to translate the page, with the tokens as theme constants. The code block from the reply is then saved as a `.dart` or `.swift` file.

## Remote handoff

The build screen can now hand off a local workspace to the engine: the Rust shell packages the folder, uploads it, creates a build session, and streams the build events back via SSE. The user approves and rejects diffs exactly like a local build, but the heavy lifting runs on the engine. Orchestrated by [`src/remote-handoff.js`](../desktop/src/remote-handoff.js).

## Signing

The installer and the portable exe are **not signed**, which is why Windows SmartScreen shows *"Windows protected your PC"* the first time somebody runs a fresh download. That is a certificate, not code: an Authenticode certificate is issued to a verified legal identity, and the identity check is the user's to make.

The pipeline is already wired for it. `bundle.windows.certificateThumbprint` is declared in `tauri.conf.json`, and the Desktop workflow signs when the repository has the secrets — no code change, no rebuild of the process:

| Secret | What it is |
| :-- | :-- |
| `WINDOWS_CERTIFICATE` | The `.pfx` bundle, base64-encoded |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password |

**Or Azure Trusted Signing** (Microsoft's managed signing, about US$10/month, no .pfx and no hardware token; individuals can sign up after an identity check). In the Azure portal: create a *Trusted Signing account*, complete identity validation, create a *certificate profile* (Public Trust), and give an app registration the *Trusted Signing Certificate Profile Signer* role on the account. Then:

```
gh secret set AZURE_TENANT_ID
gh secret set AZURE_CLIENT_ID
gh secret set AZURE_CLIENT_SECRET
gh variable set TRUSTED_SIGNING_ACCOUNT --body <account name>
gh variable set TRUSTED_SIGNING_PROFILE --body <certificate profile name>
gh variable set TRUSTED_SIGNING_ENDPOINT --body https://<region>.codesigning.azure.net
```

The Desktop workflow installs `trusted-signing-cli` and hands Tauri a `signCommand`, which signs the app exe and both installers; the same verification step below checks the result. The .pfx secrets win if both are set.

Either way, SmartScreen trusts a signed build by publisher reputation, which a new certificate earns over the first downloads rather than instantly.

With both set, CI imports the certificate, builds with its thumbprint, and **verifies** the signature on the installer and the portable exe — a build that claimed to be signed but is not fails the job rather than shipping quietly. Without them the build is unchanged, and the release notes say unsigned, so nobody has to guess which one they downloaded.

### Update signing

Separate from Authenticode, and free: the release's `desktop-version.json` (the version and every installer's sha256) can be signed with a `tauri signer` key. A build that carries the public key fetches `desktop-version.json.sig` too and refuses a manifest that is unsigned or signed by anyone else (`net.rs` `update_manifest`); since each download is then checked against the signed sha256, the installer is covered as well. It turns on once, from the `desktop` folder:

```
npx tauri signer generate -w %USERPROFILE%\freeai4u-keys\neuraos-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY < %USERPROFILE%\freeai4u-keys\neuraos-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
gh variable set NEURAOS_UPDATER_PUBKEY < %USERPROFILE%\freeai4u-keys\neuraos-updater.key.pub
```

Keep the key file and its password backed up: losing them means installed copies can only be updated by hand. The job fails if the public key is set without the private one, because that build would refuse its own updates.

## Where chats are stored

In the installed app, chat history lives in `chats.sqlite3` in the app data folder (`%APPDATA%\<bundle id>` on Windows), not in localStorage, so there is no quota and pictures stay in every chat. Each chat is encrypted in the page before it reaches the shell: AES-GCM-256 via WebCrypto, a fresh 12-byte IV per write, stored as `base64(iv || ciphertext)` (`src/chat-crypto.js`). The key is random, made on first run, and kept in the OS credential store (service "NeuraOS Desktop", entry `chat_key`); the database never sees a message or the key. `src-tauri/src/chat_store.rs` is a plain row store (`chats(id, updated_at, blob)`, WAL, one transaction per batch).

`src/chats.js` still owns the logic: an in-memory cache answers every screen's synchronous reads and writes, and a debounced flush sends only the chats that changed. On the first run the old localStorage history is copied in, read back, and only then removed. If the shell, the key or the database fails, the app says so once and keeps using localStorage exactly as before; the browser build always uses localStorage. Export/import in History works from the cache either way, and History shows a tip to export now and then.

Edits are held for 400 ms before they are flushed. Closing or reloading the window flushes at once (`pagehide` / `beforeunload`). The tray **Quit** does not rely on that: the shell emits `app-quitting`, the page flushes and calls `quit_ready`, and the app exits then, or after 800 ms if the page does not answer (`main.rs`).

**If the key cannot open the chats.** If the `chat_key` entry is missing or unusable, or does not open the rows that are in `chats.sqlite3`, no new key is made over them. Instead the app shows a notice once with two choices:

- **Start fresh (keep the old file)** renames the file to `chats.unreadable-<unix time>.sqlite3` beside it (`chat_store_set_aside`), copies the old key, if there is one, to the entry `chat_key.unreadable-<unix time>`, and makes a new key and an empty store. Chats written to browser storage in the meantime move into it.
- **Keep using browser storage for now** changes nothing; the notice comes back next launch.

Nothing is ever deleted, so a recovered key can still open the old file. The one copy that survives a lost key is an export, so export chats you care about.

## Opening files and folders

Double-clicking a `.gguf` opens NeuraOS and adds it to **My models**; right-click a folder (or the empty space inside one) → **Open in NeuraOS** makes it the working folder. The association is the bundle's (`fileAssociations`); the folder verb is written per user by the NSIS hook `src-tauri/windows/hooks.nsh` and removed on uninstall (the MSI does not add it). `DESIGN.md` is a file name, not an extension, so it is not associated — open its folder instead.

## Code map

Each concern has one owner, and the shell (App.tsx) composes rather than implements.

| Module | Owns |
| :-- | :-- |
| `src/api.ts` | Transport only: the engine address, `request`, the SSE stream, the route table |
| `src/connection.js` | What an engine outcome *means*: `kind` (ok / unreachable / signed-out / refused / rejected / engine-error / no-reply) and the copy for it — the error message and the shell banner |
| `src/onboarding.js` | Which surface the shell shows (`connect` or `app`), why (`checking` / `first-run` / `unreachable` / `signed-out` / `ready` / `degraded`), and which failures deserve a banner |
| `src/components/ConnectionCard.tsx` | The engine address, the probe and the sign-in form — one owner, used by the connect screen and by Settings |
| `src/screens/ConnectScreen.tsx` | The way in: the headline, the advice, the card |
| `src/chats.js` | The chat store: its key, the 500-session cap, the shell-store cache and flush (see "Where chats are stored"), validation, merge, recency order, export/import. Chat, History, Library and the shell all read it here — no one else spells `freeai4u.chats` |
| `src/update.js` | Release policy: version parsing/comparison, the payload, retry with backoff |
| `src/useUpdateCheck.ts` | The React binding for it: polling, the dismissed version, the installer |
| `src/theme.ts` | The theme value, its key, and applying it |
| `src/run-result.js` | A run response (engine or local) turned into the terminal's display block |
| `src/local-fs.js` | The local folder's rules: the frontend's copy of the shell's confinement and approval lists, `cd`/`pwd`, and what a file row is |
| `src/components/LocalTerminal.tsx` | The local dock: a live cwd, streamed output, the inline approval for a destructive command |
| `src/components/LocalTree.tsx` | The open folder, one level at a time, labelled by what each file is |
| `src/screens/LocalScreen.tsx` | The LOCAL screen: the empty state that invites picking a folder, the tree, the read-only viewer |
| `src/screens/CodeScreen.tsx` | The CODE screen: the local coding agent with approval UX, diff view, and step timeline |
| `src/useLocalRun.ts` | The React binding for `local-run` events |
| `src-tauri/src/local.rs` | The real filesystem and command runner, confined to the open folder, with the engine's wording |
| `src/failure.js` | Why a turn failed: what was asked, the provider's own words, and one sentence of advice |
| `src/images.js` | Which image service draws, with which model, at which shape — and the curated Puter chains |
| `src/puter.js` | The Puter SDK, injected only when the user picks it |
| `src/local-models.js` | The local catalogue, the memory guard, and the lifecycle states |
| `src/hf-auth.js` | Hugging Face sign-in: PKCE via the shell's loopback listener (`hf_oauth.rs`), access-token paste, refresh, token store |
| `src/hf-models.js` | HuggingFace model browser: search, GGUF quants, download URLs |
| `src/coding-agent.js` | Local coding agent: plan→approve→edit→run loop, tool parsing |
| `src/remote-handoff.js` | Remote handoff orchestrator: package workspace, push to engine, SSE stream |
| `src/hf-inference.js` | HuggingFace Inference API as a chat provider (curated model list, streaming) |
| `src/hf-skills.js` | HuggingFace Skills knowledge pack: load SKILL.md from HF repos |
| `src/components/ModelPicker.tsx` | One pill for "who answers": service and model as one decision |
| `src-tauri/src/models.rs` | The llama.cpp server: find, start, wait, stop — loopback only, reaped on exit |
| `src/files/*`, `src/design/*` | Document extract/generate and the brand + anti-slop engines (UMD, node-tested) |
| `src/main.tsx` | The boot guard: a start failure paints its own message into `#root` instead of leaving an empty window (and only while `#root` is empty, so a running app is never replaced) |
| `src/bridge.ts` | The one place that talks to the Rust shell (`hasShell`, `remoteGet`, `downloadVerified`, `runInstaller`, `diagnosticsFacts`) |
| `src/components/Icon.tsx` | The icon set: one grid, one stroke weight, `currentColor` |
| `src/commands.js` + `components/CommandPalette.tsx` | The palette's registry and match rules, and its list/cursor/keys |
| `src/toasts.js` + `components/Toasts.tsx` | What stacks, what replaces what, what expires — and the surface that shows it |
| `src/components/StatusBar.tsx` | Engine, sign-in, update, version |
| `src/net-policy.js` | The frontend's copy of the shell's network allowlist, and the sentence explaining a refusal |
| `src/diagnostics.js` | The `Copy diagnostics` text, and the redaction that makes it safe to paste |
| `src-tauri/src/net.rs` | The network edge: the allowlist, hand-followed redirects, verified downloads, running a downloaded installer |
| `src-tauri/src/diag.rs` | The facts the diagnostics report is built from |
| `src-tauri/src/main.rs` | Wiring: boot checks, tray, window, plugins, commands |
| `src-tauri/src/crash.rs` | Where a failure is recorded: path, size cap, rotation, hint |
| `src-tauri/src/webview2.rs` | The runtime the window needs, and what to tell a user missing it |
| `src-tauri/src/save.rs` | The native save dialog and its derived filters |

The pure modules (`.js` with a `.d.ts`, loaded for their side effect and read off `globalThis`) are the ones that carry rules; `node --test` runs them directly, so the same code paths the app uses are the ones the tests check.

> [!IMPORTANT]
> Those modules publish their global **unconditionally**, and must keep doing so. The traditional UMD wrapper assigns the global only in the branch taken when it cannot see CommonJS — and inside a Vite bundle it *does* see a `module` object (the interop helper leaves one in scope), so the global was never set. The app then died on its first read of one: a window painted in the app's background colour, with nothing in it, while `vite dev` worked perfectly. `test/desktop-umd.test.js` runs every one of these modules the way the bundle runs it — a `module` in scope, no `require` — so this cannot come back quietly. The shell's Rust rules are asserted from the shell sources as a set (`test/desktop.test.js`), so moving a rule between modules is not a test break.

## The NeuraOS shell

The desktop front end is **NeuraOS**. The engine it talks to is still the
FreeAI4U server, and the crate, the binary, the bundle identifier and the
`localStorage` keys all keep their `freeai4u-*` spelling -- they are what an
existing install and the update path are keyed on, so the rename is a name and
not a new app: an upgrade lands in place, and existing chats and settings
survive it.

What the shell does that a window of tabs does not:

- **Liquid glass, over an ambient layer.** `.app::before` paints two very slow
  gradients under everything, and the floating surfaces are translucent with
  `backdrop-filter`: the rail, the titlebar and status bar, the right panel, the
  docks, the command palette, the toasts and the radial ring. Content that is
  read at length -- chat bubbles, code, forms -- stays opaque on purpose: a
  blurred code block is a worse code block.
- **Zen mode (`Ctrl+Shift+Z`).** The titlebar, the rail and the status bar leave,
  the canvas stays, and a single pill fades in on hover to bring them back. It is
  a mode, not a setting, so it is deliberately not written to disk.
- **The rail.** Icons only, 40px wide, widening on hover or focus to reveal the
  labels and the shortcut for each row. Nothing moves under the pointer while it
  animates, so a hover never turns into a mis-click. The width and the icon size
  are two tokens and every pad is arithmetic on them (`--rail-pad`), so the
  brand badge, the search box and the rows cannot drift onto three different
  centre lines the next time one of them is edited.
- **The palette reaches everything.** `Ctrl+K` is not just navigation: the same
  list starts and stops the local model, opens the build logs and the approvals
  panel, exports the chats, and toggles Zen. A row that resolves to nothing is a
  test failure rather than a keypress that does nothing.
- **Loading a model shows the wait it is actually in.** The chip draws a ring
  against the shell's own warm-up deadline (three minutes, `models.rs`) and says
  "42s of 180s", while the card polls once a second instead of once every
  fifteen. A bar that fills at a pleasing speed would be a lie about a file
  read nobody can see.
- **The radial menu.** Right-click a reply and the actions for what is under the
  pointer open in a ring around it: copy, explain, rework, and retry when the turn
  failed. Placement is [`src/radial.js`](../desktop/src/radial.js) -- a ring that
  opens half off-screen hides exactly the action someone wanted, so the rule is
  pure and tested rather than eyeballed.
- **Smart provider fallback.** [`src/fallback.js`](../desktop/src/fallback.js)
  decides what a failed turn tries next. One switch is taken without asking: a
  rate-limited remote turn is answered by the running local model, because it is
  the same request to a private server and the difference between a wall and a
  reply. Every other switch -- a different remote model -- is a button, because a
  different model is a different answer and that is the user's call.
- **Less transparency and more contrast are answered.** A reader who has asked
  for either gets the opaque panel the glass was standing in for, and the ambient
  layer goes with it: decoration is the first thing to give up, and it is the only
  part of this that costs frames on a weak GPU.
- **A missing runtime offers the install.** The boot check still runs before the
  first window exists, but the dialog now has a button that opens the WebView2
  download (without a console flashing over it) and the crash log records whether
  it was taken. A branded in-app window is the one thing that cannot be built
  there: drawing a window needs the runtime that is missing.

## How it is built

[`desktop/`](../desktop/) is a Tauri 2 + React (Vite + TypeScript) app. The Rust shell (`src-tauri/`) owns the window, tray and the WebView2 check; the React frontend owns the screens and talks to the engine through [`src/api.ts`](../desktop/src/api.ts) — the same routes the web app uses. CI ([`desktop.yml`](../.github/workflows/desktop.yml)) runs the desktop tests (`node --test test/desktop.test.js`, `test/desktop-update.test.js`, `test/desktop-chats.test.js`: config integrity, version agreement, the update-check rules, the chat import/export merge, and that every route the frontend calls exists on the server), the local-confinement suite (`test/desktop-local.test.js`), the IPC/route contract (`test/desktop-contract.test.js`), the shell's own look and its fallbacks (`test/desktop-zen-glass.test.js`), the fallback policy (`test/desktop-fallback.test.js`) and the radial menu (`test/desktop-radial.test.js`), builds the Tauri app on `windows-latest`, writes `desktop-version.json`, and publishes the NSIS installer, MSI, portable exe and that metadata file to the `desktop-latest` release.

## Upgrade roadmap

[`desktop-premium-plan.md`](./desktop-premium-plan.md) is the master plan for the nine phases: the Rust network edge and a working updater, the premium shell pass, local-first files and terminal, llama.cpp + GGUF local models, Sign in with Hugging Face and the Hub browser, Hugging Face inference providers, the local approval-gated coding agent, the Agent Skills knowledge pack, and local images / parallel agents / fine-tuning. It also records what each reference repo (freebuff, codebuff-swe-bench, evalbuff, stagehand, opentui, unsloth and its forks, stable-diffusion.cpp, huggingface.js / skills / huggingface_hub) contributes to which phase.

| Phase | State |
| :-- | :-- |
| P1 — trust spine (network edge, updater, diagnostics, single instance) | shipped |
| P2 — premium shell (icons, palette, toasts, status bar, tokens, bundled typeface, signing pipeline) | shipped |
| P3 — local-first folder, terminal and confinement, LOCAL tab | shipped |
| P4 — local models: llama.cpp + GGUF, the memory guard, `Local` in the picker | shipped |
| P5 — Sign in with Hugging Face + the Hub browser | shipped |
| P6 — Hugging Face as a chat provider (HF Inference API in the model picker) | shipped |
| P7 — the local, approval-gated coding agent (the flagship) | shipped |
| P8 — knowledge and skills (HF Skills catalog in Knowledge panel) | shipped |
| P9 — experimental fine-tuning (LoRA via llama.cpp, VRAM guards) | planned — needs its own surface (trainer UI, dataset pick, adapter output) |

The NeuraOS pass (the UI/UX and hybrid-compute plan) is tracked separately,
because it cuts across those phases:

| Phase | State |
| :-- | :-- |
| 1 — foundation and the UI paradigm shift (glass, zen, palette, the hover rail, micro-interactions, the WebView2 fallback, the IPC/route contract) | shipped |
| 2 — advanced build and planning (inline diffs, a sandboxed local runner, planning canvas) | shipped |
| 3 — local intelligence and hybrid compute (llama.cpp, smart fallback, remote handoff) | shipped |
| 4 — polish, interaction and autonomy (radial menus, micro-animations, brand) | shipped, except the 60 FPS profile, which needs a machine with a GPU and a profiler rather than a promise in a document |

What that leaves unbuilt on purpose, in the order it is worth doing:
fine-tuning (P9 — the estimate/validate helpers existed without any surface
and were pruned; it returns with a trainer UI, a dataset picker and adapter
output wired end to end).
`test/desktop-contract.test.js` is the guard rail for all of them: it holds the
frontend's Tauri command names against the shell's `generate_handler!` list and
`api.ts`'s routes against `server.js`, so a screen that calls something the
other side does not have fails here instead of in front of a user.
