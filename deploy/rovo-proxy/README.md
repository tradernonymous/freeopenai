# rovo-proxy — Claude Sonnet 4 through Rovo Dev

Atlassian's Rovo Dev gives an account **5 million tokens a day** of Claude Sonnet 4
on the free tier (20 million with a paid Jira plan), with no card. It is the one
thing in this app that a free API key cannot otherwise buy: Qwen3-Coder-480B is
free nowhere reachable since Cerebras ended its no-card tier in August 2026, and
OpenRouter has never listed a `:free` variant of it.

Rovo Dev is a terminal agent, not an API. The way in is `acli rovodev serve`, an
officially documented server mode, with a shim in front translating OpenAI's
shape to Rovo's `/v3`. This image runs both, plus the gate that keeps the result
from being an open door.

```
                     ┌─ gate.js            :4000  ← the only published port
container ───────────┼─ rovodev-proxy (Bun):4100  ← OpenAI /v1  → Rovo /v3
                     └─ acli rovodev serve :8123  ← Atlassian's server mode
```

## The two secrets are not the same secret

| Variable | Authenticates | Where it comes from |
| --- | --- | --- |
| `ROVO_API_TOKEN` | **this container → Atlassian** | id.atlassian.com → Security → API tokens |
| `ROVO_API_KEY` | **callers → this container** | invent one: `openssl rand -base64 32` |

The shim deliberately strips `Authorization`, because Rovo is authenticated by
the container's own `acli` session rather than by a bearer token. That is fine
while only localhost can reach it and dangerous the moment it is tunnelled: the
URL becomes the only secret, and tunnel URLs end up in logs, shell history and
screenshots. Anyone who finds one spends someone else's 5M tokens a day.

So `gate.js` requires `ROVO_API_KEY` and **refuses to start without it**. Set
`ROVO_ALLOW_NO_KEY=1` only if you are certain nothing outside the machine can
reach the port. The entrypoint also refuses to start if the two values are equal,
since a token used as the gate key would be handed to every caller.

## Variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `ROVO_EMAIL` | yes | — | the Atlassian account e-mail |
| `ROVO_API_TOKEN` | yes | — | Atlassian API token; never leaves the container |
| `ROVO_API_KEY` | yes | — | what callers must send as `Authorization: Bearer …` |
| `ROVO_ALLOW_NO_KEY` | no | unset | `1` runs the gate open — local use only |
| `PORT` | no | `4000` | the gate's port, the only one exposed |
| `ROVO_SHIM_PORT` | no | `4100` | loopback only |
| `ROVO_SERVE_PORT` | no | `8123` | loopback only |
| `ROVO_WORKSPACE` | no | `/workspace` | Rovo expects to stand in a git repo; an empty one is created |

## Running it

From the repo root, where `docker-compose.yml` has a `rovo` profile:

```bash
cp .env.example .env      # fill in ROVO_EMAIL, ROVO_API_TOKEN, ROVO_API_KEY
docker compose --profile rovo up -d --build
docker compose logs -f rovo
```

Check it locally before exposing it:

```bash
curl -s localhost:4000/gate/health
curl -s localhost:4000/v1/models -H "Authorization: Bearer $ROVO_API_KEY"
curl -s localhost:4000/v1/models                      # expect 401
```

The profile also starts a cloudflared quick tunnel. Read the public URL from its
log and point the app at it:

```bash
docker compose logs cloudflared-rovo | grep trycloudflare
# then on Railway:  ROVO_BASE_URL=https://<that>.trycloudflare.com
#                   ROVO_API_KEY=<the same key>
```

**The quick-tunnel URL changes every time that container is recreated** — a
reboot, or `--force-recreate`. When the app starts failing with `ENOTFOUND`, read
the new URL and update `ROVO_BASE_URL`. A named tunnel (`TUNNEL_TOKEN`) gives a
permanent URL if that becomes tiresome.

## What this cannot do

- **One request at a time.** The shim serialises: the backend behaves as a single
  active session. Ordinary chat is fine; a tool turn that fires several calls in
  one wave will queue them, and a queued request can hit the app's 55-second
  provider timeout.
- **Text only.** No vision, no image generation. Attaching a picture on this
  provider will not work — non-text parts are not forwarded.
- **It is one person's shim, pinned.** Nine commits, last touched 2026-06-01.
  `ROVO_SHIM_REF` in the Dockerfile pins it; expect it to need bumping when
  `acli` changes, and read the diff when you bump it.
- **The allowance is metered to the Atlassian account.** Nothing here bypasses
  anything — `serve` is Atlassian's own command and the token is yours — but
  powering a chat app is heavier use than terminal coding, and it is that account
  that carries the consequence.
