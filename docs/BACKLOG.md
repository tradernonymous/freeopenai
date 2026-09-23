# NeuraOS backlog

The single list of what is still open across **web** (`index.html`, `app.js`, `chatlib.js`), **engine** (`server.js`), **desktop** (`desktop/`) and **Android** (`android/`). Last reviewed 2026-09-23, after the premium-plan round (NEURA-049..059, all done) and the backlog round `66ac1c3`…`aa9e6bf` (Desktop build green)
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
| NEURA-065 | desktop | verify | S | The darker glossy green and Mica in the installed app: the sidebar, title bar and status bar sit on the wallpaper on Windows 11, the window stays solid on Windows 10 and with Transparency effects off, and Settings > Appearance says which case this machine is. | desktop |
| NEURA-066 | desktop | verify | S | The real terminal: a REPL, `git rebase -i`, Ctrl+C, a resize, and that closing the screen leaves no orphaned shell in Task Manager. | desktop |
| NEURA-067 | desktop | verify | S | Local images end to end with a real sd-server binary and model: queue position, cancel mid-draw, and that Quit stops the server. | desktop |
| NEURA-068 | desktop | verify | S | A BYOK endpoint: add one, chat through it, confirm the key is in Credential Manager and in no log, and that deleting the endpoint removes the credential. | desktop |
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
| NEURA-069 | desktop | upgrade | L | **The shell redesign**: hover-peek rails that overlay rather than push, the workbench rail owning Design/Build/Files/Changes, the Unsloth-shaped composer row, and the gold-marks-the-active-tool rule. Landing in phases; this row closes when the rails, the composer and the Design tab are all in. | desktop |
| NEURA-070 | desktop | upgrade | M | **Design tab, next phase**: bring the mockup generator and whatever else fits across from the user's `viralai` repo (personal build, licensing revisited before any commercial release). Needs a read of that repo first to say what transfers. | desktop |
| NEURA-071 | desktop | upgrade | M | **Edit a picture, not just make one**: `images.js` already names the edit-capable models (`PUTER_EDIT_MODELS`) and `modelsFor('edit')` returns them, but nothing calls it -- there is no edit flow in Images and no way at all from Chat. Attaching a picture in Chat only lets a vision model *look* at it. Wants: send a picture with an instruction, get the edited picture back, in Chat and in Images. Pairs with the Design tab work (NEURA-070). | desktop |
| NEURA-060 | desktop | fix | S | A session remembers `{provider, model}`, so two BYOK endpoints serving the same model id (two hosts both offering `gpt-4o-mini`) are indistinguishable when the turn is sent. The session needs the endpoint id. | desktop |
| NEURA-061 | desktop | upgrade | S | The project index is ~443 kB of JSON in `localStorage` for this repo; a monorepo will pass the 5 MB ceiling and then quietly never persist. Drop `symbols` for files that export nothing. | desktop |
| NEURA-062 | desktop | upgrade | S | **Remove an installed skill**: there is no delete command on the Rust side, so Install has no opposite. A Remove that only forgot the record would leave the files on disk. | desktop |
| NEURA-063 | desktop | upgrade | S | `checkFresh` walks the whole tree before the first model call of every run (~100 ms here, names and sizes only). On a very large repo that is a visible pause on turn one -- check the root and top areas first, defer the rest. | desktop |
| NEURA-064 | desktop | upgrade | S | `reasoning_effort` is not sent to a BYOK endpoint, so `/reasoning` silently does nothing there. Many OpenAI-compatible hosts accept it. | desktop |
| NEURA-048 | desktop | upgrade | S | Warn in Settings → Diagnostics when the startup marks miss 2 s on this machine, with the biggest chunk named. | desktop |

## Done recently (android)

| Commit | What |
| --- | --- |
| `fbbe32a` | NEURA-020: the three provider-dependent Maestro flows carry `needs-provider`, and `maestro-smoke.sh` runs `maestro test --exclude-tags=needs-provider flows/`. CI gates on the 2 flows it can actually run; the other 3 run against a configured engine. |

## Done (desktop)

| ID | Commit | What |
|---|---|---|
| NEURA-049 | `4f1d3d3` | `cargo test` runs in the Desktop job before the bundle, on the debug profile; it found a path test that depended on a folder it never created (`22c2c26`) |
| NEURA-050 | `4f1d3d3`, `821a20c` | Mica, withdrawn when the machine cannot honour it, and painted only after the shell confirms it; darker glossy green with it |
| NEURA-051 | `db80f14` | The status bar reads `/health` and `/slots`: model, context and busy slots, or "loading", or nothing at all |
| NEURA-052 | `92ff4e6` | `.freeai4u.json`: a project's own model, approval mode, commands and prompt -- merged as a request, never as an authority |
| NEURA-053 | `4327d2c` | One-click skill install from the catalogue, path escapes refused before a byte is fetched |
| NEURA-054 | `29d17d0` | BYOK endpoints: the key lives in the credential store and the request is issued in Rust, so the page never holds it |
| NEURA-055 | `1315194` | Local models render their own GGUF chat template through `@huggingface/jinja`, bounded, with a reasoned fallback |
| NEURA-056 | `4b72f8a` | project-scout: the repository is mapped once and `find_symbol` answers with path:line (and AGENTS.md finally reaches the prompt) |
| NEURA-057 | `4243ac4` | The evals run on every push: 48/48 against fixtures, threshold checked in |
| NEURA-058 | `821a20c` | A real PTY terminal (portable-pty + xterm.js); agent-sent commands still pass the gate |
| NEURA-059 | `821a20c` | Local image generation through a user-supplied sd-server, loopback only, cancellable |
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
