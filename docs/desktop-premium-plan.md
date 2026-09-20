# FreeAI4U Desktop — master upgrade plan (premium, reliable, freebuff-parity)

Status of this document: **plan only.** Written against `1436bf4` (v2.3.0) on
`task/desktop-tauri-core-q1a2w3`. Nothing in it is built yet.

Goal position, in one sentence: **the EXE should feel like a shipped product rather
than a dev tool, and it should be useful on a machine where the free engine is
unreachable, login-gated, or rate-limited** — by talking to Hugging Face and a
local llama.cpp the same way it talks to the engine.

---

## 0. Where the app actually stands (evidence, not impressions)

Shipped and verified green (CI ✅ + Desktop ✅ per phase, `desktop-latest` republished
with `desktop-version.json` matching HEAD):

| Phase | Landed |
| :-- | :-- |
| Hardening | Update check reads published `desktop-version.json` (version + sha256 + size), chat import/export validated and recency-ordered, terminal result updates by identity, provider/model fallbacks persisted, clean `app.exit(0)` quit, crash log in the app's own dir with a 256 KB cap, save-dialog filters derived from the file type |
| Structure | One owner per concern (`api.ts`, `connection.js`, `onboarding.js`, `chats.js`, `update.js`, `theme.ts`, `run-result.js`, `crash.rs`, `webview2.rs`), documented as a code map in `docs/desktop.md` |
| The way in | A first-run connect surface; failures classified (unreachable / signed-out / refused / rejected / engine-error / no-reply) instead of collapsed into "cannot reach the engine"; saving an address re-probes the shell |

**The honest gaps.** These are the facts the rest of the plan exists to fix:

1. **The update banner is dead in the packaged app.** Release assets are served from
   `objects.githubusercontent.com`, which sends no `Access-Control-Allow-Origin`; the
   webview fetch is blocked (console, four retries deep). Integrity data is published
   and correct — the transport can't read it. The app cannot see that v2.3.0 exists.
2. **The only shell and file tree are engine-gated.** `server/workspace/*` needs
   `WORKSPACE_RUN=1` plus a login, so on the default engine the Terminal answers
   `Error: Sign-in required` and the Workspace tree is empty/dead for most users.
   There is **no local filesystem or local execution surface at all**.
3. **Two parked branches of work** in `stash@{0}` (BYOK header + engine-side key
   handling; rmux-style persistent terminal dock) — unfinished, unrequested at the
   time, and still worth having.
4. **No model route other than the engine's own catalogue.** No local models, no
   Hugging Face, no user key that bypasses the engine's free pool.
5. **No agent that touches the user's own machine.** Build mode runs on the engine,
   in a per-session folder on the server. The freebuff premise — agents editing
   *your* files, locally, approval-gated — is unimplemented.
6. **No code signing**, so Windows SmartScreen says "unknown publisher" on a product
   whose headline is reliability. No auto-update-and-relaunch. No diagnostics bundle.

---

## 1. Parity matrix — freebuff's surface vs ours

