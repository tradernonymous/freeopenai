# Kiro Gateway on Railway (slot 2): free-tier Claude Sonnet 4.5, Claude Haiku
# 4.5, DeepSeek-V3.2, GLM-5, MiniMax M2.x and Qwen3-Coder behind one
# OpenAI-compatible /v1 endpoint -- the strongest free coding models available
# anywhere right now, drawn from the Kiro IDE's free tier.
#
# The upstream repo is the deployable unit: it ships its own production-grade
# Dockerfile, but that file lives in *their* repository, and Railway builds
# from *this* one. Cloning at build time is the same move as a pip install --
# it brings their code and requirements in exactly as they published them,
# rather than a partial copy that drifts. No published container image exists
# to wrap, so there is nothing better to base this on.
#
# Source: https://github.com/jwadow/kiro-gateway (AGPL-3.0).
FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# A pinned clone would rot; --depth 1 of their main tracks their fixes, and
# the gateway's own token-refresh logic is what keeps a long-running container
# authenticated -- the build only has to be current at the moment it runs.
RUN git clone --depth 1 https://github.com/jwadow/kiro-gateway /app
WORKDIR /app
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd -r kiro && chown -R kiro:kiro /app
USER kiro

# The gateway reads its port from --port (or SERVER_PORT); Railway routes to
# the port it injects as PORT, so the two are joined here. 8000 is the
# upstream default for local runs.
ENV SERVER_PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "exec python main.py --port ${PORT:-8000}"]
