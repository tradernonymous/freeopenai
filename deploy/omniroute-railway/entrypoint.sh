#!/bin/sh
# Runs as root (see Dockerfile). Fix /app/data's ownership -- the one thing
# the image's own entrypoint could detect but not repair -- then hand off to
# it exactly as the image ships: as the `node` user, running the same
# check-permissions.sh -> node dev/run-standalone.mjs chain it always has.
# DATA_DIR mirrors the variable the image itself reads, so a deployment that
# points its data elsewhere gets that directory chowned instead of the
# default.
#
# Three things happen here that are not about permissions, and each one is an
# outage this file was written to prevent:
#
#   1. The port is pinned. A container host injects its own PORT for its router,
#      and that value wins over the image's ENV -- so a gateway reached at
#      `omniroute.railway.internal:20128` can end up listening on 8080 instead,
#      which the host's own router answers as "application failed to respond"
#      rather than as a connection error. Setting it here, after the platform
#      has had its say, is what makes 20128 true. OMNIROUTE_PORT overrides.
#   2. The command is logged before it runs. A container that dies at exec leaves
#      nothing behind but a restart, and the log line is the only record of what
#      it tried to run and on which port.
#   3. The command is second-guessed only when its file is missing. A base image
#      is free to move its entry file between majors; when it does, the image's
#      own CMD points at a path that no longer exists and the process exits
#      before it can say so. Falling back to the entry points this project ships
#      turns that into a gateway that starts and says which one it used.
set -e

if [ -n "${OMNIROUTE_PORT}" ]; then
  export PORT="${OMNIROUTE_PORT}"
else
  export PORT=20128
fi

DATA_PATH="${DATA_DIR:-/app/data}"
if [ -d "$DATA_PATH" ]; then
  chown -R node:node "$DATA_PATH" || true
fi

echo "[entrypoint] data=${DATA_PATH} port=${PORT} command=${*:-<image default>}"

if [ "$#" -ge 2 ] && [ "$1" = "node" ] && [ ! -f "$2" ] && [ ! -f "/app/$2" ]; then
  if [ -f /app/scripts/dev/run-next.mjs ]; then
    echo "[entrypoint] $2 is not in this image; using scripts/dev/run-next.mjs start instead"
    set -- node scripts/dev/run-next.mjs start
  elif [ -f /app/bin/omniroute.mjs ]; then
    echo "[entrypoint] $2 is not in this image; using bin/omniroute.mjs instead"
    set -- node bin/omniroute.mjs
  else
    echo "[entrypoint] warning: $2 is not in this image and no known entry point is either"
  fi
fi

exec gosu node /app/check-permissions.sh "$@"
