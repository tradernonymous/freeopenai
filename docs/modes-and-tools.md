# Modes, skills and tools

[← Back to README](../README.md)

### 🧩 Modes & skills (opencode-style)

The composer has a mode chip that cycles **Chat → Plan → Build**, the same three modes opencode uses:

| Mode | What it does | Skills applied |
| --- | --- | --- |
| **Chat** | Default assistant — ask anything | Nothing auto-picked — but pinned skills still apply |
| **Plan** | Reasons about the task, writes an implementation plan, changes nothing | planning/writing skills as matched |
| **Build** | Executes with the full tool loop, TDD-first discipline | methodology core + best-matched skills |

**A mode is a tool surface, not a tone of voice.** Chat and Plan are not asked nicely to behave — the write tools are **not sent to the model at all**, and a call that arrives anyway is refused by the runner with a message naming the mode and how to leave it. That is the difference between a mode that can be talked out of its rules and one that cannot.

| | Research | Workspace | Repos | Task list | Skills |
| --- | --- | --- | --- | --- | --- |
| **Chat** | `web_search`, `web_fetch` | read, search | read, search, commits, branches | — | — |
| **Plan** | the same | the same | the same | `task_*` | `use_skill` |
| **Build** | the same | **+ write, edit, delete** | **+ commit, delete, create branch** | `task_*` | `use_skill` |

`web_fetch` reads public pages only. Every redirect is checked again, so a public link that forwards to a private or internal address is refused.

The split follows opencode, which is where the three modes come from: **Chat researches** (search, read pages, cite primary sources, answer — no plan document, no commits), **Plan investigates and proposes** but cannot change anything, and **Build executes** the agreed plan with the write tools in hand. The task list is deliberately a Plan-mode tool: writing down a plan is the point of the mode, so the task tools are not in the write group and are not refused. A tool in no group is offered in every mode — the table is a lock on writes, never on a read tool added later. The rule is enforced by a test rather than by care: every name in a write group has to read as a write, and `github_create_branch` is why that check asks about the verb (`create`, `commit`, `delete`, `write`, `edit`) instead of requiring the suffix `_file` — a tool that changes a repository without touching a file would otherwise have been argued out of the group that keeps it out of Plan mode.

Skills are pulled from open libraries — no setup, cached 6h, degrading to the last-good copy if GitHub is down. **136 skills** across eleven libraries, loaded in about half a second cold and 3 ms warm:

