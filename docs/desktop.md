# Desktop app (Windows)

`FreeAI4U-Desktop.exe` opens your FreeAI4U server in its own window. The app itself runs on the server (Railway), so it is always current.

## Install

1. Download **`FreeAI4U-Desktop.exe`** from [desktop-latest](https://github.com/tradernonymous/freeopenai/releases/tag/desktop-latest).
2. Double-click it. If Windows says *"Windows protected your PC"*: **More info → Run anyway** (the exe is not code-signed).
3. Sign in once in the window. It keeps its own profile, separate from your browser.

Optional: right-click the exe → **Pin to taskbar**.

## What you get

- **Chat · Plan · Build** switch above the message box.
- **Builds panel docked beside the chat** on wide windows: live steps, diffs, Approve/Reject.
- **Knowledges**: skills, tools per mode, commands.

| Shortcut | Does |
| :-- | :-- |
| `Alt+1` `Alt+2` `Alt+3` | Chat, Plan, Build |
| `Ctrl+Shift+B` | Builds panel |
| `Ctrl+Shift+K` | Knowledges |
| `Esc` | Close the panel |

## Options

Run from a terminal (`cmd` or PowerShell) in the download folder:

```bash
FreeAI4U-Desktop.exe --server https://your-server.up.railway.app
```

| Option | Does |
| :-- | :-- |
| `--server <url>` | Use another FreeAI4U server and remember it (`https://` only; `http://localhost` allowed). |
| `--reset` | Go back to the default server. |
| `--help` / `--version` | Show help or version. |

Settings: `%APPDATA%\FreeAI4U\desktop.json`. Log: `%LOCALAPPDATA%\FreeAI4U\desktop.log`. Window profile: `%LOCALAPPDATA%\FreeAI4U\profile`.

## How it is built

[`desktop/freeai4u-desktop.js`](../desktop/freeai4u-desktop.js) is a zero-dependency Node launcher: it checks `/api/health`, then starts Edge in app mode (Chrome, then the default browser, as fallbacks). CI ([`desktop.yml`](../.github/workflows/desktop.yml)) packages it with Node's single-executable support on `windows-latest`, marks it as a windowed app (no console flash), checks it runs, and publishes the exe plus a `.sha256` checksum.
