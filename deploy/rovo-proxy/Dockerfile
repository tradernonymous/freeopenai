# Rovo Dev as an OpenAI-compatible endpoint.
#
# Three processes, one container:
#
#   acli rovodev serve 8123   Atlassian's own server mode for the Rovo Dev agent
#   rovodev-proxy (Bun) 4100  translates OpenAI /v1/* to Rovo's /v3/*
#   gate.js             4000  the only port exposed; requires ROVO_API_KEY
#
# Only the gate is published. The other two speak on loopback inside the
# container, which is what lets the shim keep its "auth comes from the local
# acli session" design without that becoming an open door once this is
# tunnelled. See gate.js for why that is not optional.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL=/usr/local \
    PATH=/usr/local/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg unzip procps \
 && rm -rf /var/lib/apt/lists/*

# Node 20+: the shim's package.json asks for it, and gate.js runs on it.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Bun: the shim is TypeScript executed directly, not built.
RUN curl -fsSL https://bun.sh/install | bash

# The Atlassian CLI, which is what actually holds the Rovo session.
RUN curl -fsSL https://acli.atlassian.com/install.sh | bash \
 && acli --version

# Pinned, like deploy/cliproxyapi does for CLIProxyAPI. This shim is a handful
# of commits by one author; an unpinned clone means a silent change to the thing
# standing between the app and an account's allowance.
ARG ROVO_SHIM_REF=9cf4e94cf475056aeb0980dd63dfa00c39fb3568
WORKDIR /app/shim
RUN git clone https://github.com/lutfi238/opencode-rovodev-auth.git . \
 && git checkout "${ROVO_SHIM_REF}" \
 && git rev-parse HEAD \
 && (npm ci --omit=dev || npm install --omit=dev)

COPY gate.js /app/gate.js
COPY entrypoint.sh /usr/local/bin/rovo-entrypoint
RUN chmod +x /usr/local/bin/rovo-entrypoint

# Rovo Dev is a coding agent and expects to be standing in a repository. It is
# given an empty one rather than none: `serve` reads the working tree at start.
RUN mkdir -p /workspace && cd /workspace && git init -q \
 && git config user.email rovo@localhost && git config user.name rovo

ENV PORT=4000 \
    ROVO_SHIM_PORT=4100 \
    ROVO_SERVE_PORT=8123 \
    ROVO_WORKSPACE=/workspace

EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/rovo-entrypoint"]
