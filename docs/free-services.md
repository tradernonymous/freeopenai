# Free models with no key, and free image generation

[← Back to README](../README.md)

This page is the operator's guide to the free model sources this app can reach,
including the two that need **no key, no signup and no card at all**. If you are
setting this up for the first time, the short version is: **you may not have to
do anything.**

## The short version

| Source | What it gives you | What you must do |
| --- | --- | --- |
| **Kilo Code** | Agentic coding models — Poolside Laguna S 2.1, North Mini Code, Nemotron 3 Ultra 550B (1M context) | **Nothing.** On in every deployment. |
| **OVHcloud AI Endpoints** | Qwen3-Coder 30B, gpt-oss 120B/20B, Qwen3.5 397B, Llama 3.3 70B | **Nothing.** On in every deployment. |
| **Cloudflare Workers AI** | Free image generation (FLUX.1 schnell), plus chat | Set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |
| **OVHcloud images** | Free image generation, no key | Set `OVHCLOUD_IMAGE_MODEL=stable-diffusion-xl-base-v10` |
| **gpt4free** | Free image generation + a second chat pool | Deploy the service — see below |
| **CLIProxyAPI** (slot) | Your own free agent-CLI logins: Gemini 3.1 Pro, GPT-5.6 series, Claude, Grok 4.5 | Deploy `deploy/cliproxy-railway/`, log accounts in via its web panel |
| **Kiro Gateway** (slot) | Free-tier Claude Sonnet 4.5, DeepSeek-V3.2, GLM-5, Qwen3-Coder | Deploy `deploy/kiro-gateway-railway/` + paste one refresh token |

## 1 · The three gateway slots

The app has three generic OpenAI-compatible slots — `custom`, `custom2`,
`custom3` — so several self-hosted gateways can run beside each other:

