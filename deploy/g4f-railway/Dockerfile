# gpt4free as a Railway service: free image generation, plus one more
# independent pool of free chat models.
#
# This wraps the project's own published image rather than building from source,
# because the source needs Chrome, system libs and a browser toolchain for the
# provider adapters that scrape sites -- the slim image is the project's own
# answer to exactly that, and rebuilding it here would be a worse copy of a
# problem it already solved.
#
# Why this exists at all: it is the only deployable *free* image generator this
# app can point at. Every other drawer needs a key (Cloudflare, Nvidia), has no
# free tier (OpenRouter's Image API), or both. OVHcloud's free endpoint is the
# one exception, and its 2-requests-a-minute-per-IP limit is tight enough that a
# second free option is worth a service.
#
# The honest warning, stated where whoever operates this will see it: gpt4free
# reaches models by reading third-party web endpoints, not through documented
# APIs. Individual adapters break without notice when a site changes, and the
# upstream project ships fixes continuously. That is why the app puts this
# service LAST in its draw order -- a rescue rather than a first choice.
FROM hlohaus789/g4f:latest-slim

# Persistent state. Both matter: har_and_cookies holds the session material the
# browser-backed adapters need, and generated_media holds produced images. The
# image expects them under /app.
RUN mkdir -p /app/har_and_cookies /app/generated_media

# The Interference API -- the OpenAI-compatible surface this app talks to:
#   POST /v1/chat/completions
#   POST /v1/images/generations
#   GET  /v1/models
# It is served on 8080 inside the container. The project's own docs show it
# published to host port 1337 in their example, which is a host mapping and not
# a different port: 1337:8080. The container port is 8080, and that is what
# Railway's target port must be set to.
ENV PORT=8080
EXPOSE 8080

# Stated explicitly rather than inherited. The base image's default command is
# not part of this app's contract, and a future tag that changes it would
# otherwise turn a working deploy into a container that starts and serves
# nothing -- the same failure the OmniRoute wrapper was written to avoid.
CMD ["python", "-m", "g4f", "--port", "8080"]
