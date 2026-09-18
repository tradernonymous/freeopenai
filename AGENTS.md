# FreeAI4U — notes for an agent working in this repository

This file is read by the build agent at the start of every turn (and by other
tools that look for `AGENTS.md`). It says what this project is and the rules
that are easy to break without knowing them. Keep it short: every line here is
paid for on every turn.

## What this is

A free AI hub, in three versions that share one server:

| Part | Where | What it is |
| :-- | :-- | :-- |
| Server | `server.js`, `agent-sessions.js`, `chatlib.js` | Node with **no runtime dependencies**. Login gate, provider proxy, skills, remote builds. |
| Web app | `index.html`, `hub.js`, `hub.css` | One page. Chat · Plan · Build, workspace, GitHub tools. |
| Android | `android/` | Kotlin + Jetpack Compose client. minSdk 29, targetSdk 35. |
| Desktop | `desktop/` (Tauri 2 + React) | Native Windows app on the freeai4u engine: streaming chat, images, build approvals, skills. CI builds the exe; `node --test test/desktop.test.js` guards the wiring. |

Deployed on Railway from `main`. The APK is published by CI to the `apk-latest`
release, the exe to `desktop-latest`.

## Commands

| Task | Command |
| :-- | :-- |
| Run locally | `npm start` → http://localhost:3000 |
| All tests | `npm test` (node:test, `test/*.test.js`) |
| One file | `node --test test/<name>.test.js` |
| Lint | `npm run lint` |
| Browser smoke | `npm run smoke` (needs Chrome) |
| Android | no local SDK: push, then watch the `android.yml` run |

## Rules that bite

- **No npm runtime dependencies on the server.** Dev dependencies are fine;
  anything the server requires at runtime is not.
- **Providers only through official free tiers or the user's own API keys.**
  Nothing reverse-engineered, impersonating another client, or bypassing a
  captcha — however well it works.
- **Secrets never travel.** Not into a file, a log, a commit, a prompt or an
  error message. The APK signing key and the login password are never build
  inputs.
- **Two agents push to `main`.** `git pull --rebase` before starting and before
  pushing. On a conflict, stop and show the user.
- `git add` only the files you changed; never `git add -A`. Never force-push,
  amend a pushed commit, rewrite history, or use `--no-verify`.
- **Android work is not done until CI is green** and `apk-latest` has the new
  build. There is no local Android toolchain.
- A user-supplied URL is parsed with `new URL()` and its host checked on
  **every redirect hop**, not just the first.

## How to work here

- Read before you edit: `search_files`/`grep` for the thing, then read the file.
  Match the surrounding style; this codebase comments *why*, not *what*.
- Keep the diff inside the task. Report unrelated problems rather than fixing
  them in the same change.
- Add or adjust a test for anything with a testable core, and run the affected
  file while iterating; run the whole suite once before pushing.
- Say "verified" only about checks that actually ran, and name what did not.
- Docs live in `docs/`; the README stays short and links to them. One fact in
  one place.
