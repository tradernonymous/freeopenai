# Wraps diegosouzapw/omniroute so it can hold state on a Railway Volume.
#
# The image's own entrypoint (/app/check-permissions.sh) only *detects* an
# unwritable data directory and prints a chown command for the operator to run
# on the Docker host -- correct advice for a bind mount you control on your
# own machine, and useless on Railway, where a Volume is a bind mount to a
# host path Railway itself creates and owns as root. The image runs as `node`
# (uid 1000) and ships no gosu/su-exec, so that user has no way to chown a
# directory it does not own, and the app is left writing its database through
# an in-memory fallback that never reaches disk -- every setting and every
# connected provider is gone on the next restart.
#
# The fix is the standard shape for exactly this: start the container as
# root -- the only user who can chown a directory it does not own -- fix the
# one directory that matters, then re-exec the image's own entrypoint as the
# `node` user it was built to run as. Nothing about OmniRoute's own startup
# changes; only who owns /app/data before it runs.
FROM diegosouzapw/omniroute:latest
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# Setting a new ENTRYPOINT resets CMD to empty on its own -- Docker's own
# behaviour, not something either script here controls -- so the base image's
# CMD has to be restated here or the container starts with no command to run
# at all and exits 0 having done nothing, which is exactly what happened
# before this line was added.
CMD ["node", "dev/run-standalone.mjs"]
