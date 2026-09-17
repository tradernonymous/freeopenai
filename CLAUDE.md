# freeopenai — notes for Claude

<!-- Kept short on purpose: every line here is read at the start of every session. -->

FreeAI4U: a zero-dependency Node server (`server.js`, login gate, provider proxy) + one large web page (`index.html`, `chatlib.js`) + a Kotlin/Jetpack Compose Android app (`android/`). Deployed on Railway from `main`; the APK is published by CI to the `apk-latest` release.

## Commands

| Task | Command |
| --- | --- |
| Run locally | `npm start` → http://localhost:3000 |
| All web tests | `npm test` (node:test, `test/*.test.js`) |
| One test file | `node --test test/<name>.test.js` |
| Lint | `npm run lint` |
| Browser smoke | `npm run smoke` |
| Android build + tests | push, then `gh run list --workflow android.yml -L 3` → `gh run watch <id> --exit-status` → `gh run view <id> --log-failed` |
| Is Railway current? | `curl -s https://freeopenai-production.up.railway.app/api/health` → `commit` equals `git rev-parse origin/main` |

`gh` in Git Bash: `"/c/Program Files/GitHub CLI/gh.exe"`.

## Rules that bite

- IMPORTANT: two AI agents push to `main`. `git pull --rebase` before starting and before pushing; for bigger work use a worktree (`git worktree add --detach ../freeopenai-x origin/main`). On a rebase conflict: stop and show the user.
- `git add` only the files you changed. Never commit `.env`, keys or tokens; never force-push, amend pushed commits, or use `--no-verify`.
- No local Android SDK: Android work is not done until the Android CI run is green and `apk-latest` has the new build.
- Zero runtime dependencies on the server: do not add npm packages.
- Providers only through official free tiers and API keys: no reverse-engineered, impersonating or captcha-bypassing proxies.
- Secrets live in Railway variables and GitHub secrets. Never print their values. The APK signing key backup is outside the repo; never regenerate it.
- Shell heredocs in the Bash tool break on apostrophes: write multi-line scripts to a file first.
- The user is a beginner: finish with short numbered steps for anything they must do themselves.
- Update the README (concise) after 2–3 successful builds; details belong in `docs/`.

## Which skill to use (use them proactively, without being asked)

| When | Skill |
| --- | --- |
| Anything fails: test, CI, crash, provider error, "it doesn't work" | `systematic-debugging` |
| A push failed CI / the APK didn't publish / "did it build?" | `gh-fix-ci` |
| About to say done, fixed, deployed or pushed | `verification-before-completion` |
| Checking or proving existing work only | `verify-and-stop` |
| New feature or bug fix with a testable core | `test-driven-development` |
| Multi-step or multi-file request, or a list of wishes | `writing-plans` |
| Small bug, keep everything else untouched | `surgical-patch` |
| New feature, avoid overbuilding | `lean-build` |
| Moving/splitting code in `index.html`, `chatlib.js`, `server.js` | `safe-refactor` |
| Changing an API route, stored format, env var or provider contract | `migration` + `api-design` |
| 2+ independent tasks or research topics | `dispatching-parallel-agents` |
| Finished a risky change (auth, providers, security, CI) | `requesting-code-review`, then `receiving-code-review` for the feedback |
| Server code: streams, SSE, tests that hang, shutdown, timeouts | `node` |
| Auth, cookies, fetching user URLs, proxying providers | `owasp-security` |
| `.github/workflows/*` | `gha-security-review` |
| Any Compose screen or animation | `compose-multiplatform-patterns`, `compose-state-and-effects` |
| Kotlin threads, executors, coroutines | `kotlin-concurrency-and-flow`, `kotlin-patterns` |
| `AndroidManifest.xml`, intents, PendingIntent, share/tile/shortcuts | `android-intent-security` |
| `proguard-rules.pro` / release shrinking | `r8-analyzer` |
| Web page slow or growing | `performance` |
| Visual design: web UI, README art, app screens | `frontend-design` |

Project skills live in `.claude/skills/` (licenses kept in each folder). Area rules load from `.claude/rules/`.
