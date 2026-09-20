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
- **Images** on the engine's free image models (Free FLUX first, Puter only when you switch it on), with a gallery and save-to-disk.
- **Builds** screen for the full session list, plan composer and live event stream.
- **Library**: every skill the engine serves, with its full SKILL.md, plus the chats stored locally.
- **Settings**: the engine address (Test + save), sign-in, provider health with free-tier limits, the rate-limit retry budget, and the memory the model saved — forget any fact.

| Shortcut | Does |
| :-- | :-- |
| `Alt+1` … `Alt+6` | Chat, Images, Builds, Design, Library, Settings |
| `Enter` / `Shift+Enter` | Send / newline in the composer |

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
| `src/run-result.js` | An engine run response turned into the terminal's display block |
| `src/files/*`, `src/design/*` | Document extract/generate and the brand + anti-slop engines (UMD, node-tested) |
| `src-tauri/src/main.rs` | Wiring: boot checks, tray, window, plugins, commands |
| `src-tauri/src/crash.rs` | Where a failure is recorded: path, size cap, rotation, hint |
| `src-tauri/src/webview2.rs` | The runtime the window needs, and what to tell a user missing it |
| `src-tauri/src/save.rs` | The native save dialog and its derived filters |

The pure modules (`.js` with a `.d.ts`, loaded for their side effect and read off `globalThis`) are the ones that carry rules; `node --test` runs them directly, so the same code paths the app uses are the ones the tests check. The shell's Rust rules are asserted from the shell sources as a set (`test/desktop.test.js`), so moving a rule between modules is not a test break.

## How it is built

[`desktop/`](../desktop/) is a Tauri 2 + React (Vite + TypeScript) app. The Rust shell (`src-tauri/`) owns the window, tray and the WebView2 check; the React frontend owns the screens and talks to the engine through [`src/api.ts`](../desktop/src/api.ts) — the same routes the web app uses. CI ([`desktop.yml`](../.github/workflows/desktop.yml)) runs the desktop tests (`node --test test/desktop.test.js`, `test/desktop-update.test.js`, `test/desktop-chats.test.js`: config integrity, version agreement, the update-check rules, the chat import/export merge, and that every route the frontend calls exists on the server), builds the Tauri app on `windows-latest`, writes `desktop-version.json`, and publishes the NSIS installer, MSI, portable exe and that metadata file to the `desktop-latest` release.