Target is freebuff **as it actually ships** ([README](https://github.com/CodebuffAI/freebuff)
+ [the subagent write-up](https://freebuff.com/blog/freebuff-subagents-deep-dive)):
specialised agents rather than one model and one prompt, tools that run on your
machine, approvals on destructive actions, and research/browser use.

| freebuff capability | Ours today | Phase |
| :-- | :-- | :-- |
| Chat / Plan / Build modes | ✅ Chat modes + engine build sessions | — |
| Approval cards on mutations (frozen args, expiry) | ✅ but only for **engine** builds | P7 (local) |
| Model picker with catalogue + limits/per-model hints | ✅ engine catalogue only | P4/P6 (local + HF) |
| `file-picker` — rank the files a task needs from a code map | ❌ | P7 |
| `project-scout` — warm repo index, recent edits/lint/build metadata | ❌ | P7 |
| `test-runner` — detect framework (vitest/jest/pytest/go/cargo), run only what matters | ❌ | P7 |
| `code-reviewer` — read the diff, report by severity (`/review`) | ❌ | P7 |
| `git-curator` — style-matched commits, `/pr`, refuses to push to main | ❌ (engine GitHub tools only) | P7 |
| `shell-runner` — approved commands, long runs backgrounded with streamed output | ⚠ engine-gated terminal | P3/P7 |
| `browser-use` — real Chromium, log in / navigate / assert / screenshot | ❌ | P8 (stretch) |
| `researcher` — cited web research | ❌ | P7 (stretch) |
| Parallel agents in separate local workspaces ("run parallel agents locally") | ❌ | P9 |
| Slash commands (`/agent`, `/review`, `/pr`, `/interview`), `.freebuffrc` | ❌ | P7 |
| Run locally installed Claude Code / Codex with your own provider account | ❌ | P6 (BYOK, generalised) |
| Skills / knowledge surface | ✅ Library lists engine skills | P8 (Agent Skills from HF) |
| Local model connector (GGUF + llama-server) | ❌ | P4 |
| Text ads funding included models | n/a — the engine's free pool already plays this role | — |

**Where we are already ahead of freebuff and should stay ahead:** the document/office
engine (extract + generate docx/xlsx/pptx/pdf), the brand + anti-slop design engine,
the image route with a rescue chain, and three frontends on one free engine. The plan
must not trade those away for parity.

---

## 2. The two spine decisions

### 2.1 Rust is the network edge; the webview is not

Every "we can't reach it" bug in this app has the same cause: work that must happen
outside CORS/`fetch` limits is being done inside the webview. Release assets, model
downloads from `huggingface.co`, and a local `http://127.0.0.1:*` server are all
outside what a webview may fetch freely.

One command pair fixes the class, not the instance:

```
remote_get(url, allow_hosts) -> {status, body, headers}     # https + explicit allowlist
remote_download(url, dest, sha256, on_progress_event) -> {path, bytes, verified}
```

Rules: https only except `http://127.0.0.1`/`http://localhost`; a host allowlist
(`api.github.com`, `objects.githubusercontent.com`, `huggingface.co`,
`cdn-lfs*.huggingface.co`, `cas-bridge.xethub.hf.co`, the configured engine origin);
no redirects off the allowlist; a size ceiling; streaming progress events; sha256
verified before the file is ever handed to a child process.

### 2.2 Local-first: three model backends behind one picker

The desktop becomes a **model router**, not a thin client:

| Backend | Reaches | Cost to user |
| :-- | :-- | :-- |
| **Engine** (default, free pool) | GLM/DeepSeek-class free models, images, builds | none |
| **Hugging Face Inference Providers** (`@huggingface/inference`) | 100k+ Hub models via serverless providers, with the user's HF token | their HF account |
| **Local llama.cpp** (`llama-server`, OpenAI-compatible `/v1`) | Unsloth GGUFs on their own GPU/CPU, private, offline | disk + RAM/VRAM |
| **BYOK direct** (from `stash@{0}`) | any OpenAI-compatible endpoint, key rides the request | their key |

This is what "connect to Hugging Face models like Unsloth" means concretely, and it
is what makes the app survive the engine being down, gated, or out of quota. The free
path stays the default — this is additive, never a replacement.

---

## 3. Premium: what makes the shell read as "dev tool" today

Observed in `Sidebar.tsx` and `index.css` (1,814 lines of hand-rolled CSS, one accent
colour, light/dark only):

- **Emoji as the icon system** (`💬 🖼 🛠 🎨 📚 📁 ⚙️ 📂 ⌨️ 🕒 ✨`). Renders differently on
  every Windows build, no optical alignment, no weight control. This single line is
  the most "unfinished" thing in the product.
- **Twelve flat buttons**, two of them (`Workspace`, `Terminal`) dead for most users,
  and a `sidebar-hint` toast built out of a 4-second `setTimeout` — hints belong in a
  toast system with a queue, not in the sidebar.
- **No command palette, no menus, no status bar.** `Alt+1..6` is the entire keyboard
  story; there is no `Ctrl+K`, no discoverable action list, no per-view commands.
- **No type or spacing system.** System font stack (Segoe UI variable-width metrics
  differ per machine), no bundled typeface, no display face for the wordmark.
- **No motion, elevation, or focus affordances** — no focus rings, no transitions, no
  skeleton loaders, no empty states with an action.
- **No branding in the installer** (generic NSIS art, no publisher, no product icon
  set) and **no code signing**.

The repo already contains the tools to fix this honestly: `src/design/brand.js` does
palette extraction, semantic roles, WCAG AA contrast (`contrastReport`) and
`src/design/slop.js` is an anti-slop linter. **Apply them to the app's own shell** and
gate CI on the result. A design tool that doesn't pass its own linter is the exact
kind of thing a reviewer notices.

Concretely, the premium pass is:

1. **Icons**: `lucide-react` (tree-shaken, one dependency) replacing every emoji;
   consistent 1.5 px stroke, 16/20 px sizes, aligned to the label baseline.
2. **Design tokens**: one `tokens.css` from the brand engine — a real type scale
   (11/12/13/14 base steps + display), spacing on a 4/8 grid, radii, elevation,
   border/focus/overlay roles, semantic status colours, dark + light + a
   high-contrast variant. Ship **Inter + JetBrains Mono** so metrics are identical on
   every machine.
3. **Chrome**: Windows 11 Mica backdrop where available, native frame kept (snap and
   accessibility for free), a real toolbar per view, and a **status bar** (engine
   origin + health, active model + backend, tokens/s when local, git branch when a
   folder is open, version).
4. **Command palette (`Ctrl+K`)** over: screens, actions, recent chats, models,
   skills, folders. This is the single biggest usability-for-cost item in the plan.
5. **Feedback system**: toasts (queued, dismissible, with an action), skeletons for
   every async surface, empty states that name the next action, error states with
   Retry, a streaming caret, and `prefers-reduced-motion` respected.
6. **Installer branding**: NSIS/WiX art, real `productName`/`publisher`/icon set,
   per-monitor DPI-correct icon, taskbar name, and a **code-signing** decision (Azure
   Trusted Signing or an EV cert — this is the difference between "unknown publisher"
   and "FreeAI4U").
7. **CI gate**: `node --test` already runs `slop.js`/`brand.js` tests — extend it to
   run the linter over `desktop/src/**/*.css` + `*.tsx` and fail on new findings, so
   premiumness doesn't regress.

---

## 4. Reliability: the observable promise

What a "reliable" app must be able to say, and what currently says it badly:

| Promise | Today | Plan |
| :-- | :-- | :-- |
| "It opens." | WebView2 checked at boot, crash log, capped | + skeleton first frame, single-instance guard, boot watchdog |
| "It tells me what's wrong." | `connection.js` taxonomy + banner | + a Diagnostics screen and **Copy diagnostics** bundle (version, origin, gate state, provider health, WebView2 version, llama-server state, crash-log tail, last 200 log lines; no PII, no prompts) |
| "Updates arrive." | banner dead in the packaged app (CORS) | `remote_get` + verify sha256 + run the installer + relaunch, all native |
| "It doesn't lose my work." | chats in `localStorage`, 60-cap, validated import | + request/SSE abort + reconnect with `Last-Event-ID`, offline last-known catalogue, "queued until online" sends |
| "It recovers." | engine 429 retry budget in Settings | + the same retry/backoff policy for every route, a supervisor that restarts a crashed `llama-server`, and reap-on-quit for every child process |
| "I can trust the agent." | approval gate on engine builds | + the same gate on **local** writes/commands, frozen args, diffs rendered through the existing escape-first `diffHtml` |
| "I can prove it." | 1,239 node tests + a Rust build | + `cargo test` in CI (confinement, crash rotation, filters), + the eval harness in P7 |

---

## 5. Reference repos — what we take from each

| Repo | What it gives us | Phase |
| :-- | :-- | :-- |
| [unslothai/llama.cpp](https://github.com/unslothai/llama.cpp) | Prebuilt `llama-server.exe`; GGUF quants (`UD-Q4_K_XL` style); `-hf <repo>:<quant>` serves straight from the Hub on `http://localhost:8080/v1` with `/v1/models`, `/health`, `/slots`, `--api-key`, prompt caching | **P4** |
| [huggingface/huggingface.js](https://github.com/huggingface/huggingface.js) | `@huggingface/hub` (search, listing, Xet-aware resumable download), `@huggingface/gguf` (read a quant table from a **remote** file's header — describe a model before downloading it), `@huggingface/jinja` (chat templates, which vanilla llama-server inference gets wrong), `@huggingface/inference` (InferenceClient across providers), `@huggingface/mcp-client` + `tiny-agents` (tools), `@huggingface/tasks` | P4, P5, P6, P9 |
| [huggingface/huggingface_hub](https://github.com/huggingface/huggingface_hub) | The production reference for our OAuth + download behaviour: the `hf` CLI's browser/device login, `hf download` resumability and its cache layout. Reference, not a dependency. | P5 |
| [huggingface/skills](https://github.com/huggingface/skills) | The Agent Skills catalog and `SKILL.md` format (YAML frontmatter), installed with `hf skills add <name>`. Directly compatible with the engine's existing SKILL.md machinery, so this is ingestion, not a new protocol. Seed with `hf-cli`, `huggingface-local-models` (the model-selection catalogue), `hf-mem` (the VRAM/RAM guard), `huggingface-llm-trainer`, `transformers-js`, `huggingface-community-evals` | P8 |
| [unslothai/unsloth](https://github.com/unslothai/unsloth) | The UX bar for "run and train locally" (Local UI): model picker with quant/VRAM badges, run/train tabs, compare. Our Models screen should read like this one's Chat/Run side. | P4 (bar), P9 (train) |
| [unslothai/stable-diffusion.cpp](https://github.com/unslothai/stable-diffusion.cpp) | Local text-to-image via the `sd-server` HTTP mode (SD1.x/SDXL/Turbo/Qwen-Image class), which is the image analogue of llama-server — an offline generator for the Images screen | P9 |
| [unslothai/notebooks](https://github.com/unslothai/notebooks) | Curated, copy-paste recipes: source of ready-made task presets in the Knowledge screen, and the no-GPU fallback path (a Colab/Jobs recipe) when a user has no local hardware | P8/P9 |
| [unslothai/unsloth-zoo](https://github.com/unslothai/unsloth-zoo), [transformers fork](https://github.com/unslothai/transformers), [hyperlearn](https://github.com/unslothai/hyperlearn) | Training/finetune kernels, model-level fixes, optimizer research — the machinery behind the P9 fine-tune surface (LoRA → GGUF for the local server) | P9 (stretch) |
| [CodebuffAI/evalbuff](https://github.com/CodebuffAI/evalbuff) | The eval-driven knowledge loop: **carve a feature out, have the agent rebuild it, judge the trace, keep only the docs changes that raise the score.** Also its core argument — a hierarchical `docs/` with a table of contents in `AGENTS.md` beats a flat skills dump. Feeds both our agent's project knowledge and its CI eval | P7 |
| [CodebuffAI/codebuff-swe-bench](https://github.com/CodebuffAI/codebuff-swe-bench) | The harness shape for agent scoring (predictions jsonl → eval logs → a resolved % table), deliberately *not* retrying failed solves so the number stays honest. We adopt a miniature version | P7 |
| [CodebuffAI/stagehand](https://github.com/CodebuffAI/stagehand) | The `browser-use` subagent: Playwright-based, agent-first browser control (navigate, act, extract, assert on the DOM, screenshot). Its wider use — verify a web app you just edited — is the interesting one for us | P8 (stretch) |
| [CodebuffAI/opentui](https://github.com/CodebuffAI/opentui) | A Zig-core TUI with TS/React bindings. In the desktop's webview the right renderer for a terminal is still `xterm.js`; opentui's value is a **keyboard-first layout discipline** for the dock, and a genuinely cheap spin-off: one CLI that reuses the same agent core against the same engine | P3 (discipline), P9 (optional CLI) |

---

## 6. Phases

Every phase = code + tests + workflow wiring + a docs update, verified green before the
next, exactly as the APK phases were run. Effort is engineering days, not calendar.

### P1 — Trust spine: the Rust network edge, a real updater, and diagnostics
**Why first:** it repairs the shipped regression, makes integrity real instead of
cosmetic, and it is the prerequisite for every download in P4–P6. Nothing else in the
plan can land cleanly without `remote_get` / `remote_download`.
- `remote_get` / `remote_download` with the allowlist, https-only rule, size ceiling,
  progress events, sha256 verification (see §2.1).
- `useUpdateCheck` switches to the command; the banner finally fires; **Download and
  install** downloads, verifies, launches the installer, relaunches. Keep the manual
  link as the fallback.
- Single-instance plugin (second launch focuses the first window, no duplicate tray).
- Diagnostics screen + **Copy diagnostics** bundle (§4 table row 2).
- CI: add `cargo test` to the desktop job (confinement, crash-log rotation and cap,
  extension→filter map) — the Rust side has no test gate today.
- **Gate:** updater observed firing against the real `desktop-latest` release on a
  machine running the previous version; `cargo test` green in CI; a second launch
  does not create a second window.
- **Effort:** ~2 days.

### P2 — Premium shell: tokens, icons, palette, feedback, branding
**Why second:** pure perception and usability, zero engine risk, and it makes every
later phase look like a product instead of a prototype.
- `tokens.css` generated/validated by the **brand engine**, Inter + JetBrains Mono
  bundled, `lucide-react` replacing all emoji, Mica where available.
- Command palette (`Ctrl+K`), per-view toolbars, a status bar, a toast system
  (replacing `sidebar-hint`), skeletons, empty states, focus rings, reduced-motion.
- Re-label or retire the dead engine-only `Workspace`/`Terminal` nav entries: they
  move under an **Advanced → Engine shell** section (or Settings), so the sidebar
  stops advertising two things that mostly refuse to work.
- Installer branding + the code-signing decision (posed as a question, not assumed).
- **Gate:** `slop.js` linter runs over our own `src/**/*.css|tsx` in CI and passes; a
  contrast test asserts every text token pair at AA; screenshots before/after in the
  phase commit; keyboard-only walkthrough of all 7 screens.
- **Effort:** ~3 days (plus signing lead time, which is identity verification, not code).

### P3 — Local-first workspace and a terminal that runs here
**Why third:** it is the tool surface the agent in P7 needs, and it makes the app
useful with no engine at all.
- Rust: `local_list_dir`, `local_read_file`, `local_write_file`, `local_edit_file`,
  `local_run` (streamed stdout/stderr, exit code, timeout, PTY via `xterm.js` in the
  webview), plus folder-picking through the native dialog.
- **Confinement ported rule-for-rule** from the engine's `resolveInside()` +
  `protectedPath()` (`.git`, `.env`, `node_modules` never written), mirrored to JS for
  `node --test` the way `normalizeServer` was, **and** unit-tested in Rust.
- Frontend: a clearly-marked **LOCAL** tab beside the engine surfaces — real tree,
  read-only-by-default file view, a terminal with a live cwd, and a "no folder open"
  empty state that invites picking one.
- Un-park `stash@{0}`'s rmux-style persistent dock (sessions that survive screen
  switches, scrollback, cwd per session) on top of the new local runner.
- **Gate:** `node --test` confinement suite + `cargo test`; a run of `git status`,
  `npm test` and a deliberately escaping path (`..\..\Windows\System32`) in the real
  app; `pwd` reflects `cd`.
- **Effort:** ~3 days.

### P4 — Local models: llama.cpp + GGUF, Unsloth-style
- Pinned `llama-server` release fetched via `remote_download` (sha256 checked, cached
  in app data, presence verified at boot like the WebView2 check), with a documented
  offline path (drop the binary in the app folder).
- `local_model_start(hfRepo[:quant], {port, ctx, gpuLayers, threads})` spawning
  `llama-server -hf <repo>:<quant>`; poll `/v1/models` until warm; `_status` and
  `_stop`; a supervisor that restarts once and reports honestly.
- Models screen: curated list (Unsloth Qwen/Gemma/Llama GGUFs), **`@huggingface/gguf`
  reads the quant table and sizes from the remote file header** so the row can say
  `Q4_K_M · 2.1 GB` before anything downloads; **`hf-mem`-style RAM/VRAM pre-flight**
  on every Start; `@huggingface/jinja` for chat templates; a status chip from
  `/health` + `/slots` (loaded, ctx, tokens/s).
- A synthetic `local` provider in the chat picker (OpenAI-shaped, straight to
  `127.0.0.1`), plus the CSP `connect-src http://127.0.0.1:*`.
- **Gate:** state machine (stopped→starting→ready→error) unit tests; a real start of a
  small GGUF and a streamed reply; RAM guard rejects an oversized model with a
  readable reason.
- **Effort:** ~4 days.

### P5 — Sign in with Hugging Face, and the Hub browser
- OAuth **public app, no secret, PKCE**, loopback redirect (`http://127.0.0.1:<port>/callback`)
  with the device-code flow as fallback for locked-down machines. Register **both**
  `localhost` and `127.0.0.1` forms — loopback URIs accept any port but are matched
  per host, and only the port may differ (RFC 8252 §7.3 / OAuth 2.1, per HF's OAuth
  docs). Scopes: `gated-repos`, `read-repos` first; `contribute-repos`/`write-repos`
  only when push features exist. Token in the WebView2 secure profile (matching the
  existing login-cookie model) — never `localStorage`, never a commit, never logged.
- Library → **Hugging Face**: search GGUF repos, show licence/gated markers, quant
  options, size, and download with resume (Xet) + sha256 via `@huggingface/hub`;
  gated repos unlock with the token; "Run with llama.cpp" hands the file to P4.
- **Gate:** PKCE/state/URL helpers unit-tested with scripted crypto; search + download
  tested against a stubbed Hub API; a real gated-model fetch with a real token in a
  throwaway profile.
- **Effort:** ~3 days.

### P6 — Hugging Face as a model route (and BYOK, un-parked)
**This is the half that works on a laptop with no GPU.**
- `@huggingface/inference` `InferenceClient` behind the same picker: `chatCompletion` /
  `chatCompletionStream`, provider routing, and `textToImage` for the Images screen.
  One row per backend in the model picker: **Engine · free**, **HF · <model>**,
  **Local · <model>**, plus BYOK endpoints.
- Bring `stash@{0}` back down: the BYOK key rides the request for that call only, is
  never cached, never logged, and a logged-out caller gets nothing an anonymous relay
  would have given them. Show a per-backend usage note (free pool vs your HF account
  vs your own key) before a send, the way freebuff shows session limits.
- Optional: `tiny-agents` / `mcp-client` as a tool-provider seam so MCP servers become
  agent tools without inventing a new protocol.
- **Gate:** provider-selection policy unit-tested (never silently spends a user key on
  a free request, never silently falls back to the engine when the user chose local);
  a real streamed reply from two different backends; the note appears before the first
  send on a metered backend.
- **Effort:** ~3 days.

### P7 — The coding agent: local, approval-gated, freebuff-shaped
Ports the engine's proven loop rather than inventing one, and adds the freebuff
subagents that are cheap and high-value locally.
- **Loop**: plan → steps → tool calls (`list_files`, `read_file`, `search_files`,
  `find_files`, `write_file`, `edit_file`, `run_command`, `ask_user`), the tolerant
  tool-call parser, frozen-arg approvals with expiry, stop/repeat detection,
  `AGENTS.md`/`CLAUDE.md` project notes — all reusing the engine's semantics, with the
  tool executors swapped from the server workspace to P3's local commands.
- **Subagent passes**, in the order freebuff runs them: `project-scout` (index the
  open folder, keep it warm), `file-picker` (rank relevant files off that index),
  then the editor loop, then `test-runner` (detect vitest/jest/pytest/go/cargo, run
  what matters) and `code-reviewer` (severity-ranked diff review, `/review`).
  `git-curator` does commits/PRs **only** through approved commands and refuses to
  push to main. `shell-runner` is P3's runner with approval on anything destructive
  and backgrounding for long jobs.
- **UX**: a Code screen with the plan/step timeline, an approval queue, and a real
  diff card (`diffHtml`, already escape-first) — Approve / Reject / Edit-args.
- **Slash commands** (`/review`, `/pr`, `/agent <name>`, `/interview`) and a
  `.freeai4u.json` project config mirroring `.freebuffrc` (enable/disable subagents,
  default model, protected paths).
- **Evals** (this is where evalbuff + swe-bench pay off): a CI harness with scripted
  model responses over synthetic "edit this file" tasks, plus an evalbuff-style
  carve-out loop that only keeps knowledge/doc changes that improve the score. Report
  a resolved-% table in the phase commit — an honest number, no retries on failure.
- **Gate:** ported loop tests green; the eval harness reports a number in CI; a real
  end-to-end run on a scratch repo (describe change → approve diff → tests run).
- **Effort:** ~6–8 days. This is the flagship.

### P8 — Knowledge and skills (Agent Skills, HF catalog)
- Load `SKILL.md` (YAML frontmatter + body) the same way the engine's Library does, so
  one format serves both; the Library gains a Knowledge tab with the HF catalog and
  `hf skills add`-style install.
- Curate for our users: `hf-cli` (bootstrap), `huggingface-local-models` (which GGUF
  for which hardware — the Models screen's brain), `hf-mem` (the VRAM guard),
  `transformers-js`, `huggingface-community-evals`, and `huggingface-llm-trainer` for
  P9. Plus the repo's own knowledge: `AGENTS.md` as a table of contents over
  hierarchical `docs/`, maintained by the agent (the evalbuff argument).
- Stretch in this phase: `browser-use` via stagehand — a real Chromium sidecar the
  agent drives to verify a web app it just edited.
- **Gate:** the frontmatter parser rejects malformed skills with a readable error;
  a skill installs, appears, and actually changes agent behaviour in a scripted test.
- **Effort:** ~2 days (+2 for browser-use).

### P9 — Depth: local images, parallel agents, and (only then) fine-tuning
- **Local images**: `sd-server` pinned and verified like `llama-server`, exposed as an
  offline image backend next to the engine's free FLUX route.
- **Parallel agents in separate workspaces** — freebuff Desktop's headline. Several
  Code sessions, each bound to a folder, with a switcher and per-session status.
- **Stretch, explicitly opt-in and marked experimental**: LoRA fine-tune → GGUF →
  serve locally (unsloth + unsloth-zoo + the notebooks recipes, VRAM-guarded, never in
  the free path); and the opentui-based companion **CLI** sharing the agent core.
- **Effort:** ~4 days for the first two; training is open-ended.

---

## 7. Decisions to make (recommendations, not blockers)

| Question | Recommendation |
| :-- | :-- |
| Ship `llama-server` in the installer (+50–100 MB) or fetch a pinned binary? | **Fetch, pinned + sha256, cached in app data**, with a documented offline drop-in path. Smaller EXE, one code path with P1's downloader. |
| Default model for the coding agent? | **Engine free coder.** Code quality on 1–4B local GGUF is weak; local stays an explicit choice, and the picker shows a quality hint per backend. |
| Agent scope? | **One folder per session**, multi-folder only as multiple sessions (P9). Confinement stays provable. |
| HF token storage? | **WebView2 secure profile** in v1 (matches the existing session model); move to the OS credential store (`wincred`) when push features arrive. |
| Code signing? | **Yes, before calling it premium.** Azure Trusted Signing is the cheapest path; without it every install starts with "unknown publisher". |
| Keep the engine-only Terminal/Workspace in the sidebar? | **No — demote** to Advanced → Engine shell. P3's LOCAL surfaces take their place. |
| Telemetry? | **None.** Diagnostics are user-initiated and copyable. It is a claim the product can afford to make. |

---

## 8. Delivery contract (unchanged from the APK phases)

- One phase = commits to `main` containing code + tests + workflow wiring + a
  `docs/desktop.md` update.
- Each phase ends green locally (`node --test test/`, `npm run lint`, `tsc && vite
  build`, `cargo test`) **and** on CI: **CI ✅ + Desktop ✅ on the phase commit**.
- Pushing is `git fetch → rebase → stage only the intended files → commit → push`;
  never force-push, never an empty commit, no secrets in a diff.
- After the Desktop workflow finishes: `gh release view desktop-latest` **and** fetch
  `desktop-version.json` over the exact URL the app uses, confirming version + commit
  match HEAD. A green workflow that publishes stale metadata is not green.
- If a phase breaks the build, fix forward in the same phase before starting the next.

## 9. Definition of done — "premium and reliable", observably

1. The app tells you a newer version exists, verifies it, installs it, and restarts.
2. A fresh install with no network shows a first-run surface with an action, not a lock
   and not a blank frame.
3. With the engine unreachable, chat still works against HF and a local GGUF.
4. The installer is signed; no "unknown publisher" prompt.
5. Every async surface has a skeleton, an error state with Retry, and an empty state
   with a next action.
6. `Ctrl+K` reaches every screen, action, chat, model, skill and folder.
7. Every destructive local action shows a diff and waits for a decision.
8. One **Copy diagnostics** button explains any failure without a screenshot.
9. The app passes its own anti-slop linter and its own contrast tests in CI.
10. `cargo test` and `node --test` both run in CI, and the agent eval harness reports a
    real resolved-% number.
