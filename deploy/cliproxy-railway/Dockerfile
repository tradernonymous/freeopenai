# CLIProxyAPI on Railway: one OpenAI-compatible gateway in front of your own
# free agent-CLI logins -- Gemini CLI, Claude Code, OpenAI Codex, Grok. Every
# model those CLIs give you for free (Gemini 3.1 Pro, GPT-5.6 series, Claude,
# Grok 4.5) becomes an ordinary /v1/chat/completions endpoint, which is the
# shape this app's Custom endpoint slot already speaks.
#
# This wraps the project's own published image rather than building Go from
# source, for the same reason the g4f wrapper does: the upstream build is the
# project's own answer, and a rebuild here would be a worse copy of it.
#
# The one thing the base image cannot know is your configuration. Its compose
# file mounts a config.yaml you edit by hand; Railway has no such file to
# mount, so the entrypoint below writes one from environment variables on
# every boot. Accounts live in the auth directory, which Railway should point
# at a volume so OAuth tokens survive a redeploy.
FROM eceasy/cli-proxy-api:latest

# OAuth tokens land here. Mount a Railway volume on this path: without one,
# every redeploy logs you out of every CLI account and the gateway serves an
# empty model list until you log in again.
RUN mkdir -p /CLIProxyAPI/auths

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Railway injects PORT; the entrypoint feeds it to the config so the gateway
# always listens on the port the platform routes to. 8317 is the upstream
# default for local runs.
ENV PORT=8317
EXPOSE 8317

ENTRYPOINT ["/entrypoint.sh"]
