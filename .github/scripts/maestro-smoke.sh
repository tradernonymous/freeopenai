#!/usr/bin/env bash
set -euo pipefail

adb install -r "$GITHUB_WORKSPACE/android/app/build/outputs/apk/debug/app-debug.apk"
cd "$GITHUB_WORKSPACE/.maestro"
# Sign in once (the engine the job started on the runner); the session is
# stored, so every flow after this opens on Chat instead of the sign-in form.
maestro test subflows/sign-in.yaml
# Flows tagged needs-provider want a real model behind the engine (images,
# remote builds, approvals); CI's throwaway engine has none, so they run
# locally against a configured engine: maestro test flows/
maestro test --exclude-tags=needs-provider flows/
