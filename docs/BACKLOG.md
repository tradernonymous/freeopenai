# NeuraOS backlog

The single list of what is still open across **web** (`index.html`, `app.js`, `chatlib.js`), **engine** (`server.js`), **desktop** (`desktop/`) and **Android** (`android/`). Last reviewed 2026-09-23, after the premium-plan gap review (NEURA-049..059) and the backlog round `66ac1c3`…`aa9e6bf` (Desktop build green)
and the Android master plan ([`android-master-plan.md`](android-master-plan.md)), whose
phases own the Android rows from here on.

## How to use this file

- One row per item: **ID · surface · type · size · item · owner**. IDs are never reused; a finished item moves to *Done* with its commit.
- **Types:** `user` (needs you: an account, a purchase, a file), `fix` (something is wrong today), `upgrade` (new capability), `verify` (built, needs checking in the installed app).
- **Sizes:** S (under an hour), M (a phase), L (several phases).
- **Owner:** the session that works on that surface. Desktop is this session's; web and Android are the other session's. `server.js` is shared: small, self-contained edits only, and commit only your own hunks.
- **Code markers:** where an open item needs a code change, the spot carries `// TODO(NEURA-012): short reason` -- never a bare `TODO`. `test/backlog.test.js` fails if a marker names an id that is not open here, or if the desktop, `shared/` or `server.js` gain a TODO comment without an id. Close an item by removing its markers and moving its row to *Done*.

## Needs you

| ID | Surface | Type | Size | Item | Owner |
|---|---|---|---|---|---|
| NEURA-001 | desktop | user | S | **Code signing** so SmartScreen stops warning: a `.pfx` (secrets `WINDOWS_CERTIFICATE` + password) or **Azure Trusted Signing** (~US$10/month; secrets `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET`, variables `TRUSTED_SIGNING_ACCOUNT/PROFILE/ENDPOINT`). CI is ready for both -- `docs/desktop.md` → Signing. | you |
| NEURA-002 | desktop | user | S | **Hugging Face OAuth app** for one-click sign-in: register at huggingface.co/settings/applications/new, redirect `http://127.0.0.1:47823/hf/callback`, scopes `openid profile read-repos inference-api`; then `gh variable set NEURAOS_HF_CLIENT_ID --body <id>` (or paste the id in Settings → Connectors). | you |
| NEURA-003 | desktop | user | S | **Update-signing key**: run the four commands in `docs/desktop.md` → Update signing, and back up the key and password. Until then updates are checked by sha256 only. | you |
| NEURA-004 | all | user | S | **New logo file** at `assets/branding/neuraos-logo.png` (emblem only, no text, no background, square, 512px or larger), so icons can be cut for web, APK, desktop and tray. The APK's adaptive icon is now wired and shipping the old chat-bubble mark; dropping this file in replaces the foreground layer alone (`ic_launcher_foreground.xml`, `ic_launcher_monochrome.xml`) and touches nothing else. | you |
| NEURA-042 | desktop | user | S | **whisper.cpp for local dictation**: download a `whisper-cli.exe` release and a ggml model (links in Settings → Dictation), then pick them there. Without it, dictation uses Hugging Face or Win+H. | you |

## Verify in the installed app

