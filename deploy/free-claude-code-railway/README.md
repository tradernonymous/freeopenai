# Free Claude Code on Railway — read this before spending a slot

[Free Claude Code](https://github.com/Alishahryar1/free-claude-code) (FCC) is the
most interesting of the projects this app was researched against: one process
fronting **53 free providers** with real fallback chains, provider health
backoff and per-tier routing. It is the closest thing to "never get interrupted"
that exists as a single deployable service.

**It also cannot feed freeopenai's chat picker today.** This is the one thing to
know before you deploy it, and it was verified against the route table in FCC's
own source rather than assumed:

| FCC serves | freeopenai's provider layer calls |
| --- | --- |
| `/v1/messages` (Anthropic) | |
| `/v1/messages/count_tokens` | |
| `/v1/responses` (OpenAI **Responses**) | |
| `/v1/models`, `/health`, `/stop` | `/v1/chat/completions` (OpenAI **Chat Completions**) |

There is no `/v1/chat/completions` route. Setting `CUSTOM_BASE_URL` at this
service would give you a provider that lists models and fails on every message.

## So what is it good for?

**Your coding CLIs, which is what it was built for.** Point Claude Code, Codex,
OpenCode or Cline at it and they get free models with fallback across 53
providers. That is a real win and it needs no bridge:

```
ANTHROPIC_BASE_URL=http://<your-fcc-domain>   ANTHROPIC_AUTH_TOKEN=<token>   claude
```

**And it becomes a chat provider with one extra hop.** Two ways, in order of how
much work they are:

1. **LiteLLM in front of it.** LiteLLM is a maintained OpenAI-compatible proxy
   that can call an Anthropic-shaped upstream and re-serve it as Chat
   Completions. Run it in the same service container or as a second service, set
   `CUSTOM_BASE_URL` at LiteLLM, and freeopenai gets FCC's 53 providers through
   its existing Custom endpoint slot. No change to freeopenai.
2. **Teach freeopenai the Responses API.** The provider layer already supports a
   second chat shape (`chatShape: 'text-query'`, used by FreeGPT4), so a
   `chatShape: 'responses'` is a natural addition — and it would unlock not just
   FCC but any Responses-shaped gateway, including
   [my-free-code](https://github.com/hkqr/my-free-code), which has the same gap
   for the same reason. That is a real piece of work, not a one-liner: streaming
   event translation, tool calls and reasoning blocks all differ between the two
   shapes.

## What you get either way

- 53 providers behind one endpoint, with **ordered fallback** when one is rate
  limited or down — the property freeopenai's own failover has, applied inside a
  single service.
- Per-tier routing: send Opus/Sonnet/Haiku requests to different models.
- Provider coverage freeopenai has no direct integration for.

## What it costs you

- **It is built for a laptop.** FCC's own security notes say to keep
  `HOST=127.0.0.1`, never expose the Admin endpoints, and set a non-trivial
  `PROXY_AUTH_TOKEN`. A container has to bind `0.0.0.0` to be reachable at all,
  so **turn its proxy authentication on before it gets a public domain.**
- **Some of its providers need OAuth device flows** (ChatGPT, GitHub Copilot)
  that are awkward to complete on a headless container. The keyed providers work
  fine; treat the OAuth ones as local-only.
- **The Dockerfile here is unverified.** It follows the project's documented
  install, but nobody has run it end to end. Check it before you trust it.
- **Overlap with OmniRoute.** You already run a gateway that fronts far more
  providers with quota-aware fallback. FCC is a second one. Worth it only if you
  want the Anthropic-side surface or FCC's provider set specifically.

## If you deploy it anyway

1. **New → GitHub Repo** → this repo, **Root Directory** `deploy/free-claude-code-railway`.
2. Rename the service to `free-claude-code`.
3. **Volume** at `/app/data` (FCC keeps its config and connected accounts under
   `~/.fcc`; point `HOME` at the mount if you want it to persist).
4. **Variables:** the provider keys you want it to hold — `NVIDIA_NIM_API_KEY`,
   `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `KILO_API_KEY`, and the rest of its
   catalogue. Plus `PROXY_AUTH_TOKEN=<a long random value>`.
5. **Networking → Generate Domain**, target port `8082`.
6. **Verify before wiring anything:**
   ```bash
   curl -s https://<your-fcc-domain>/health
   curl -s https://<your-fcc-domain>/v1/models | head -c 300
   # the one that decides whether freeopenai can use it:
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-fcc-domain>/v1/chat/completions \
     -H 'Content-Type: application/json' -d '{"model":"x","messages":[]}'
   ```
   A `404` means the bridge is needed, exactly as described above. A `200` or
   `400` means a route exists and the note in this README is out of date —
   re-check and then set `CUSTOM_BASE_URL`.

## The recommendation

If the goal is free models **in freeopenai's picker**, do not spend a slot here.
The keyless Kilo and OVHcloud providers need no service and no key at all, and
`deploy/g4f-railway/` covers free image generation. Spend this slot on FCC only
if you want free models in your **coding CLIs** — which is what it is genuinely
good at — or if you intend to build the Responses-API support it would need.
