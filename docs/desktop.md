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

- **One icon set** (`src/components/Icon.tsx`), drawn here rather than imported: 24x24, 1.6px stroke, `currentColor`, so an icon is the same weight as its label and the same colour as the state it sits in. The sidebar's icons used to be emoji (💬 🖼 🛠 …), which render differently on every Windows build and cannot be aligned, sized or coloured.
- **`Ctrl+K`** opens a command palette over every screen, action, panel, saved chat and skill (`src/commands.js` holds the registry and the matching rules; `Ctrl+K`, arrows, `Enter`, `Esc`). Before it, the whole keyboard story was `Alt+1..6`.
- **Toasts** (`src/toasts.js`) replace a `setTimeout` hint in the sidebar: queued, dismissible, announced with `aria-live`, repeats refresh instead of stacking, and a failure can be sticky until it is dealt with.
- **A status bar**: which engine this build is pointed at, whether it answered — and what it *wants* (an engine that reports healthy while refusing every call says *sign-in required*, not *connected*) — plus an available update and the version.

The app is held to its own design bar, by test: every frontend file passes the anti-slop linter this repo ships for generated artifacts (`test/desktop-shell.test.js`), and every text token pair clears WCAG AA in both themes. That gate found real defects when it was written — `--text-3` measured 3.88:1 where the 11-13px hints that use it need 4.5:1, and the light theme's status colours measured 4.1-4.3:1; all were corrected rather than exempted. The same pass made the linter itself more honest: a prompt that says *no lorem ipsum* is an instruction, not shipped placeholder copy, and is no longer reported as one.

## Diagnostics

Settings has a **Copy diagnostics** button. It copies a short report — build version, engine address, what the last engine answer meant, OS/arch, WebView2 version, where the data and cache directories are, and the tail of the crash log — built by `src/diagnostics.js` from facts the shell gathers (`src-tauri/src/diag.rs`). It is safe to paste: query strings are dropped from addresses and anything shaped like `hf_…`, `sk-…` or `Bearer …` is redacted. A failure should not need a screenshot.

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

## How it is built

[`desktop/`](../desktop/) is a Tauri 2 + React (Vite + TypeScript) app. The Rust shell (`src-tauri/`) owns the window, tray and the WebView2 check; the React frontend owns the screens and talks to the engine through [`src/api.ts`](../desktop/src/api.ts) — the same routes the web app uses. CI ([`desktop.yml`](../.github/workflows/desktop.yml)) runs the desktop tests (`node --test test/desktop.test.js`, `test/desktop-update.test.js`, `test/desktop-chats.test.js`: config integrity, version agreement, the update-check rules, the chat import/export merge, and that every route the frontend calls exists on the server), plus the local-confinement suite (`test/desktop-local.test.js`), builds the Tauri app on `windows-latest`, writes `desktop-version.json`, and publishes the NSIS installer, MSI, portable exe and that metadata file to the `desktop-latest` release.

## Upgrade roadmap

[`desktop-premium-plan.md`](./desktop-premium-plan.md) is the master plan for the next nine phases: the Rust network edge and a working updater, the premium shell pass, local-first files and terminal, llama.cpp + GGUF local models, Sign in with Hugging Face and the Hub browser, Hugging Face inference providers, the local approval-gated coding agent, the Agent Skills knowledge pack, and local images / parallel agents / fine-tuning. It also records what each reference repo (freebuff, codebuff-swe-bench, evalbuff, stagehand, opentui, unsloth and its forks, stable-diffusion.cpp, huggingface.js / skills / huggingface_hub) contributes to which phase.
