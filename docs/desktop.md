# Desktop app (Windows)

`FreeAI4U Desktop` is a native Tauri 2 app: its own window, sidebar, tray icon and installer. The AI engine is the FreeAI4U server (Railway by default) — the same one the web app and the Android app use — so chat, images and builds all run on free models with the keys staying server-side.

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

| Shortcut | Does |
| :-- | :-- |
| `Alt+1` … `Alt+7` | Chat, Images, Builds, Local, Design, Library, Settings |
| `Alt+F` | Files |
| `Ctrl+K` | The command palette |
| `Enter` / `Shift+Enter` | Send / newline in the composer |

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

The desktop talks to `https://freeopenai-production.up.railway.app` by default. Settings → **Engine server** accepts any FreeAI4U server: `https://` anywhere, `http://localhost` for a self-hosted engine. Test + save; the choice is remembered. The window title bar tells you when the engine cannot be reached.

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
- **`Ctrl+K`** opens a command palette over every screen, action, panel, saved chat and skill (`src/commands.js` holds the registry and the matching rules; `Ctrl+K`, arrows, `Enter`, `Esc`). Before it, the whole keyboard story was `Alt+1..6`.
- **Toasts** (`src/toasts.js`) replace a `setTimeout` hint in the sidebar: queued, dismissible, announced with `aria-live`, repeats refresh instead of stacking, and a failure can be sticky until it is dealt with.
- **A status bar**: which engine this build is pointed at, whether it answered — and what it *wants* (an engine that reports healthy while refusing every call says *sign-in required*, not *connected*) — plus an available update and the version.

Three more rules came out of using it, and they are what stop the window reading as a web page in a frame:

- **A choice is one control, not a row of buttons.** The chat header carried three always-present mode tabs (Chat / Plan / Build) that read as navigation while actually being a property of the next message; they are one pill (`src/components/ModePicker.tsx`) that names the current mode and explains each option where the choice is made. The service-and-model pair is likewise one pill (`ModelPicker.tsx`) rather than two dropdowns that had to be read as a pair.
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

Start passes `-hf <repo>:<quant>`, so **llama.cpp fetches and caches the weights itself** — the Unsloth-documented path, and the reason there is no GGUF downloader in this repo. The server is started on `--host 127.0.0.1` only, and the app reaps the child on quit: a model server left running after the window is gone is a process the user cannot see.

`--ctx-size` and `--threads` come from the machine, and the **memory guard** is the part that matters: starting a model the machine cannot hold is the one way this feature can freeze a computer, so `src/local-models.js` estimates weights + KV cache + overhead against the memory the browser reports (which is rounded down and capped, so it is treated as a floor), refuses what does not fit, and says the numbers. A model that only just fits is called *tight* rather than comfortable.

Lifecycle in one rule: a server that has not answered `/health` is **starting**, never *ready* — a model that has not loaded cannot answer, and saying it is ready is how a first message disappears into a void.

## Signing

The installer and the portable exe are **not signed**, which is why Windows SmartScreen shows *"Windows protected your PC"* the first time somebody runs a fresh download. That is a certificate, not code: an Authenticode certificate is issued to a verified legal identity, and the identity check is the user's to make.

The pipeline is already wired for it. `bundle.windows.certificateThumbprint` is declared in `tauri.conf.json`, and the Desktop workflow signs when the repository has the secrets — no code change, no rebuild of the process:

| Secret | What it is |
| :-- | :-- |
| `WINDOWS_CERTIFICATE` | The `.pfx` bundle, base64-encoded |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password |

With both set, CI imports the certificate, builds with its thumbprint, and **verifies** the signature on the installer and the portable exe — a build that claimed to be signed but is not fails the job rather than shipping quietly. Without them the build is unchanged, and the release notes say unsigned, so nobody has to guess which one they downloaded.

## Code map

Each concern has one owner, and the shell (App.tsx) composes rather than implements.

