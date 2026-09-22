# NeuraOS backlog

The single list of what is still open across **web** (`index.html`, `app.js`, `chatlib.js`), **engine** (`server.js`), **desktop** (`desktop/`) and **Android** (`android/`). Last reviewed 2026-09-22, after the desktop Phase 12 wave 1 (`d16be72`, Desktop build green).

## How to use this file

- One row per item: **ID · surface · type · size · item · owner**. IDs never get reused; a finished item moves to *Done* with its commit.
- **Types:** `user` (needs you: an account, a purchase, a file), `fix` (something is wrong today), `upgrade` (new capability), `verify` (built, needs checking in the real app).
- **Sizes:** S (under an hour), M (a phase), L (several phases).
- **Owner:** the session that works on that surface. Desktop is this session's; web and Android are the other session's. `server.js` is shared: small, self-contained edits only, and commit only your own hunks.
- **Code markers (proposed, not in use yet):** where an item needs a code change, mark the exact spot with `// TODO(NEURA-012): short reason` -- never a bare `TODO`. A test will check that every marker names an open item here, and that a closed item has no markers left (NEURA-040).

## Needs you

| ID | Surface | Type | Size | Item | Owner |
|---|---|---|---|---|---|
| NEURA-001 | desktop | user | S | **Code signing** so SmartScreen stops warning: a `.pfx` (secrets `WINDOWS_CERTIFICATE` + password) or **Azure Trusted Signing** (~US$10/month; secrets `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET`, variables `TRUSTED_SIGNING_ACCOUNT/PROFILE/ENDPOINT`). CI is ready for both -- see `docs/desktop.md` → Signing. | you |
| NEURA-002 | desktop | user | S | **Hugging Face OAuth app** for one-click sign-in: register at huggingface.co/settings/applications/new, redirect `http://127.0.0.1:47823/hf/callback`, scopes `openid profile read-repos inference-api`; then `gh variable set NEURAOS_HF_CLIENT_ID --body <id>` (or paste the id in Settings → Connectors). | you |
| NEURA-003 | desktop | user | S | **Update-signing key**: run the four commands in `docs/desktop.md` → Update signing, and back up the key and password. Until then updates are checked by sha256 only. | you |
| NEURA-004 | all | user | S | **New logo file** at `assets/branding/neuraos-logo.png` (emblem only, no text, no background), so icons can be cut for web, APK, desktop and tray. | you |

## Verify in the installed app

