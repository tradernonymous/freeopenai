---
name: "gh-fix-ci"
description: "Fix failing GitHub Actions on main. Use whenever a push fails CI or the Android build, when the APK was not published, or when asked 'did it build?' - read the failed run logs with gh, fix, push, and watch the next run."
---

# Fix failing GitHub Actions on main

Adapted for freeopenai from openai/skills `gh-fix-ci` (Apache-2.0, see LICENSE.txt). This repository pushes straight to `main`; two agents may push, so always look at the run for YOUR commit.

## Workflows
- `ci.yml`: web tests, lint, smoke.
- `android.yml`: JVM unit tests, compiles the Kotlin app, signs and publishes `neuraos.apk` + `version.json` to the `apk-latest` release. There is no local Android SDK: this run IS the compiler.

`gh` may not be on PATH in a fresh shell; use `"/c/Program Files/GitHub CLI/gh.exe"` in Git Bash.

## Loop
1. Find the run for your commit:
   `gh run list --workflow android.yml --branch main -L 5 --json databaseId,headSha,status,conclusion`
2. Wait for it without polling by hand: `gh run watch <id> --exit-status > /dev/null; echo exit=$?`
3. On failure, read only the failing lines:
   `gh run view <id> --log-failed | grep -E "e: file|error:|FAILED|What went wrong|AssertionError"`
   Kotlin errors look like `e: file:///.../X.kt:LINE:COL message`.
4. Fix every reported error in one pass (the compiler often stops per module, so re-check after the next run).
5. Verify what can be verified locally (`npm test`, `npm run lint`), commit only the fixed files, `git pull --rebase`, push.
6. Watch the new run. Repeat until green, then confirm the artifact (for Android: `gh release view apk-latest --json assets`).

## Rules
- Never push a change you know still fails; never use --no-verify, force-push or amend to "fix" CI.
- Do not re-run a failed job hoping it passes unless the log shows an infrastructure flake (network, runner), and say so.
- Report the run URL and the decisive error line to the user, not the whole log.
