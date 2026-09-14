#!/bin/sh
# Start CLIProxyAPI with its config and Google accounts already in place.
#
# Why this exists: the proxy reads its config file (-config) and one credential
# file per Google account (antigravity-<email>.json in its auth dir) at boot,
# and on a hosted platform there is no way to put files into a container.
# Accounts also cannot be created on a deployed instance at all -- the OAuth
# redirect is a localhost loopback, so the sign-in only completes on a machine
# where the proxy itself runs. They are therefore signed in once locally (or
# reused from the old proxy's seed file: same Google OAuth client, so the same
# refresh tokens work), and carried here as variables.
#
# Seeding from variables on every boot makes the variables the source of
# truth: editing them and redeploying is all it takes to change accounts. The
# proxy's own runtime state (quota caches, cooldowns) is not preserved unless a
# volume is mounted, and never was across a redeploy that replaces the
# container. Seeded accounts carry an empty access token with an expired stamp,
# which is the honest "needs refresh" state: the proxy refreshes from the
# refresh token on boot and writes the fresh access token back itself (proven
# in the spike: blanked tokens healed to full models + 200s with no clicks).
#
# Railway's private network (the .railway.internal names) hands the app an IPv6
# ULA address (fd12::/8). Go listens dual-stack on an empty host, which covers
# both that and IPv4, so the default here is deliberately empty. Do NOT set a
# bare "::": this proxy concatenates host and port itself ("::" + 8317 becomes
# the invalid ":::8317" and the server never starts -- found by the local
# Docker boot test). CPA_HOST overrides when a future deployment needs a
# concrete address.
set -e

CONFIG_FILE="${CPA_CONFIG_FILE:-/app/data/config.yaml}"
AUTH_DIR="${CPA_AUTH_DIR:-/app/data/auth}"

mkdir -p "$(dirname "${CONFIG_FILE}")" "${AUTH_DIR}"

# The seed and the config both come from the environment, and Google's tokens
# are punctuation-heavy (quotes, spaces, slashes survive only if nothing
# re-quotes them), so python reads os.environ itself: the shell never touches
# the values. The heredoc delimiter is quoted for the same reason.
python3 - <<'PYEOF'
import json
import os

auth_dir = os.environ.get("CPA_AUTH_DIR", "/app/data/auth")
config_file = os.environ.get("CPA_CONFIG_FILE", "/app/data/config.yaml")
port = int(os.environ.get("PORT", "8317") or 8317)
host = os.environ.get("CPA_HOST", "")
api_keys = [k.strip() for k in os.environ.get("CPA_API_KEYS", "").split(",") if k.strip()]

with open(config_file, "w", encoding="utf-8") as f:
    f.write('host: "%s"\n' % host)
    f.write("port: %d\n" % port)
    f.write('auth-dir: "%s"\n' % auth_dir)
    f.write("api-keys:\n")
    for k in api_keys:
        f.write('  - "%s"\n' % k.replace('"', ""))

raw = os.environ.get("CPA_ACCOUNTS_JSON", "")
if raw.strip():
    seed = json.loads(raw)
    accounts = seed.get("accounts", seed) if isinstance(seed, dict) else seed
    count = 0
    for a in accounts:
        email = (a.get("email") or "").strip()
        refresh = a.get("refreshToken", a.get("refresh_token", "")) or ""
        if not email or not refresh:
            continue
        flat = {
            "type": "antigravity",
            "email": email,
            "access_token": a.get("accessToken", a.get("access_token", "")) or "",
            "refresh_token": refresh,
            "expires_in": 3600,
            "timestamp": 0,
            "expired": "1970-01-01T00:00:00Z",
            "project_id": a.get("projectId", a.get("project_id", "")) or "",
        }
        with open(os.path.join(auth_dir, "antigravity-" + email + ".json"), "w", encoding="utf-8") as f:
            json.dump(flat, f)
        count += 1
    print("[entrypoint] seeded %d Google account(s) into %s" % (count, auth_dir))
else:
    print("[entrypoint] CPA_ACCOUNTS_JSON is empty — keeping the accounts already in %s" % auth_dir)
PYEOF

# The proxy starts just as happily with zero accounts, and only then answers
# every request as an unroutable model -- a symptom that reads like a
# networking fault from the app's side. Counting the refresh tokens in the
# auth dir here, with plain grep so no runtime is needed, turns the real
# problem into a line that names itself in the deploy logs.
ACCOUNT_COUNT=0
if [ -d "${AUTH_DIR}" ]; then
  ACCOUNT_COUNT=$(grep -l '"refresh_token"' "${AUTH_DIR}"/antigravity-*.json 2>/dev/null | wc -l | tr -d '[:space:]')
fi

if [ "${ACCOUNT_COUNT}" -gt 0 ]; then
  echo "[entrypoint] ${ACCOUNT_COUNT} Google account(s) ready in ${AUTH_DIR}"
else
  echo "[entrypoint] ==============================================================="
  echo "[entrypoint] WARNING: 0 Google accounts loaded — every Antigravity model"
  echo "[entrypoint]   will answer \"unknown provider for model\"."
  echo "[entrypoint]   Fix: paste the seed array into the CPA_ACCOUNTS_JSON"
  echo "[entrypoint]   variable and redeploy. See deploy/cliproxyapi/README.md"
  echo "[entrypoint] ==============================================================="
fi

exec cliproxy-api -config "${CONFIG_FILE}"
