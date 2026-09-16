#!/bin/sh
# Runs as root (see Dockerfile). Fix /app/data's ownership -- the one thing
# the image's own entrypoint could detect but not repair -- then hand off to
# it exactly as the image ships: as the `node` user, running the same
# check-permissions.sh -> node dev/run-standalone.mjs chain it always has.
# DATA_DIR mirrors the variable the image itself reads, so a deployment that
# points its data elsewhere gets that directory chowned instead of the
# default.
set -e
DATA_PATH="${DATA_DIR:-/app/data}"
if [ -d "$DATA_PATH" ]; then
  chown -R node:node "$DATA_PATH" || true
fi
exec gosu node /app/check-permissions.sh "$@"