| ID | Surface | Type | Size | Item | Owner |
|---|---|---|---|---|---|
| NEURA-010 | desktop | verify | S | Scripts inside `srcdoc` frames run in the packaged app (HTML Preview, Design canvas, MCP Apps). Only confirmed in the dev browser so far; the app's CSP could block them. | desktop |
| NEURA-011 | desktop | verify | S | Chats move into the encrypted `chats.sqlite3` on first start, History still lists them, and Export/Import works (Phase 12b). | desktop |
| NEURA-012 | desktop | verify | S | Accent hue, floating panes and Reduce motion look right in light and dark (Phase 12d). | desktop |
| NEURA-013 | desktop | verify | S | Monaco editor opens a local file and Ctrl+S saves; Docker sandbox runs a command when Docker Desktop is up (Phase 12e). | desktop |
| NEURA-014 | desktop | verify | S | Quoted commands now reach programs intact (`git commit -m "msg"` from the terminal and Parallel's Merge) after the `cmd /s /c` raw-argument fix. | desktop |
| NEURA-015 | desktop | verify | S | One-click HF sign-in works once NEURA-002 is done, including HF accepting a `127.0.0.1` redirect. | desktop |
| NEURA-016 | desktop | verify | S | Double-click a `.gguf` and Explorer's "Open in NeuraOS" on a folder (needs a fresh install from the NSIS installer). | desktop |

## Fixes

| ID | Surface | Type | Size | Item | Owner |
|---|---|---|---|---|---|
| NEURA-020 | android | fix | M | **Maestro**: 2 of 5 flows pass (sign-in, chat, navigation) since the LeakCanary fix. `image-progress`, `build-progress` and `file-progress` expect real image generation, remote builds and an approval, which the throwaway CI engine has no providers for. Either give the CI engine a free provider, or mark those flows as needing one and skip them in CI. | android |
| NEURA-021 | desktop | fix | S | A chat edit made less than 400 ms before quitting from the tray can be lost: flush the chat store on quit (Phase 12b). | desktop |
| NEURA-022 | desktop | fix | S | If the `chat_key` credential is lost, stored chats cannot be opened; add a clear recovery path (export reminder, start fresh without deleting the old file). | desktop |
| NEURA-023 | desktop | fix | S | The Docker sandbox refuses commands containing `" $ % \` ` rather than escaping them; document common workarounds or add a safe script-file mode. | desktop |
| NEURA-024 | desktop | fix | S | Light theme: the disabled Reset button in Settings → Appearance is faint (global disabled-button style). | desktop |
| NEURA-025 | desktop | fix | S | The language-server MCP preset is a template (no package name was guessed); fill in a real, maintained package once one is chosen. | desktop |
| NEURA-026 | desktop | fix | S | Stale docs: `docs/desktop.md` still points at `src/keymap.js` (moved to `shared/keymap.js`). | desktop |
| NEURA-027 | engine | fix | S | The engine serves every file under the repo root to a signed-in user (`resolveSafePath`), including `server.js` and docs. Restrict static serving to the web app's own assets and `shared/`. | shared |

## Upgrades

| ID | Surface | Type | Size | Item | Owner |
|---|---|---|---|---|---|
| NEURA-030 | desktop | upgrade | M | **Research mode**: `/research` with planned queries through the existing search tools, numbered citations, a knowledge-graph view (reuses `design/diagram-layout.js`), Markdown/PDF export. Draft modules exist locally, uncommitted (`research.js`). | desktop |
| NEURA-031 | desktop | upgrade | M | **Local Whisper** through a user-supplied whisper.cpp binary (like llama-server), 16 kHz WAV conversion, engine choice auto/local/HF, a Dictation card in Settings. A draft `whisper.rs` exists locally, uncommitted. | desktop |
| NEURA-032 | desktop | upgrade | M | **Design component palette**: token-bound snippets (button, card, input, nav, hero, stat, table, modal, badge, footer) that pass the design linter, click-to-insert. | desktop |
| NEURA-033 | desktop | upgrade | M | **Design → framework export**: deterministic React (JSX + CSS + tokens); Flutter and SwiftUI through the model. | desktop |
| NEURA-034 | desktop | upgrade | L | **Code editor with language servers**: Monaco is in; add go-to-definition and diagnostics through an LSP MCP server (after NEURA-025). | desktop |
| NEURA-035 | desktop | upgrade | S | Measure cold start against the "under 2 s" target; the entry chunk is 526 kB after lazy screens -- split Chat's heavier parts too if it misses. | desktop |
| NEURA-036 | desktop | upgrade | M | Remote builds and scheduled recipes: let a scheduled recipe ask for approval through a notification instead of refusing the call. | desktop |
| NEURA-037 | web | upgrade | M | **Shared modules, steps 2-4** (ADR 0002): move the slash registry, tool schemas and tool renderers into `shared/`, and have the web app load them. Needs the web session. | web |
| NEURA-038 | engine | upgrade | S | `/api/mcp/*` rate limit is per engine process; if the engine ever runs more than one instance, move limits to shared storage. | shared |
| NEURA-039 | android | upgrade | M | Android parity items the desktop now has: MCP Apps, recipes on a schedule, Evals history. Decide which fit a phone. | android |
| NEURA-040 | all | upgrade | S | **TODO markers**: add `TODO(NEURA-xxx)` at the code sites for open fix items, plus a test that every marker names an open ID here and closed IDs leave no markers. | desktop |
| NEURA-041 | desktop | upgrade | M | Web search inside research and chat currently goes through the engine's search tool; add a fallback when the engine has no search provider configured. | desktop |

## Done recently (desktop)

| Commit | What |
|---|---|
| `d16be72` | 12e: helper agents, Monaco editor, Docker sandbox, LSP preset form, raw `cmd` arguments |
| `207d811` | 12d: accent hue, floating panes, reduce motion, lazy screens (entry 688 → 526 kB) |
| `3ed736f` | 12b: chats in an encrypted SQLite file, migrated from localStorage |
| `5cb8ac8` | 12a: MCP route hardening, full results for remote MCP Apps, tools in scheduled recipes, pictures in PPTX |
| `a4201b9` | Android: dropped LeakCanary, which crashed every debug install at launch |
| `ecdb06d` → `3d7a78c` | 11a-e: Trusted Signing route, remote MCP Apps route, GGUF header before first load, Evals history and schedule, one-click HF sign-in |
| `9517f2b` | Crash on a fresh start; second, dead tray icon |
