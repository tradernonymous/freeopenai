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

## The engine address

The desktop talks to `https://freeopenai-production.up.railway.app` by default. Settings → **Engine server** accepts any FreeAI4U server: `https://` anywhere, `http://localhost` for a self-hosted engine. Test + save; the choice is remembered. The window title bar tells you when the engine cannot be reached.

## WebView2 (the blank-screen fix)

The window is drawn by Microsoft's WebView2 runtime. Machines without it used to show a blank window that vanished — nothing in any log. Now:

- the **installer** installs the runtime on first setup (`webviewInstallMode: downloadBootstrapper`), and
- the app itself checks the registry keys at startup and shows a message box with [the download link](https://go.microsoft.com/fwlink/p/?LinkId=2124703) if the runtime is still missing.

A crash log lives at `C:\Users\Public\freeai4u-crash.log` for anything else that goes wrong before the window exists.

## How it is built

[`desktop/`](../desktop/) is a Tauri 2 + React (Vite + TypeScript) app. The Rust shell (`src-tauri/`) owns the window, tray and the WebView2 check; the React frontend owns the screens and talks to the engine through [`src/api.ts`](../desktop/src/api.ts) — the same routes the web app uses. CI ([`desktop.yml`](../.github/workflows/desktop.yml)) runs the desktop tests (`node --test test/desktop.test.js`: config integrity, version agreement, and that every route the frontend calls exists on the server), builds the Tauri app on `windows-latest`, and publishes the NSIS installer, MSI and portable exe to the `desktop-latest` release.