| Module | Owns |
| :-- | :-- |
| `src/api.ts` | Transport only: the engine address, `request`, the SSE stream, the route table |
| `src/connection.js` | What an engine outcome *means*: `kind` (ok / unreachable / signed-out / refused / rejected / engine-error / no-reply) and the copy for it — the error message and the shell banner |
| `src/onboarding.js` | Which surface the shell shows (`connect` or `app`), why (`checking` / `first-run` / `unreachable` / `signed-out` / `ready` / `degraded`), and which failures deserve a banner |
| `src/components/ConnectionCard.tsx` | The engine address, the probe and the sign-in form — one owner, used by the connect screen and by Settings |
| `src/screens/ConnectScreen.tsx` | The way in: the headline, the advice, the card |
| `src/chats.js` | The chat store: its key, the 60-session cap, validation, merge, recency order, export/import. Chat, History, Library and the shell all read it here — no one else spells `freeai4u.chats` |
| `src/update.js` | Release policy: version parsing/comparison, the payload, retry with backoff |
| `src/useUpdateCheck.ts` | The React binding for it: polling, the dismissed version, the installer |
| `src/theme.ts` | The theme value, its key, and applying it |
| `src/run-result.js` | A run response (engine or local) turned into the terminal's display block |
| `src/local-fs.js` | The local folder's rules: the frontend's copy of the shell's confinement and approval lists, `cd`/`pwd`, and what a file row is |
| `src/components/LocalTerminal.tsx` | The local dock: a live cwd, streamed output, the inline approval for a destructive command |
| `src/components/LocalTree.tsx` | The open folder, one level at a time, labelled by what each file is |
| `src/screens/LocalScreen.tsx` | The LOCAL screen: the empty state that invites picking a folder, the tree, the read-only viewer |
| `src/useLocalRun.ts` | The React binding for `local-run` events |
| `src-tauri/src/local.rs` | The real filesystem and command runner, confined to the open folder, with the engine's wording |
| `src/failure.js` | Why a turn failed: what was asked, the provider's own words, and one sentence of advice |
| `src/images.js` | Which image service draws, with which model, at which shape — and the curated Puter chains |
| `src/puter.js` | The Puter SDK, injected only when the user picks it |
| `src/local-models.js` | The local catalogue, the memory guard, and the lifecycle states |
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
- **The rail.** Icons only, 60px wide, widening on hover or focus to reveal the
  labels and the shortcut for each row. Nothing moves under the pointer while it
  animates, so a hover never turns into a mis-click.
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
| P5 — Sign in with Hugging Face + the Hub browser | not started |
| P6 — Hugging Face as a model route, BYOK un-parked | not started |
| P7 — the local, approval-gated coding agent (the flagship) | not started |
| P8 — knowledge and skills (Agent Skills, the HF catalogue) | not started |
| P9 — local images, parallel agents, fine-tuning (stretch) | not started |

The NeuraOS pass (the UI/UX and hybrid-compute plan) is tracked separately,
because it cuts across those phases:

| Phase | State |
| :-- | :-- |
| 1 — foundation and the UI paradigm shift (glass, zen, palette, the hover rail, micro-interactions, the WebView2 fallback, the IPC/route contract) | shipped |
| 2 — advanced build and planning (inline diffs, a sandboxed local runner) | partial: the approval card already renders the diff inline, and a stopped run now kills its whole process tree after the timeout; the node-based planning canvas is not started |
| 3 — local intelligence and hybrid compute (llama.cpp, smart fallback, remote handoff) | partial: local models load and serve, and the fallback rule is shipped; the remote handoff orchestrator is not started |
| 4 — polish, interaction and autonomy (radial menus, micro-animations, brand) | shipped, except the 60 FPS profile, which needs a machine with a GPU and a profiler rather than a promise in a document |

What that leaves unbuilt on purpose, in the order it is worth doing: Hugging
Face OAuth and the Hub browser (P5/P6), the local approval-gated coding agent
(P7, the flagship), the Agent Skills knowledge pack (P8), and fine-tuning (P9).
`test/desktop-contract.test.js` is the guard rail for all of them: it holds the
frontend's Tauri command names against the shell's `generate_handler!` list and
`api.ts`'s routes against `server.js`, so a screen that calls something the
other side does not have fails here instead of in front of a user.