| ID | Surface | Type | Size | Item | Owner |
|---|---|---|---|---|---|
| NEURA-010 | desktop | verify | S | Scripts inside `srcdoc` frames run in the packaged app (HTML Preview, Design canvas, MCP Apps). Only confirmed in the dev browser; the app's CSP could block them. | desktop |
| NEURA-011 | desktop | verify | S | Chats move into the encrypted `chats.sqlite3` on first start, History still lists them, Export/Import works; a tray Quit right after typing keeps the last edit. | desktop |
| NEURA-012 | desktop | verify | S | Accent hue, floating panes, Reduce motion and the new disabled-button style look right in light and dark. | desktop |
| NEURA-013 | desktop | verify | S | Monaco opens a local file and Ctrl+S saves; the Docker sandbox runs a plain command and a quoted one (script mode) with Docker Desktop up. | desktop |
| NEURA-014 | desktop | verify | S | Quoted commands reach programs intact (`git commit -m "msg"` from the terminal and Parallel's Merge) after the raw `cmd /s /c` argument fix. | desktop |
| NEURA-015 | desktop | verify | S | One-click HF sign-in works once NEURA-002 is done, including HF accepting a `127.0.0.1` redirect. | desktop |
| NEURA-016 | desktop | verify | S | Double-click a `.gguf` and Explorer's "Open in NeuraOS" on a folder (needs a fresh install from the NSIS installer). | desktop |
| NEURA-043 | desktop | verify | S | `/research` end to end on a real engine and model: sources, citations, knowledge graph, Markdown and PDF export; and the no-search fallback. | desktop |
| NEURA-044 | desktop | verify | S | Local dictation with whisper.cpp (after NEURA-042), including that `-of` writes `<name>.txt` as assumed. | desktop |
| NEURA-045 | desktop | verify | S | Design: insert a component, export React (.tsx + .css), Flutter and SwiftUI; PPTX export carries a slide's pictures. | desktop |
| NEURA-046 | desktop | verify | S | A scheduled recipe that needs approval notifies, waits, and resumes on Allow; Settings → Diagnostics shows the three startup marks and whether 2 s was met. | desktop |

## Fixes

| ID | Surface | Type | Size | Item | Owner |
|---|---|---|---|---|---|
| NEURA-025 | desktop | fix | S | The language-server MCP preset is a template (no package name was guessed); fill in a real, maintained package once one is chosen. | desktop |

## Upgrades

| ID | Surface | Type | Size | Item | Owner |
|---|---|---|---|---|---|
| NEURA-034 | desktop | upgrade | L | **Language-server features in the editor**: go-to-definition and diagnostics in Monaco through an LSP MCP server (after NEURA-025). | desktop |
| NEURA-037 | web | upgrade | M | **Shared modules, steps 2-4** (ADR 0002): slash registry, tool schemas and tool renderers into `shared/`, loaded by the web app too. Needs the web session. | web |
| NEURA-038 | engine | upgrade | S | The `/api/mcp/*` rate limit counts per engine process; move it to shared storage if the engine ever runs as several instances. | shared |
| NEURA-039 | android | upgrade | M | Android parity with the desktop: MCP Apps, scheduled recipes, Evals history, research mode. Decide which fit a phone. | android |
| NEURA-047 | desktop | upgrade | S | Cold start: make SettingsScreen, ConnectScreen, LocalScreen and CodeScreen lazy too (the entry is ~490 kB of Chat's own code after this round). | desktop |
| NEURA-048 | desktop | upgrade | S | Warn in Settings → Diagnostics when the startup marks miss 2 s on this machine, with the biggest chunk named. | desktop |
| NEURA-049 | desktop | upgrade | S | **`cargo test` in the Desktop CI job**: the Rust side has unit tests but nothing runs them; a red test must fail the build before the installer is made. | desktop |
| NEURA-050 | desktop | upgrade | S | **Mica on Windows 11**: the real system material behind the shell (`windowEffects`), with the flat background kept for Windows 10 and for Reduce transparency. | desktop |
| NEURA-051 | desktop | upgrade | S | **Local-model status chip**: `/health` and `/slots` from the local runtime, so the status bar says loaded/ctx/slots instead of only "connected". | desktop |
| NEURA-052 | desktop | upgrade | S | **`.freeai4u.json` per-project config**: a project's own model, approval mode, allowed commands and prompt, read when a folder is opened. | desktop |
| NEURA-053 | desktop | upgrade | S | **One-click skill install** from the Hugging Face catalogue in Library, instead of copying files by hand. | desktop |
| NEURA-054 | desktop | upgrade | M | **BYOK endpoints** in the model picker: an OpenAI-shaped base URL plus a key held in the OS credential store, sent per call, never cached in the page and never logged. | desktop |
| NEURA-055 | desktop | upgrade | M | **Chat templates** for local models through `@huggingface/jinja`, so a GGUF's own template shapes the prompt instead of a generic one. | desktop |
| NEURA-056 | desktop | upgrade | M | **`project-scout` index**: a subagent that maps a repository once and answers "where is X" from the index, so the coding agent stops re-reading the tree. | desktop |
| NEURA-057 | desktop | upgrade | M | **Eval harness in CI**: the eval suite runs on every push and reports a score, so a regression in the agent's own prompts is visible. | desktop |
| NEURA-058 | desktop | upgrade | M | **Real terminal**: a PTY on the Rust side with `xterm.js` in the page, so interactive programs (REPLs, `git rebase`, installers) work instead of one-shot commands. | desktop |
| NEURA-059 | desktop | upgrade | M | **Local image generation** through a user-supplied `sd-server`, so Images works with no account and no network. | desktop |

## Done recently (android)

| Commit | What |
| --- | --- |
| `fbbe32a` | NEURA-020: the three provider-dependent Maestro flows carry `needs-provider`, and `maestro-smoke.sh` runs `maestro test --exclude-tags=needs-provider flows/`. CI gates on the 2 flows it can actually run; the other 3 run against a configured engine. |

## Done (desktop)

| ID | Commit | What |
|---|---|---|
| NEURA-021 | `66ac1c3` | Tray Quit flushes the chat store first (`app-quitting` → `quit_ready`), plus `pagehide`/`beforeunload` |
| NEURA-022 | `66ac1c3` | A chat key that cannot open the stored chats never overwrites them; "Start fresh (keep the old file)" sets them aside by rename |
| NEURA-023 | `66ac1c3` | Docker sandbox runs quoted and `$`/`%` commands through a temporary script instead of refusing them |
| NEURA-024 | `66ac1c3` | Disabled buttons: a ≥3:1 dashed style instead of 50% opacity |
| NEURA-026 | `66ac1c3` | Docs point at `shared/keymap.js` |
| NEURA-027 | `068541b` | The engine no longer serves its own sources, config, docs, other surfaces, the workspace or dotfiles |
| NEURA-030 | `d2c66f6` | `/research`: planned queries, numbered and checked citations, knowledge graph, Markdown/PDF export |
| NEURA-031 | `89bdec1` | Local Whisper through a user-supplied whisper.cpp, engine auto/local/HF, Settings → Dictation |
| NEURA-032 | `89bdec1` | Design component palette: ten token-bound components, click to insert |
| NEURA-033 | `89bdec1` | Design export to React (deterministic), Flutter and SwiftUI (through the model) |
| NEURA-035 | `aa9e6bf` | Startup marks in Diagnostics; compare, run settings, MCP App frame and document readers load on first use (−34 kB) |
| NEURA-036 | `aa9e6bf` | Scheduled recipes pause and ask (notification + Library → Recipes card) instead of refusing |
| NEURA-040 | this commit | `TODO(NEURA-xxx)` markers and `test/backlog.test.js` |
| NEURA-041 | `d2c66f6` | Research without a search provider says so and answers without citations |

Earlier desktop work: 12a-e `5cb8ac8`…`d16be72`, LeakCanary `a4201b9`, 11a-e `3d7a78c`…`ecdb06d`, fresh-start crash and tray icon `9517f2b`.
