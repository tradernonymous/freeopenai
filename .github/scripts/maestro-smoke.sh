#!/usr/bin/env bash
set -euo pipefail

adb install -r "$GITHUB_WORKSPACE/android/app/build/outputs/apk/debug/app-debug.apk"
cd "$GITHUB_WORKSPACE/.maestro"
maestro test flows/
