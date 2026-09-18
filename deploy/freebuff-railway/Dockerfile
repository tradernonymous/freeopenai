# Freebuff2API as a Railway service: free coding models behind an
# OpenAI-compatible endpoint this app can point at.
#
# This wraps the project's own published image rather than building from
# source. It is a static Go binary on alpine, so there is no toolchain to
# slim and nothing to gain from recompiling it here.
#
# Two things the image does not do for Railway, so this wrapper does:
#
#   1. Fail fast with no tokens. With AUTH_TOKENS unset the proxy still boots
#      and answers every model as 502 "no healthy upstream auth token
#      available" -- a container that looks alive while it can never work.
#      Refusing to start names the missing variable in the deploy log instead.
#   2. Pin the listen address. Railway injects its own PORT for its router,
#      but this binary reads LISTEN_ADDR, not PORT -- so a platform value can
#      never silently move the port out from under the target port below.
#      PORT is still honoured when LISTEN_ADDR is unset, so a deployment that
#      sets PORT keeps working.
FROM ghcr.io/quorinex/freebuff2api:latest

COPY entrypoint.sh /usr/local/bin/fb-entrypoint.sh
RUN chmod +x /usr/local/bin/fb-entrypoint.sh

# The OpenAI-compatible surface this app talks to:
#   GET  /v1/models
#   POST /v1/chat/completions
# Served on 8080 inside the container, which is what Railway's target port
# must be set to.
ENV LISTEN_ADDR=:8080
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/fb-entrypoint.sh"]
