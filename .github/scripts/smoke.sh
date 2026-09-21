#!/usr/bin/env bash
set -euo pipefail

APK="${1:-$RUNNER_TEMP/neuraos.apk}"

adb install -r "$APK"
adb logcat -c
adb shell am start -W -n com.neura.os/.app.NativeActivity
sleep 10

PID="$(adb shell pidof com.neura.os)"
echo "app pid: $PID"
if [ -z "$PID" ]; then
  echo '::error::The activity is not running after am start.'
  exit 1
fi

adb logcat -d '*:E' | tee "$RUNNER_TEMP/error.log"
if grep -q 'FATAL EXCEPTION' "$RUNNER_TEMP/error.log"; then
  echo '::error::The app crashed at launch - see the FATAL EXCEPTION stack above.'
  exit 1
fi

echo "ok: com.neura.os launched and stayed alive with no FATAL EXCEPTION"