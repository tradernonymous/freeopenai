# OmniRoute

[← Back to README](../README.md)

<a name="omniroute"></a>

### 🚀 OmniRoute (hundreds of providers through one local endpoint)

[**OmniRoute**](https://github.com/diegosouzapw/OmniRoute) is a self-hosted AI gateway you run yourself. It fronts **352 providers / 1,312 model ids / 154 free tiers** behind one OpenAI-compatible endpoint, with automatic routing, quota-aware fallback and a dashboard you manage. The killer feature is the `auto` model: one id that routes every request to whichever connected provider best fits at that moment — so the picker stays small even though the reach is huge.

```bash
# terminal 1: the gateway (it opens on http://localhost:20128)
npm install -g omniroute && omniroute
# or Docker: docker run -d --name omniroute -p 127.0.0.1:20128:20128 \
#   -v omniroute-data:/app/data diegosouzapw/omniroute:latest

# terminal 2: this app, pointed at it
OMNIROUTE_BASE_URL=http://127.0.0.1:20128 npm start
```

`OmniRoute` then appears in the provider picker led by `auto` and its variants (`auto/coding`, `auto/fast`, `auto/cheap`, `auto/smart`, `auto/offline`), plus a handful of direct flagships. Node `>=22.22.2` (or `>=24`); the catalogue is fetched live from the gateway's `/v1/models` (deduplicated with `?prefix=alias`) and intersected with the pinned list, so a model your gateway doesn't publish simply stays out of the picker instead of failing on use.

| Setting | Value |
| --- | --- |
| `OMNIROUTE_BASE_URL` | `http://127.0.0.1:20128` (local) or wherever the gateway runs. Both with and without `/v1` work — the version segment is added when it is missing. |
| `OMNIROUTE_API_KEY` | *(leave unset for a default install with `REQUIRE_API_KEY=false`)* |
| `OMNIROUTE_MODELS` | Optional comma-separated override when your gateway's route names differ from the pinned list |

**The model list here orders the picker, and only free-tier namespaces follow it.** It used to be a plain allowlist, which made sense while the gateway was assumed to front a handful of flagships. It is the wrong shape for a gateway: you already chose what it fronts, in its own dashboard, so a second allowlist here can only overrule that — and did. Connecting Mistral published 48 `mistral/…` ids that could not be picked by name. Now the free-first routers (`auto/best-free`, `auto/coding:free`) and the free-tier flagships lead, and the rest of the live catalogue follows them — **but only from namespaces on a free tier** (`restPrefixes`: `auto/`, `kr/`, `gh/`, `mistral/`, `groq/`, `gemini/`, `samba/`, `ollamacloud/`, `cf/`, `llm7/`, `antigravity/`, `agentrouter/`, `openrouter/`). A connected OpenAI or Anthropic key would otherwise fill the picker with models that can only answer `402`; an id outside those namespaces is still reachable by naming it in `OMNIROUTE_MODELS`. A named id that is retired upstream stops leading instead of vanishing from the list.

**Not everything in a catalogue can hold a conversation.** Embedding, reranking, moderation, image and audio models sit in the same list as chat models and can only fail on a chat call, so one shared rule drops them before the picker and the router ever see them. Job words — `embed`, `rerank`, `whisper`, `tts` — catch most of it, but speech synthesis is named after the voice instead: `fish-audio/s2.1-pro-free` reads like an ordinary chat id, and a failover picked exactly that one and asked a text-to-speech endpoint to carry on with a coding task. So the voice families are named too (`fish-audio`, `orpheus`, `aura-N`, `elevenlabs`, `playai`, `kokoro`, `xtts`, `parler`, `speecht5`, `bark-`). Matching on "audio" would be the obvious rule and the wrong one — `gpt-4o-audio` and Voxtral answer chat completions perfectly well.

Inside those namespaces one more rule applies. The gateway publishes **no pricing at all** in `/v1/models`, so "is this free?" has no general answer here — but OpenRouter marks its free models in the id, and reaches the gateway as over a thousand ids on a key that is usually free-only. `freeOnlyPrefixes: ['openrouter/']` drops the paid ones. The page keeps the first 60 usable rows, so what leads the list is what can be picked by name.

Until that variable (or `OMNIROUTE_API_KEY`) is set, **OmniRoute does not appear in the picker at all** — the provider stays out of it entirely rather than showing up and failing, so "I can't see the auto models" on a deploy almost always means the variable is missing.

**Connecting providers to OmniRoute.** Run the gateway, open its dashboard at `http://localhost:20128`, sign in with the initial admin password, and connect whichever accounts/keys you want — OmniRoute keeps them in its own SQLite database, encrypted at rest. This app never sees them; it only talks to the gateway.

**Hardening the gateway.** A default install asks for no key, and anything that can reach it can spend every account you connected. If you expose it beyond your own machine, set `REQUIRE_API_KEY=true` in the gateway's environment, create an API key in its dashboard, and put that key in `OMNIROUTE_API_KEY` here.

**A local gateway is not reachable from a deployed app.** `http://127.0.0.1:20128` from the Railway container means the container itself, where no gateway is running. Either run this app locally against the gateway (the command above), or run the gateway somewhere this app can reach — a second service on the same Railway project (private network), a VPS, or your own server — and point `OMNIROUTE_BASE_URL` at it. Don't publish an unhardened gateway to the open internet.

**Quick-tunnel URL rotates on every restart.** When the gateway is reached from a deployed app through a local quick tunnel, the `trycloudflare.com` URL changes whenever the cloudflared container is recreated (a reboot, or `docker compose up --force-recreate`). After the machine restarts, read the new URL from `docker logs app-cloudflared-1` (look for `https://…trycloudflare.com`) and update `OMNIROUTE_BASE_URL` on Railway.

**One home for the compose stack, and one `.env` that matters.** `docker-compose.yml` pins `name: app`, so the project name follows the file rather than the directory it is run from. That is deliberate: the stack was first started from a different folder, and without the pin a `docker compose up` from this repo would have named the project after this directory, created an empty second `freeopenai_omniroute-data` volume and collided on port 20128 — indistinguishable, from the dashboard, from OmniRoute having been wiped. With the pin, this repo *adopts* the running containers: `docker compose ps` here lists them, and `up` reuses the same volume:

```bash
docker compose up -d omniroute cloudflared
```

**Losing `.env` while the containers are up is recoverable; losing both is not.** `JWT_SECRET` and `API_KEY_SECRET` sign the dashboard logins and every API key held in `app_omniroute-data`, so generating fresh ones invalidates the key a deployed app is using — the gateway then answers `401` with its data apparently intact, which reads as a much stranger fault than it is. A running container still holds the values it was started with:

```bash
docker inspect app-omniroute-1 --format '{{range .Config.Env}}{{println .}}{{end}}'
```

Recover them into `.env` from there rather than inventing new ones. Once the container is removed, they are gone, and the only way back is a fresh admin password and a new API key on every client.

**`502: Application failed to respond` is your host talking, not the gateway.** It is what a container host's own router says when it cannot reach the container at all, and there are three causes:

1. **Port mismatch.** The gateway listens on one port while `OMNIROUTE_BASE_URL` names another. `deploy/omniroute-railway/` pins `PORT=20128` inside the container and logs it as `[entrypoint] data=… port=20128 command=…` on every boot, so the deploy log states which port it chose; the port in the URL and the domain's target port have to be that same number.
2. **A container that is restarting**, or crash-looping. A healthy boot ends with `SQLite database ready` followed by the scheduler lines.
3. **One request the router could not place**, usually over by the next try.

The app now covers the third case twice over: a catalogue request answered 502/503/504 gets one quick second attempt (`CATALOGUE_RETRY_DELAY_MS`, default 600ms), and a gateway error on the deduplicated path falls back to the plain `/models` — because a gateway that no longer recognises a query parameter can answer a gateway error rather than a `404`, and one extra request is a cheap way to tell the two apart. A non-JSON body is also kept now: an edge answers HTML, and the sentence inside it used to be discarded as "returned a gateway error with no detail".

```bash
railway logs --service omniroute
```

**What the app reports back about the gateway.** `GET /api/llm/providers` gives OmniRoute a `health` block (measured latency, the last status, how long it asked to be left alone) and a `freeTier` block (its connected free tiers, and today's call count). A gateway that rate-limited a call and asked for a wait the app declined is reported as `cooling`, and the failover order puts it last until the cooldown expires — so a busy gateway does not become the provider every retry lands on.