| Library | What it contributes |
| --- | --- |
| [anthropics/skills](https://github.com/anthropics/skills) | The full official set (frontend-design, docx, pdf, mcp-builder, …) |
| [obra/superpowers](https://github.com/obra/superpowers) | Development methodology: TDD, systematic debugging, verification before completion |
| [mattpocock/skills](https://github.com/mattpocock/skills) | Engineering practice: code review, diagnosing bugs, codebase and domain design |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | Copy, SEO, ads, analytics — the other half of an assistant's work |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | The lazy-senior-dev discipline (YAGNI, stdlib first) plus its review/audit/debt/gain companions |
| [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | Lite pick: `lean-build`, `surgical-patch`, `verify-and-stop`, `caveman-commit`, `caveman` |
| [blader/humanizer](https://github.com/blader/humanizer) · [petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop) | Writing: rewriting AI tells out of prose, and sharpening a draft without flattening it |
| [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design) · [tt-a1i/archify](https://github.com/tt-a1i/archify) | Diagrams as standalone HTML/SVG, from a description or a repository |
| [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) | Output shaped for a reader who needs the next action first |

How auto-application works: each request's text is scored against every skill's name + description (stemmed, name hits weighted 3×, generic verbs ignored). A skill needs **two shared words, or one that is part of its own name** — one generic word is a coincidence in a library this size. The top matches ride along as extra system context in Plan and Build modes; Build additionally seeds the process core (TDD, verification-before-completion, lean-build) once something has actually matched. In Build mode the model can also call the `use_skill` tool to load any skill's full text mid-task.

**The router is measured, not assumed.** A router fails quietly: its tests pass while it answers a JavaScript question with an SEO skill. `tools/skill-audit.js` runs twenty ordinary requests through the real library and reports which skills answered and whether any came from the wrong field — `node tools/skill-audit.js`. `test/skill-router.test.js` asserts the same run against a committed snapshot of the catalogue (`test/fixtures/skill-catalogue.json`), so a router change shows up as a diff in behaviour. Current state: **no request is answered from an unrelated field**, and a request matching nothing picks nothing. Three wrong picks remain, listed in the test as a ratchet: `ab-testing` and `ai-seo` on requests that merely contain the word "test" or "ai", and `sms` on a diagram request — one ambiguous word shared with a skill the library also uses generically, which word overlap alone cannot resolve.

**Pinning a skill to a chat.** Auto-picking is per request and forgotten by the next question. The **Session → Skills** tab (one chip in the composer, one button in the header; typing `/` and a name works too) does the other thing: it pins a skill to the **conversation**, so `/ponytail` on the first message is still applying on the ninth — in Chat mode too, where no auto-skills fire at all, and with auto-skills switched off entirely. A pinned skill is saved with the chat, survives a reload, and a new chat starts with none of them, so a choice is never inherited by a conversation that did not make it. Up to five at once; past that the oldest is turned off and the app says which. Pinned chips sit above the composer with an `×` each, the picker is searchable and toggles items on and off, and a skill the model loads itself with `use_skill` is pinned too, visibly — otherwise the next turn would fetch the same text again.

**Offers, learned from what you pin.** Pinning the same skill in two *different* chats is a habit, and once a skill is one the app offers it while you type — a dashed `Try ponytail?` chip with **Add** and `×`, scored against the text being written so accepting applies to *that* request. Declining is remembered for the chat. Four things keep it from becoming a suggestion engine with opinions: habit is counted by **chat** rather than by click (un-pinning and re-pinning in one conversation is one intention), **only deliberate pins count** (a skill the model loaded for itself with `use_skill` is the app's doing, not a preference), the offer is **a question and never an action** — a skill that switched itself on would spend prompt budget on every request of a chat that never asked for it — and the habit store is bounded to the most recent 60 skills. It is browser-local (`freeopenaiSkillUsage`), so it does not travel between devices and carries nothing identifying about the requests themselves.

**Which skills are answering.** The Session panel's Skills tab lists every skill that has applied to this conversation, tagged `pinned` or `auto` and showing how many requests each rode along with — the picker above it filters the installed library with a search box, and the auto-skills switch sits beside the list it governs. The log exists because the router's choices are invisible by design — a skill leaves no trace in the reply — so an answer that came out oddly should be traceable to a method rather than guessed at. Tap an `auto` row to pin it, a `pinned` row to let it go. The record is per conversation and lives in your browser (`freeopenaiSkillUse`); a new chat starts it empty.

**Commands.** Typed into the composer: `/help`, `/skill <name>`, `/skill off <name>`, `/skills`, `/mode chat|plan|build`, `/clear`. Or skip the verb: `/ponytail` and `/caveman` are the shorthand, since typing the name is how people actually reach for a skill. Anything else that starts with a slash — `/usr/bin is missing` — is sent to the model as the ordinary message it is; the app never swallows text it did not understand. Commands are answered locally, so opening the skill picker costs nothing.

- `GET /api/skills` — the installed catalogue (source, name, description)
- `GET /api/skills/content?name=<skill>` — one skill's full SKILL.md
- `SKILLS_CACHE_TTL_MS` — cache lifetime override (default 6h)
- **`GITHUB_TOKEN`** — *set this if the picker ever looks empty.* The catalogue is read from each repo's git tree, and GitHub allows **60 unauthenticated tree requests an hour per address**. Eleven sources spend that in about five refreshes, and the budget is per address — so on a container host, an office or a VPN it is shared with everyone behind it, and the library goes quiet part way through the day. A token raises the same limit to 5000, and you already have a GitHub account if you are using the repo tools. The refusal is now logged once per refresh with the variable named, instead of leaving a picker that is simply empty.
- Add your own in `SKILL_SOURCES` (chatlib.js): `dir` is the folder holding the skills and `pick: [...]` narrows a big repo to a chosen few. Nesting and root-level `SKILL.md` files are handled; the name comes from the folder holding the file.

### 🐙 Working with GitHub

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (from a [GitHub OAuth App](https://github.com/settings/developers) whose callback URL is `https://<your-app>/api/github/callback`) and a **Connect GitHub** row appears in Settings.

Once connected, the model can work with your repos directly:

| Tool | What it does |
| --- | --- |
| `github_list_repos` | Lists public repos across every connected account |
| `github_list_files` | Lists a folder, so it can find a path |
| `github_read_file` | Reads one file |
| `github_search_code` | Searches code across a repo, so it finds the right file instead of guessing paths |
| `github_list_commits` | Lists recent commits, with messages and dates |
| `github_list_branches` | Lists branches and says which is the default |
| `github_commit_file` | Writes and commits — **always asks you first** |
| `github_delete_file` | Deletes a file and commits the removal — **always asks you first** |
| `github_create_branch` | Creates a branch from another or from the default — **always asks you first** |

**Branches.** Every read and write takes an optional `branch`; without one, GitHub's default branch is used, which is what every call here did before. The commit tool looks up the file's sha *on the branch it is writing to* — a sha read from a different branch names a different blob, and GitHub rejects that commit as a conflict that reads like someone else changed the file.

`github_create_branch` exists because its absence was reported by the agent itself. Asked to put work on `main` in a repository whose only branch was `claude/…`, it replied that branch creation "requires the GitHub web UI or the git CLI" and handed over a list of clicks. It was right about its tools and wrong about the API — a branch is one POST to `/git/refs` — so the tool surface was the only thing missing. Creating a branch that already exists is reported as an outcome rather than an error, because a `422` there reads as a failure and makes a model retry under a different name.

Up to **three accounts** can be connected at once. Which one acts on a repo is resolved in a fixed order: an explicitly named account, then the repo's owner, and otherwise it refuses and asks — it never tries tokens in turn until one works, because guessing wrong on a write means committing under the wrong identity.

> Untick **Expire user access tokens** when registering the OAuth App. Refresh tokens aren't implemented, so an expiring token would silently disconnect after 8 hours.

### 🗂️ The workspace

Every chat can also read and write a small **workspace**: a flat set of text files the model keeps notes and drafts in.

| Tool | What it does |
| --- | --- |
| `workspace_list_files` | Lists a folder, with the size of each file |
| `workspace_read_file` | Reads one file |
| `workspace_search_files` | Greps the workspace, with the line each match is on |
| `workspace_write_file` | Creates or replaces a file — **always asks you first** |
| `workspace_edit_file` | Replaces one exact string in a file — **always asks you first** |
| `workspace_delete_file` | Removes a file — **always asks you first** |

`workspace_edit_file` exists because of what a whole-file write costs: re-sending a long file to a model to change one line is expensive and the model often truncates it. An edit sends the old text and the new text, and the change is refused if the old text appears zero times or more than once — an ambiguous anchor would silently edit the wrong one.

It lives in your browser (localStorage) beside the conversations, not on the server. The deployment is shared and its container is rebuilt on every push, so a server-side workspace would be both visible to other people and temporary. Files can be downloaded or deleted from **Settings → Workspace files**.

Paths are relative to the workspace root and a `..` is refused rather than resolved away, so nothing can reach outside it. Writes are capped (100 kB per file, 200 kB and 64 files in total) because the conversations share the same few megabytes of storage.

Reads run in parallel with other reads; writes never do, since two writes to one path in the same moment is a race whose loser vanishes.

### 🖥️ Running a command

The one tool that reaches a real machine. It exists because a note-taking scratch space cannot *do* anything: writing a script and running it — generating a PDF, producing a file, running a test — needs a filesystem and a shell, and the browser-local workspace has neither by design.

| Tool | What it does |
| --- | --- |
| `run_command` | Runs a shell command on the server and returns stdout, stderr, the exit code, the shell it used and the files the workspace now holds — **always asks you first** |

**Off until an operator turns it on, and only where there is a login.** Two independent conditions, and neither is a default:

| Variable | Default | What it does |
| --- | --- | --- |
| `WORKSPACE_RUN` | *(unset)* | Set to `1` to enable `run_command` at all. A push therefore never turns a deployment into a shell by itself. |
| `WORKSPACE_RUN_TIMEOUT_MS` | `120000` | How long one command may run before it and its whole process tree are killed. Clamped between 1s and 10min. |

The second condition is the one that matters: the app must already have `AUTH_USER_1`/`AUTH_PASS_1` configured. `isAuthenticated` treats an app with *no* accounts as open to everyone, so on such a deployment a shell route would hand a shell to anybody holding the URL — and the container's environment holds your provider keys. `WORKSPACE_RUN=1` without a login is refused with that sentence, not with a 500.

**What a command is not allowed to see.** It gets a scrubbed environment — `PATH`, a locale, a temp dir, and `HOME` pointed at the workspace — and never the app's own environment, so a script cannot read `NARA_API_KEY`, `GITHUB_TOKEN` or `SESSION_SECRET`. `NODE_OPTIONS` and `LD_PRELOAD` are scrubbed for the sharper reason: either one runs code *around* the command you approved. The working directory is confined to the workspace (`..` is refused, not resolved away), stdout and stderr are capped at 32 kB each, and one command runs at a time so a hung install cannot be stacked behind.

**Where the files go, and where they don't.** Commands run in `workspace/` beside the app — a directory inside the container, so it is **gone on the next deploy**. That is the honest place for a scratch directory on a service that rebuilds its container, and it is why the panel says so. Produced files are listed with their size in the tool result (so the model can hand you a link), announced in the chat itself (`Wrote report.pdf (12.0 KB) — Settings → Server files`) whenever a command added or changed one, and listed in **Settings → Server files**, where each one downloads through `/api/workspace/file`. A downloaded `.pdf` arrives as a PDF, not as a blob, because "generate a PDF and give it to me" is the thing this was built for. The chat line is the part that matters: the model knows about the file either way, and without it you would be taking the reply's word for something you cannot see.

**Build mode only, and only where the server offers it.** The shell is a write in every sense that matters, so it is not in the request at all in Chat or Plan mode, and a call that arrives anyway is refused by the same gate every other write goes through. The page also asks once at load what this server allows — the same request the panel uses — so on a deployment where `WORKSPACE_RUN` is unset the tool is not in the request either: a tool that can only answer "this is switched off" costs a round trip and a dialog you have to decline. The refusal stays wired for a server that changes its mind mid-session. Approval is remembered separately from file writes: allowing a note to be saved this session is not allowing a command to run.

### ✅ The task list

The model can also keep a **task list**: the plan for work that spans several turns and chats, so a follow-up doesn't have to be told the whole story again.

| Tool | What it does |
| --- | --- |
| `task_list` | Shows every task with its status, id and dependencies |
| `task_add` | Records a task, optionally waiting on an existing one by id |
| `task_update` | Moves a task to `todo`, `doing`, `done` or `blocked` |

A task that still waits on unfinished work cannot be marked `done` — the one status change that can make a plan look finished when it isn't. A dependency must name a task that already exists, and ids are handed out in order, so a cycle cannot be expressed in the first place.

The list is the **Plan tab of the Session panel**, a glass pop-up over the chat rather than a column of the layout, because a plan you have to go and open is a plan nobody keeps current. Each row carries its id and what it still waits on, its note opens in place, and a hairline at the top fills as tasks finish. Rows order themselves — in progress, then to do, then blocked, then done — so the next thing to pick up is the first thing you read. Tick the circle to finish a row, `×` to drop it. The panel folds away with the Session button in the header or the chip in the composer, becomes a drawer over the chat on a phone, and its open/closed state and section are remembered per browser. Escape closes it, but a click elsewhere deliberately does not: the plan is meant to be read while the work happens.

It is kept in the browser like the workspace and rides in the system prompt when it isn't empty, so a later turn — or a different chat — can pick the work up where it stopped. **When a reply arrives while the list it touched this turn still has items open, the app hands it back to the model once and asks it to finish them or say plainly which are open**, because "done, all sorted" reads as complete while three unticked rows sit beside it. The check is armed only by a turn that actually wrote to the list, so an old open task from another conversation never interrupts an answer about something else.

No approval is asked for a change: it alters nothing outside the conversation, and a dialog in front of every status change would make planning unusable. **Settings → Tasks** shows the count and points at the panel rather than repeating the list, since two renderings of one list is two places for it to be wrong.

### ⬇️ Reading while it writes

A reply that arrives while you are reading something above it is the case every streaming app gets wrong. This one used to write the scroll position from ten places, nine of them unconditional, so a streamed reply dragged you back to the bottom roughly every 40ms and you could not read anything until it finished. There was also no "am I at the bottom?" answer anywhere, which is why a scroll-to-bottom control could not exist: it had nothing to be drawn from.

The policy now lives in `chatlib.js` as rules that are tested without a browser — *at the bottom* means within 120px of the newest line, a transcript too short to scroll is always at the bottom, and only two things may move you against your own scrolling: **the message you just sent**, and **something you asked for** (tapping the pill, opening a saved chat). Everything else — a streamed chunk, a tool notice, a picture finishing — obeys the pin. One seam (`appendToTranscript`) is where every arrival goes, so this is a decision rather than an accident of which function appended it.

When output lands while you are reading above it, a pill appears above the composer: **`3 new`** when there is a count to give, `New output` while a turn is still running, `Newest` when you have scrolled up in a reply that has stopped growing. It is anchored to the reading column rather than the window edge, so on a wide screen it sits where the text is.

Two details that took a real browser to find. Off-screen bubbles are laid out lazily for scroll performance, so the bottom of the transcript is a *moving* maximum: a single write to it lands a few lines short, and a jump therefore settles over a few frames, bounded so it can never spin. And a **rotation** re-lays the whole transcript, which fires a scroll event with a clamped position that reads as "the reader scrolled away" — so the pin is read *before* the re-layout and restored after it, or turning your phone would drop you into the middle of an old reply.

**A turn says what it is doing.** The three dots said "busy", which is the same for a two-second lookup and a stuck provider; beside them a label now names the step — `Thinking…`, the tool being run, `Writing the reply…` — and goes away with the row.

**Generated pictures are kept, not just described.** Every Puter image arrives as a `data:` URL, with the whole picture inside the string, and history kept only `http(s)` links — so the picture was dropped the moment it was saved. The bubble showed it (still in memory) while the Gallery, which reads saved history, had nothing but the prompt. The bytes now go to an **IndexedDB index** (`image-store.js`) at the size they were drawn, and a conversation carries a few dozen bytes naming them — an id, the prompt, and how big the picture is. A remote link is still left as it stands, because those bytes were never ours. The newest eight pictures per chat are kept, and a browser with no index — a locked-down private window, an engine that refuses one — falls back to the compact inline copy, which is why that path still exists. When browser storage fills up, **the pictures go before the history does** — a chat with no image is still a chat, a chat with no history is a loss — and every step of that is a rule with its own test rather than a try/catch nobody reads.

> **Why it moved.** The stored copy used to be a 1024px JPEG at a quality that went as low as 0.3, because localStorage is about 5MB shared with every chat's text and a 1536x864 drawing is megabytes of base64. So the picture that came back in a reopened chat was not the picture that was drawn, and the Download menu was converting *that* copy: "Save at 1024 × 576" was the honest report of a 1536x864 request. `STORED_IMAGE_MAX_EDGE` survives only in the no-index fallback, where a reduced picture is still better than a lost one.

**An image request is read, not matched.** The first version decided with a regex. If the words contained no verb-and-noun pair from a fixed list, the turn fell through to a vision chat — so "make the sky purple" with a photo attached answered *about* the photo, and never reached an image model at all. And whatever survived that filter was sent on as the prompt verbatim, so "make it warmer" arrived at the image model with nothing to warm. One small model call now reads the turn and returns `{"action": "generate" | "edit" | "chat", "prompt": "…"}` — the action ChatGPT gets from its image tool's `action: "auto"`, and the rewritten prompt it gets back as `revised_prompt`. The keyword rules stay underneath as a *floor* rather than a fallback, because the bug they fix is worth keeping fixed: with a picture attached, no reading of a request may turn an edit into a fresh text-only render (the poster-of-a-car bug). A plan may only move a turn *into* image work. The call is made only for turns that could plausibly be image work — something attached, a draw request, a picture already in the chat, or the image toggle — so an ordinary chat message never pays for it, and any failure at all leaves the keyword decision in charge (`resolveImageAction` in `chatlib.js`, tested without a browser).

**Follow-ups edit the last picture, and one pipeline draws them all.** "Now make it look realistic" has no attachment to work from, and re-uploading your own output by hand is not something anyone does — so the newest picture stored in the chat is the source when nothing is attached, which is multi-turn editing. Because that source can be a remote link rather than a data URL, the edit route now fetches it (through the same private-address guard the page reader uses, since the URL comes from the browser). The composer, the brush editor and the Variations button all go through one chain, which is what makes that true everywhere at once: the brush editor used to POST straight at the server route, so a Puter user with no Nara key painted a region and got "Image editing needs NARA_IMAGE_MODEL" — naming a backend they were not using. A painted mask now reverses the chain (Puter has no mask field at all), is scaled to the source picture's own size rather than the 640px canvas it was painted on, and if the route cannot take it the brush is dropped and Puter is asked without it — with the drop said out loud instead of silently changing the result.

**The right model, at the right quality.** (Puter draws only when **Draw with Puter** is on; this is what it does when it is.) Puter draws at `low` when nothing asks for better, and nothing did — every picture this app produced was rendered at the bottom tier while paying the same credits. `quality: "high"` is now asked for explicitly, on both backends. The model is picked by the job too: Puter documents **Sunburst** for editing precision and **Flare** for fast generation, where the app pinned `gpt-image-2`/`gpt-image-1.5` for both. Edits name the picture through `input_images`, the field Puter's docs identify as the one that routes through the image *edit* endpoint, rather than `input_image`, a shorthand whose silent fallback to text-to-image would hand back a plausible new picture where an edit was asked for — a failure that looks like success. A refusal (`moderation_flagged` and the prose wordings for it) ends the chain immediately and says what to reword, because the same prompt asked of another model or another service can only come back refused again.

**Every key draws, not just Nara's.** The image route was Nara's and only Nara's: an operator with an OpenRouter or NVIDIA key could chat on it and not draw, and asking for a picture answered *"Image generation needs NARA_IMAGE_MODEL"* — naming a service they had not configured. Each provider now declares how it draws in an `image` block of its own (an OpenAI-shaped body, or NVIDIA's `{prompt} → {artifacts}` GenAI shape), the route walks the order and takes the first service that answers with a picture, and every answer is normalized to the OpenAI payload the browser already reads. Which one drew comes back with the picture and is said on screen, because that is the one fact about an image nothing else can recover. The order falls through on anything that is a fact about *that* service — a forbidden key, a model the account cannot reach, a bill, a 5xx, a dead socket — and stops on a refusal, since every service is being handed the same prompt. See [Image providers](providers.md).
