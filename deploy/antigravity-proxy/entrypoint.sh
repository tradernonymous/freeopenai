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
set -e

if [ -n "${ACCOUNTS_FILE}" ]; then
  mkdir -p "$(dirname "${ACCOUNTS_FILE}")"
  if [ -n "${AG_ACCOUNTS_JSON}" ]; then
    printf '%s' "${AG_ACCOUNTS_JSON}" > "${ACCOUNTS_FILE}"
    echo "[entrypoint] seeded ${ACCOUNTS_FILE} from AG_ACCOUNTS_JSON ($(wc -c < "${ACCOUNTS_FILE}") bytes)"
  else
    # Not fatal: the proxy still starts and answers every request with its own
    # "Quota Exhausted ... all accounts failed", which is a recognisable symptom
    # rather than a crash loop nobody can read.
    echo "[entrypoint] AG_ACCOUNTS_JSON is empty — starting with whatever accounts ${ACCOUNTS_FILE} holds"
  fi
fi

exec bun run src/server.ts
