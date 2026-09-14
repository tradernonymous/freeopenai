#!/bin/sh
# Start the Antigravity proxy with its accounts already in place.
#
# Why this exists: the proxy reads accounts from $ACCOUNTS_FILE at boot, and on a
# hosted platform there is no way to put a file into a container. Accounts also
# cannot be created on a deployed instance at all -- the proxy's OAuth redirect
# is hardcoded to http://localhost:3000/oauth-callback, so the sign-in only
# completes on a machine where localhost:3000 is the proxy. They are therefore
# signed in once locally, and carried here as a variable.
#
# Seeding from the variable on every boot makes the variable the source of
# truth: editing it and redeploying is all it takes to change accounts. The
# proxy's own runtime state (health scores, cooldowns) is not preserved unless a
# volume is mounted, and never was across a redeploy that replaces the container.
#
# Railway's private network (the .railway.internal names) hands the app an IPv6
# ULA address (fd12::/8), but the generated proxy binds "0.0.0.0", which is
# IPv4-only -- so the app resolves the name, connects to the IPv6 address, and
# gets ECONNREFUSED because nothing is listening there. Flipping the bind to
# "::" makes it dual-stack: it answers on both the IPv6 address Railway routes
# to and any IPv4 that still works. Only done when the source literally binds
# 0.0.0.0, so a future upstream that fixes this on its own is left alone.
set -e

if [ -f src/server.ts ] && grep -q 'hostname: "0.0.0.0"' src/server.ts; then
  sed -i 's/hostname: "0.0.0.0"/hostname: "::"/' src/server.ts
  echo "[entrypoint] proxy binds 0.0.0.0 (IPv4-only); switched to :: so Railway private networking (IPv6) can reach it"
fi

if [ -n "${ACCOUNTS_FILE}" ]; then
  mkdir -p "$(dirname "${ACCOUNTS_FILE}")"
  if [ -n "${AG_ACCOUNTS_JSON}" ]; then
    printf '%s' "${AG_ACCOUNTS_JSON}" > "${ACCOUNTS_FILE}"
    echo "[entrypoint] seeded ${ACCOUNTS_FILE} from AG_ACCOUNTS_JSON ($(wc -c < "${ACCOUNTS_FILE}") bytes)"
  elif [ -s "${ACCOUNTS_FILE}" ]; then
    echo "[entrypoint] AG_ACCOUNTS_JSON is empty — keeping the accounts already in ${ACCOUNTS_FILE}"
  else
    echo "[entrypoint] AG_ACCOUNTS_JSON is empty and ${ACCOUNTS_FILE} does not exist yet"
  fi
fi

# The proxy starts just as happily with zero accounts, and only then says
# "Quota Exhausted: All accounts failed" on every request — a symptom that reads
# like a networking fault from the app's side (it did: a healthy deploy log plus
# a 429 sent us looking at private-network DNS). Counting the refresh tokens in
# the file here, with plain grep so no runtime (node/bun) is needed, turns the
# real problem into a line that names itself in the deploy logs.
ACCOUNT_COUNT=0
if [ -n "${ACCOUNTS_FILE}" ] && [ -s "${ACCOUNTS_FILE}" ]; then
  ACCOUNT_COUNT=$(grep -o '"refreshToken"' "${ACCOUNTS_FILE}" 2>/dev/null | wc -l | tr -d '[:space:]')
fi

if [ "${ACCOUNT_COUNT}" -gt 0 ]; then
  echo "[entrypoint] ${ACCOUNT_COUNT} Google account(s) ready in ${ACCOUNTS_FILE}"
else
  echo "[entrypoint] ==============================================================="
  echo "[entrypoint] WARNING: 0 Google accounts loaded — every request will"
  echo "[entrypoint]   answer 429 \"Quota Exhausted: All accounts failed\"."
  echo "[entrypoint]   Fix: run the proxy locally (bunx antigravity-proxy@0.7.0),"
  echo "[entrypoint]   sign in at http://localhost:3000, then paste the contents"
  echo "[entrypoint]   of antigravity-accounts.json into the AG_ACCOUNTS_JSON"
  echo "[entrypoint]   variable and redeploy. See deploy/antigravity-proxy/README.md"
  echo "[entrypoint] ==============================================================="
fi

exec bun run src/server.ts
