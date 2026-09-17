#!/bin/sh
# Writes /CLIProxyAPI/config.yaml from environment variables on every boot,
# then execs the upstream binary. Railway gives no config file to mount, so
# the config must be generated -- and regenerated rather than edited in
# place, because a stale config surviving a variable change is exactly the
# drift that turns a redeploy into a mystery.
#
# Secrets travel through variables safely because each one is escaped for
# sed before it is ever embedded: a quote or ampersand in a key cannot
# break the YAML or smuggle an extra line in. The heredoc expands ordinary
# variables (the shell preserves the newlines inside API_KEYS_BLOCK), and
# the one placeholder sed handles is the management key.
set -e

CONFIG=/CLIProxyAPI/config.yaml
AUTH_DIR="${CLIPROXY_AUTH_DIR:-/CLIProxyAPI/auths}"
mkdir -p "$AUTH_DIR"

# Escape for use inside a `sed s|..|..|` replacement: backslash, ampersand
# and the delimiter itself.
esc() {
  printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'
}

# One `  - "key"` YAML line per comma-separated entry. An empty variable is
# a hard stop, not a default: a gateway with no required key would serve
# your logged-in CLI accounts to anyone who found the URL.
API_KEYS_BLOCK=""
if [ -n "${CLIPROXY_API_KEYS:-}" ]; then
  OLDIFS=$IFS
  IFS=','
  for k in $CLIPROXY_API_KEYS; do
    k=$(printf '%s' "$k" | sed 's/^ *//;s/ *$//')
    if [ -n "$k" ]; then
      API_KEYS_BLOCK="${API_KEYS_BLOCK}  - \"$(esc "$k")\"
"
    fi
  done
  IFS=$OLDIFS
fi
if [ -z "$API_KEYS_BLOCK" ]; then
  echo "[entrypoint] FATAL: CLIPROXY_API_KEYS is empty. Set at least one API key" >&2
  echo "[entrypoint] (comma-separated) -- it is the Bearer key the app sends." >&2
  exit 1
fi

# Remote management is what makes headless account login possible at all:
# the bundled control panel is where the OAuth flows run from a browser.
# Enabled only when a secret key exists -- an open management API would
# hand the whole gateway to the internet.
if [ -n "${CLIPROXY_SECRET_KEY:-}" ]; then
  MGMT_ALLOW="true"
else
  MGMT_ALLOW="false"
fi

cat > "$CONFIG" <<EOF
host: ""
port: ${PORT:-8317}
auth-dir: "${AUTH_DIR}"
remote-management:
  allow-remote: ${MGMT_ALLOW}
  secret-key: "__MGMT_KEY__"
api-keys:
${API_KEYS_BLOCK}
debug: ${CLIPROXY_DEBUG:-false}
EOF

sed -i "s|__MGMT_KEY__|$(esc "${CLIPROXY_SECRET_KEY:-}")|" "$CONFIG"

# A config without api-keys must not start serving.
grep -q '  - "' "$CONFIG" || {
  echo "[entrypoint] FATAL: config.yaml missing api-keys after generation" >&2
  exit 1
}

echo "[entrypoint] port=${PORT:-8317} auth-dir=${AUTH_DIR} management=$([ -n "${CLIPROXY_SECRET_KEY:-}" ] && echo enabled || echo disabled)"
cd /CLIProxyAPI
exec ./CLIProxyAPI
