# Remote builds

A plan written anywhere (Plan mode on the phone, the web app or the desktop app) is carried out **on the server**, in its own folder, one approved change at a time.

## How it works

1. Ask for a plan in **Plan** mode.
2. Press **Build** under the reply (web/desktop) or **Build remotely** (phone).
3. The build agent works through the steps in `workspace/builds/<id>/`.
4. Every **file write, edit and command** stops and waits for **Approve** or **Reject** (with a reason the agent reads).
5. Watch it live in **Builds**. A build started on the phone shows up on the web and desktop too.

| Guard | What it does |
| :-- | :-- |
| Approval per call | The exact arguments are frozen when the question is asked; what runs is what you saw. |
| Stale answers | An answer for an older request is refused (`409`). |
| Expiry | An approval nobody answers in 30 minutes stops the build. |
| Folder | Paths outside the build folder, `.git/` internals and `.env` files are refused before you are asked. |
| Commands | Off unless `WORKSPACE_RUN=1`; they run with a clean environment (no server keys) and a time limit. |
| Git | Runs as the GitHub account you connected: the token goes to git in its environment, never into a command or a file, and is scrubbed from output. Force pushes, `--amend`, `rebase`, `-i` and global config are refused. |
| Weak models | Tool calls written as text — JSON, `<tool_call>`, `<function=…>`, `[TOOL_CALLS]` — are run, not printed; a model repeating one call is stopped. |
| Budget | 120 model turns and 300 tool calls per build; three turns before the end the agent is told to wrap up with a summary. |
| Owner | Each build belongs to the account that started it. Builds need a login (`AUTH_USER_1`). |

## Tools

| Tool | Asks first | What it does |
| :-- | :-- | :-- |
| `plan_actions` | per action | **Several steps in one call.** Each action names its tool, its arguments and what it waits for; the engine runs them in order without asking the model again. |
| `step_update` | | Marks a plan step in progress, done, failed or skipped. |
| `list_files`, `find_files` | | Lists a folder with sizes; finds files by glob (`src/**/*.kt`). |
| `read_file` | | Reads a file, or a line window of it (`offset`, `limit`). |
| `search_files` | | Grep: `path:line: text`, case-insensitive, plain or regex, optional glob. |
| `write_file`, `edit_file` | ✔ | Whole file, or one exact `old_text` → `new_text` (`all` for every occurrence). |
| `delete_file`, `move_file` | ✔ | Remove or rename one file. |
| `run_command` | ✔ | Shell in the build folder: install, test, build, git. |
| `web_search`, `web_fetch` | | The web, public pages only. |
| `ask_user` | | One short question, waits for the answer. |

**Why `plan_actions` matters on a free model.** A model asked again between every step spends most of a build re-reading its own context, and a small one loses the thread; twelve steps meant twelve calls. A plan is one call: read three files, edit two, run the tests, in an order the model wrote down once. Independent actions keep the order they were written in, an action that names `after` waits for it, and a cycle, an unknown tool, a duplicate id or a dependency that is not in the plan is refused before anything runs. Approvals are unchanged — every write, delete, move and command inside a plan still asks you — and an action whose dependency failed is skipped rather than run on a broken assumption, with the report naming which. At most 24 actions per plan; `ask_user` and a nested plan are not allowed in one.

The agent also reads the repository's `AGENTS.md` or `CLAUDE.md` into its prompt each turn, so project rules apply without being pasted into the plan.

## Settings

| Variable | Default | What it does |
| :-- | :-- | :-- |
| `WORKSPACE_RUN` | *(unset)* | `1` lets builds run commands (tests, builds, git), each after approval. |
| `BUILD_AGENT_PROVIDER` | *(auto)* | Provider for the build agent. Auto order: NVIDIA → Cloudflare → OpenRouter → OmniRoute → Nara → Custom. |
| `BUILD_AGENT_MODEL` | *(provider's first)* | Model for the build agent, e.g. `qwen/qwen3-coder-480b-a35b-instruct`. |

> [!NOTE]
> Railway's disk is temporary: build folders disappear on redeploy. Clone a repo into the build and push results with git (approved as a command) to keep them.

## API

All routes need the login cookie. `POST` bodies must be `application/json`.

| Route | Body / answer |
| :-- | :-- |
| `POST /api/build/sessions` | `{ chatId, plan, repo?, branch?, provider?, model? }` → session (`201`) |
| `GET /api/build/sessions` | `{ enabled, reason, runEnabled, runReason, tools[], sessions[] }` |
| `GET /api/build/sessions/:id` | `{ id, status, steps[], pending, provider, model, startedAt, summary, error, lastSeq }` |
| `GET /api/build/sessions/:id/events` | SSE. `id:` is the sequence number; send `Last-Event-ID` to resume. Events: `status`, `step` (`phase`: started/done/failed/skipped/output), `diff`, `approval`, `question`, `answer`, `message`, `done`, `failed`, `gap`. |
| `POST /api/build/sessions/:id/input` | `{ requestId, decision: "approve" \| "reject", text? }` or `{ requestId, text }` for a question |
| `POST /api/build/sessions/:id/cancel` | `{}` → session |

Status values: `queued`, `running`, `awaiting_approval`, `awaiting_input`, `done`, `failed`, `cancelled`, `expired`.

Code: [`agent-sessions.js`](../agent-sessions.js) · tests: [`test/build-sessions.test.js`](../test/build-sessions.test.js).
