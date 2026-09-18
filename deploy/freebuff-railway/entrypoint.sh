#!/bin/sh
# Freebuff2API on Railway: refuse to boot with no upstream tokens, pin the
# listen address, then hand off to the image's own binary.
#
# AUTH_TOKENS is the whole point of this service -- Freebuff auth tokens from
# https://freebuff.llm.pm (or the Freebuff CLI credentials file), comma
# separated. Without one the proxy boots and 502s every request, which reads
# as a broken deploy rather than a missing variable. The log line below is
# the only place that fact appears, so it names the variable outright.
#
# LISTEN_ADDR wins when set; otherwise PORT is honoured so a deployment that
# sets PORT keeps working; otherwise :8080, matching the Dockerfile and the
# target port in the README.
set -e

if [ -z "${AUTH_TOKENS}" ]; then
  echo "[entrypoint] AUTH_TOKENS is not set -- add your Freebuff auth tokens (comma separated) and redeploy"
  exit 1
fi

if [ -z "${LISTEN_ADDR}" ]; then
  if [ -n "${PORT}" ]; then
    export LISTEN_ADDR=":${PORT}"
  else
    export LISTEN_ADDR=":8080"
  fi
fi

echo "[entrypoint] listen=${LISTEN_ADDR} rotation=${ROTATION_INTERVAL:-6h}"

exec /usr/local/bin/Freebuff2API "$@"