| Slot | Variable | First choice for |
| --- | --- | --- |
| Custom endpoint | `CUSTOM_BASE_URL` (+ `CUSTOM_API_KEY`) | FreeGPT4-WEB-API, Ollama, any OpenAI-shaped service |
| Custom endpoint 2 | `CUSTOM2_BASE_URL` (+ `CUSTOM2_API_KEY`) | [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — your free Gemini CLI / Claude Code / Codex / Grok logins as one API (`deploy/cliproxy-railway/`) |
| Custom endpoint 3 | `CUSTOM3_BASE_URL` (+ `CUSTOM3_API_KEY`) | [Kiro Gateway](https://github.com/jwadow/kiro-gateway) — free-tier Claude Sonnet 4.5, DeepSeek-V3.2, GLM-5 (`deploy/kiro-gateway-railway/`) |

Each slot activates on its URL alone; the key is optional and only sent when
set. All three can be filled at once, and each keeps its own model list.

## 2 · The two providers that need nothing

Kilo Code and OVHcloud are free tiers that answer on **your server's IP address**
rather than on an API key. They are configured the moment the app ships:

- They cannot be left unconfigured by a variable you forgot to set.
- They cannot return `401`, because there is no credential to be wrong.
- They appear in the model picker on a fresh deploy with an empty `.env`.

That is the point of them. A free tier behind a key is the tier that runs out, on
the deployment where nobody set the key.

### What to know before you rely on them

Both limits are measured **per IP**, and on a container host that IP is your
app's own outbound address — **shared by every visitor.**

- **Kilo Code:** 200 requests an hour per IP. Plenty for one person, shared among
  a crowd.
- **OVHcloud:** 2 requests a minute per IP for the **whole catalogue** —
  measured live, one request leaves `remaining: 0` for every model on that
  address, so it is a shared allowance rather than one per model. It is the
  tightest limit here, and a pool to fall back on rather than the one to live on.

Those limits are on the model rows themselves, so you can see them where you
choose: the picker labels each row `free · 2/min · per IP · shared`, and
Settings → **Server response limits** lists every declared free tier with today's
call count. Both come from `/api/llm/providers` and `/api/llm/limits`.

The app handles a `429` the way it handles any other transient failure: the turn
moves to the next configured provider with everything it had already collected,
so you see the work continue rather than an error. It also **stops waiting**
before it does that — a free tier's own `Retry-After` is often longer than the
turn is worth (40-57s on OVHcloud), so past a 20-second waiting budget the app
hands the refusal back and moves on instead of sleeping through it. Raise or
lower that with `RATE_LIMIT_RETRY_BUDGET_MS`. You just should not be surprised
when a hop happens.

Neither service is private. Both may route a prompt to a provider that logs it,
and Kilo's free pool explicitly warns that prompts may be used to improve
upstream services. Treat them as a floor, not as the pool you do sensitive work
in.

### Switching one off

An always-on service on a shared address is a liability as well as a gift, so
every provider can be switched off:

```
KILO_DISABLED=1
OVHCLOUD_DISABLED=1
```

## 3 · Free image generation

Pictures are where a free key runs out first, so this is worth reading if you
want to draw things.

**Where it stands today.** Cloudflare Workers AI is the first service tried and
the roomiest free one — 10,000 Neurons a day, no card. NVIDIA draws on signup
credit that runs out once. OpenRouter's Image API has no free tier at all.
OmniRoute's image endpoint fronts mostly paid or one-off-credit providers.

**Two genuinely free options sit outside that:**

1. **Cloudflare Workers AI** (already first in the order). Set the token and the
   account id and you can draw.
2. **OVHcloud, keyless.** This is the only free drawer this app has that needs no
   key at all — verified live, a request with no `Authorization` header answered
   `200` with a real PNG. It is **opt-in** because 2 requests a minute per IP is
   far too tight to sit silently in front of every draw:
   ```
   OVHCLOUD_IMAGE_MODEL=stable-diffusion-xl-base-v10
   ```
   With that set, OVHcloud joins the draw order behind the five named services.

### The draw order

```
cloudflare → nara → openrouter → nvidia → omniroute → (ovhcloud, if opted in) → g4f → puter (opt-in)
```

The first service that answers with a picture wins. `IMAGE_PROVIDER=<id>` pins
**one** service for the whole deployment, honoured exactly, if you would rather
decide than fall through.

## 4 · gpt4free (a service you deploy)

`deploy/g4f-railway/` runs
[gpt4free](https://github.com/xtekky/gpt4free) as a Railway service. It is the
**last** service in the draw order and the only deployable free image generator.

It is last for a reason: it reaches models by reading third-party web endpoints
rather than through documented APIs, so individual adapters break without notice.
A rescue, not a first choice. Full steps and caveats are in that folder's README.

## 5 · If OmniRoute says `502: Application failed to respond`

That message is not OmniRoute's — it is your host's own router saying it could
not reach the gateway's container. The three causes, in order:

1. **The port does not match.** The service listens on one port while
   `OMNIROUTE_BASE_URL` names another. `deploy/omniroute-railway/` now pins
   `PORT=20128` inside the container, so this should not happen on a fresh
   deploy; on an older one, open the service's deploy log and look for
   `[entrypoint] ... port=20128`.
2. **The container is restarting** — a deploy in progress, or a crash loop. The
   deploy log's last lines say which; a healthy boot ends with
   `SQLite database ready` and a run of scheduler lines.
3. **One request the router could not place.** Over by the next try. The app now
   makes one quick second attempt at that 502, and if the gateway's deduplicated
   catalogue path answers a gateway error it falls back to the plain `/models` —
   so a single hiccup no longer empties the model picker.

```bash
railway logs --service omniroute
```

## 6 · Verification: two URLs that tell you the truth

Both need no login and are never cached.

```bash
# Which providers are configured, and what kind each one is
curl -s https://<your-app>/api/llm/providers

# Every image service, in the order it will be tried, with what each is missing
curl -s https://<your-app>/api/llm/images/providers
```

`/api/llm/images/providers` is the one to read when a drawing fails. It reports
each service with its model and its reason, so the message names a variable that
would actually fix it rather than a service you never configured.

`kilocode` and `ovhcloud` should show `"configured": true` with **no variables
set at all**. If they do not, something is overriding them — check for a
`*_DISABLED` variable.

Each provider in that report also carries a `freeTier` and a `health` block:

```json
{
  "id": "ovhcloud",
  "configured": true,
  "freeTier": { "text": "2/min · per IP · shared", "scope": "ip", "callsToday": 3, "cap": null, "share": null },
  "health": { "latencyMs": 1840, "cooling": false, "cooldownMs": 0, "lastStatus": 200, "lastRetryAfterMs": 54000 }
}
```

`health.cooling: true` means the app declined a rate limit's wait and is letting
another provider answer until the cooldown expires. `callsToday` is this app
counting its own calls — it resets on every deploy, and for a provider that sends
no rate-limit headers (Kilo) it is the only count there is.

## 7 · About the two services you may not need

This app was researched against a set of "free coding agent" projects. Two are
worth a specific note, because both look like they would plug straight in and
neither does:

- **[Free Claude Code](https://github.com/Alishahryar1/free-claude-code)** fronts
  53 free providers with real fallback chains — genuinely the best of them — but
  it serves `/v1/messages` and `/v1/responses` and **not**
  `/v1/chat/completions`, which is what this app calls. It is excellent for your
  coding CLIs; wiring it into the chat picker needs a bridge. See
  `deploy/free-claude-code-railway/README.md` for the two ways to do that.
- **[my-free-code](https://github.com/hkqr/my-free-code)** has the same gap for
  the same reason.

If you have Railway services to spend, spend them knowing that: the biggest wins
here cost **zero** services.
