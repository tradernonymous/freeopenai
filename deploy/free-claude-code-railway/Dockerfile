# Free Claude Code (FCC) as a Railway service.
#
# READ THE README BESIDE THIS FILE FIRST. This image does not, on its own, give
# freeopenai any models. FCC serves an Anthropic Messages API (/v1/messages) and
# an OpenAI *Responses* API (/v1/responses) -- and freeopenai's provider layer
# talks OpenAI *Chat Completions* (/v1/chat/completions), which FCC does not
# serve. Verified against the route table in its own source, 2026-09-18.
#
# So this is a service for your coding CLIs (Claude Code, Codex, OpenCode) and
# not yet a provider for the chat picker. The README sets out the two ways to
# bridge it and how to check which one you need.
#
# It is also deliberately NOT a verified build. The steps below follow the
# project's documented install (uv, then its own console script), but no one has
# run this Dockerfile end to end, and it is labelled that way on purpose: a
# Dockerfile that looks tested and is not is worse than one that says so.
FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The project installs and runs through uv.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Pinned to a tag or commit rather than `main`: this project moves quickly, and
# an unpinned clone means a redeploy can change behaviour with no version
# recorded anywhere. Bump FCC_REF deliberately.
ARG FCC_REF=main
RUN git clone --depth 1 --branch "${FCC_REF}" https://github.com/Alishahryar1/free-claude-code.git . \
  && uv sync --frozen || uv sync

# 0.0.0.0 on purpose: the project's own security note says to keep HOST=127.0.0.1
# for local use, which is right for a laptop and useless in a container, where
# binding to loopback means nothing outside the container can reach it. That
# note is why this service must not be given a public domain without FCC's
# bearer-token auth switched on first -- see the README.
ENV HOST=0.0.0.0
ENV PORT=8082
EXPOSE 8082

CMD ["/root/.local/bin/uv", "run", "fcc-server"]
