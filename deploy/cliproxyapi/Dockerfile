# CLIProxyAPI (router-for-me), pinned to one upstream commit, plus the only
# things needed to run it as a Railway private service: Google accounts seeded
# from a variable, a dual-stack bind, and the API key from the environment.
#
# Pinned to the spike-verified commit rather than tracking main: the model
# catalogue and account handling drift between releases and our provider pins
# the list it answers to -- a silent upstream change would look like a bug in
# this app. The spike (live probes, burner accounts, 2026-09-14) ran against
# exactly this commit.
FROM golang:1.26-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends build-essential git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone https://github.com/router-for-me/CLIProxyAPI.git . \
 && git checkout 7fa443dc8bf8ca2f1ffd81c2472deb31b097b697 \
 && git rev-parse HEAD \
 && go mod download

RUN CGO_ENABLED=1 GOOS=linux go build -buildvcs=false -o /out/cliproxy-api ./cmd/server/

FROM debian:bookworm

RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates python3 && rm -rf /var/lib/apt/lists/* \
 && python3 --version

# The entrypoint writes config.yaml and the account files here every boot, so
# the Railway variables stay the source of truth even with no volume mounted.
RUN mkdir -p /app/data/auth

COPY --from=builder /out/cliproxy-api /usr/local/bin/cliproxy-api
COPY entrypoint.sh /usr/local/bin/cliproxy-entrypoint
RUN chmod +x /usr/local/bin/cliproxy-entrypoint

WORKDIR /app

EXPOSE 8317

ENTRYPOINT ["/usr/local/bin/cliproxy-entrypoint"]
