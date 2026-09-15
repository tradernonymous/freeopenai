#!/usr/bin/env bash
# Bring up the three processes in the order they depend on each other, and fail
# loudly at the first one that does not come up. A container that starts
# "successfully" with a dead Rovo session produces a provider that 502s on every
# message, which is a much slower way to learn the same thing.
set -euo pipefail

PORT="${PORT:-4000}"
SHIM_PORT="${ROVO_SHIM_PORT:-4100}"
SERVE_PORT="${ROVO_SERVE_PORT:-8123}"
WORKSPACE="${ROVO_WORKSPACE:-/workspace}"

die() { echo "rovo-proxy: $*" >&2; exit 1; }

[ -n "${ROVO_EMAIL:-}" ] || die "ROVO_EMAIL is not set (the Atlassian account e-mail)."
[ -n "${ROVO_API_TOKEN:-}" ] || die "ROVO_API_TOKEN is not set (an Atlassian API token from id.atlassian.com)."

# ROVO_API_TOKEN authenticates the container to Atlassian.
# ROVO_API_KEY authenticates callers to the container. Two different secrets,
# and mixing them up is the mistake worth catching here: a token used as the
# gate key would be handed to every client.
if [ -n "${ROVO_API_KEY:-}" ] && [ "${ROVO_API_KEY}" = "${ROVO_API_TOKEN}" ]; then
  die "ROVO_API_KEY must not be the same value as ROVO_API_TOKEN — the first is
  handed to callers, the second is your Atlassian credential."
fi

# Wait for a port to accept, rather than sleeping a guessed number of seconds.
wait_for() {
  local name="$1" port="$2" tries="${3:-60}"
  for _ in $(seq 1 "${tries}"); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      exec 3>&- 2>/dev/null || true
      echo "rovo-proxy: ${name} is up on ${port}"
      return 0
    fi
    sleep 1
  done
  die "${name} did not come up on port ${port} within ${tries}s."
}

cd "${WORKSPACE}"

# --token reads from stdin; printf rather than echo so no newline is appended to
# the credential.
echo "rovo-proxy: signing in as ${ROVO_EMAIL}"
printf '%s' "${ROVO_API_TOKEN}" | acli rovodev auth login --email "${ROVO_EMAIL}" --token \
  || die "acli rovodev auth login failed — check ROVO_EMAIL and ROVO_API_TOKEN."

# --disable-session-token: the shim opens a fresh connection per request and has
# no session token to present, so serve mode must not ask for one.
echo "rovo-proxy: starting acli rovodev serve on ${SERVE_PORT}"
acli rovodev serve "${SERVE_PORT}" --disable-session-token &
SERVE_PID=$!
wait_for "rovodev serve" "${SERVE_PORT}"

echo "rovo-proxy: starting the OpenAI shim on ${SHIM_PORT}"
cd /app/shim
bun rovodev-proxy.ts --proxy-port "${SHIM_PORT}" --rovodev-port "${SERVE_PORT}" &
SHIM_PID=$!
wait_for "openai shim" "${SHIM_PORT}"

# If either background process dies the container should die with it, rather
# than sit there serving 502s from a gate whose upstream is gone.
watch_children() {
  while true; do
    kill -0 "${SERVE_PID}" 2>/dev/null || { echo "rovo-proxy: rovodev serve exited" >&2; kill -TERM 1; }
    kill -0 "${SHIM_PID}" 2>/dev/null || { echo "rovo-proxy: openai shim exited" >&2; kill -TERM 1; }
    sleep 5
  done
}
watch_children &

cd /app
echo "rovo-proxy: starting the gate on ${PORT}"
exec node /app/gate.js
