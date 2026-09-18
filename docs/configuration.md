# Configuration

[← Back to README](../README.md)

<a name="config"></a>

<img src="readme/banner-config.svg" alt="Configuration" width="100%">

<br>

Nothing to configure to get running — no API key, no `.env` file. Everything below is optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port the static server listens on |
| `SHARE_STORE_PATH` | *(unset)* | Where shared-chat links persist. Unset, the share store is memory-only and a restart expires every link. Set it to a file path inside a persistent volume (Railway: mount a volume, e.g. `/data/shares.json`) and links survive redeploys — the file is loaded at boot and written through a debounced atomic rename. |
| `SHARE_STORE_MAX_BYTES` | `2097152` | Byte budget for the share file when `SHARE_STORE_PATH` is set (64KB–64MB). The oldest share is dropped until the payload fits; one oversized share is always keepable, so the floor is its size plus slack. |
| `PROVIDER_TIMEOUT_CHAT_MS` | `55000` | Total budget per chat request, streaming or not. |
| `PROVIDER_TIMEOUT_HEADERS_MS` | `25000` | Per-attempt deadline for upstream response headers on streams. |
| `PROVIDER_STALL_MS` | `60000` | Aborts a stream quiet longer than this, with a stall message instead of silence. |
| `PROVIDER_TIMEOUT_MODELS_MS` | `20000` | Budget for model-catalogue fetches. |
| `RATE_LIMIT_MAX_ATTEMPTS` | `6` | Retries per call for a transient answer — 429, a 5xx, or no response at all. 1–10. Backoff grows per attempt with jitter; a provider's `Retry-After` header is honoured when one is sent. |
| `RATE_LIMIT_RETRY_BUDGET_MS` | `20000` | How long one call may spend **waiting** to retry, in total. An attempt count cannot bound this on a free tier: OVHcloud answers a rate limit with `Retry-After: 40-57`, so six attempts at its own schedule is minutes of a stalled turn before the app even considers another provider. Past this budget the refusal is handed back and the turn moves on — which is why a spent free tier now costs a hop instead of a wait. Set it higher to be patient with one provider, lower to fail over sooner. |
| `CATALOGUE_RETRY_DELAY_MS` | `600` | How long to pause before the one quick second attempt at a model catalogue whose host answered 502/503/504. A container host's own router says "Application failed to respond" when it cannot reach a container for a moment, and one more request is the difference between a picker that loads and a page that reports a broken gateway. |
| `AUTH_USER_1` / `AUTH_PASS_1` | *(unset)* | Login gate. Set both halves and the app requires a sign-in; leave either unset and the app stays open to everyone. It also decides what a *direct* provider (Nara, OpenRouter, NVIDIA, OmniRoute) needs: with a login of its own the app has already identified the visitor and enforces that on every API route, so those providers work with no Puter account. With no login gate, the Puter sign-in stays required even for a direct provider, because there it is the only thing between an anonymous visitor and your API keys. |
| `AUTH_USER_2` / `AUTH_PASS_2` | *(unset)* | A second account. Optional. |
| `AUTH_USER_3` / `AUTH_PASS_3` | *(unset)* | A third account. Optional — three is the maximum. |
| `SESSION_SECRET` | *(random)* | Signs the login cookie. Set it so sessions survive a restart. |
| `WORKSPACE_RUN` | *(unset)* | Set to `1` to let the model run shell commands on the server (see [Running a command](modes-and-tools.md)). Requires a configured login — with no accounts set, every visitor would get a shell. |
| `WORKSPACE_RUN_TIMEOUT_MS` | `120000` | How long one command may run before it and its process tree are killed. 1s–10min. |
| `BUILD_AGENT_PROVIDER` / `BUILD_AGENT_MODEL` | *(auto)* | Provider and model that carry out [remote builds](builds.md). Unset picks the first configured of NVIDIA, Cloudflare, OpenRouter, OmniRoute, Nara, Custom. Builds need a login; their commands also need `WORKSPACE_RUN=1`. |
| `GITHUB_CLIENT_ID` | *(unset)* | GitHub OAuth App client id — enables the GitHub connector in Settings. |
| `GITHUB_CLIENT_SECRET` | *(unset)* | GitHub OAuth App client secret. |
| `NARA_API_KEY` | *(unset)* | Adds the Nara router — pinned to seven allowed models: agnes-2.5-flash, agnes-3-flash, atria-dawn, laguna-s-2.1, stepfun-3.7-flash, deepseek-v4.1-flash-free, muse-spark-1.3-contributor-free. |
| `NARA_IMAGE_MODEL` | *(read from Nara's catalogue)* | Image-capable alias for the Nara image routes. Without one, Nara's own catalogue is read for a model that reads as an image model; if it names none, Nara is skipped rather than passing on Nara's "Image model is required". Its upstream supports only a fixed set of dimensions — `1024x1024`, `1640x856`, `1024x1280`, `2048x1024` — and a size outside that list is swapped for the nearest one it offers, with the swap reported in `notes` rather than losing the picture (see [Image providers](providers.md)). |
| `NARA_IMAGES_BASE_URL` | *(https://api-images.bynara.id)* | Override for the Nara images host (self-hosted endpoint, proxy, or tests). |
| `NARA_IMAGE_SIZE` | *(unset)* | The size a request is drawn at when the prompt asks for none. Read per service, so it never decides what another provider is asked for. |
| `CUSTOM_BASE_URL` | *(unset)* | Points the Custom endpoint provider at any OpenAI-compatible gateway — a self-hosted free-one-api, Ollama, llama.cpp or vLLM. Include the `/v1` segment when the gateway serves it there. The provider appears once this is set; `CUSTOM_API_KEY` is only sent when set, and `CUSTOM_MODELS` pins the picker to a comma-separated subset. |
| `FREEGPT4_BASE_URL` | *(unset)* | Points the FreeGPT4 provider at a self-hosted Free-GPT4-WEB-API gateway, which answers plain text over `GET /?text=` rather than OpenAI chat completions. The provider appears once this is set; `FREEGPT4_API_KEY` is only sent when set, and `FREEGPT4_MODELS` pins the picker. Replies arrive whole instead of streamed, from the gateway's configured default model, with no conversation memory and no image input. Free-GPT4-WEB-API needs no API key at all. Any base-URL variable accepts a paste as-is: `https://` is added when missing, `host:port` is dialled as `http://`, and a `/models` tail copied from the address bar is stripped. A value that still cannot be a web address (say, `ftp://…`) is refused by name before any request is made. |
| `IMAGE_PROVIDER` | *(unset)* | Pins **one** image provider for the whole deployment, honoured exactly: a chain that falls through behind a named service would spend a second key on a decision the operator already made. It outranks the conversation's own service, which the page sends as a mere preference. Set it to `cloudflare`, `nara`, `openrouter`, `nvidia`, `omniroute` or `g4f`. Unset means the order below. |
| `OPENROUTER_IMAGE_MODEL` | *(google/gemini-2.5-flash-image)* | Which model OpenRouter draws with. Same key as its chat. |
| `OPENROUTER_IMAGES_BASE_URL` | *(https://openrouter.ai/api/v1)* | Override for OpenRouter's image host. |
| `NVIDIA_IMAGE_MODEL` | *(black-forest-labs/flux.1-schnell)* | Which NVIDIA model draws. |
| `NVIDIA_IMAGES_BASE_URL` | *(https://ai.api.nvidia.com/v1)* | Override for NVIDIA's image host — including a self-hosted visual-genai NIM. |
| `OMNIROUTE_IMAGE_MODEL` | *(read from the gateway's catalogue)* | Which image model your gateway has connected, as `provider/model` (e.g. `openai/gpt-image-2`). Usually unnecessary: the gateway lists what it has, so its own catalogue is read for one. **Its image endpoint serves a much smaller provider set than its chat endpoint**: OpenAI, xAI, Together, Fireworks, Nebius, Hyperbolic, NanoBanana, OpenRouter, and local SD WebUI / ComfyUI. A chat model id from any other namespace is refused with `400 Invalid image model … Use format: provider/model`, however valid it looks in the chat catalogue — a Cloudflare Workers AI id, for instance, cannot draw here at all. |
| `<PROVIDER>_IMAGE_MODEL` | *(read from the provider's catalogue)* | **Pins or overrides** the model a provider draws with. Nara and OmniRoute ship no default: without the variable their own catalogue is read for a model whose id reads as an image model, and the variable is the way to choose a different one. |
| `OPENROUTER_API_KEY` | *(unset)* | Adds OpenRouter — **free tier only**. The picker pins all 19 `:free` models (verified 2026‑09‑12), led by Nemotron 3 Ultra 550B, Inkling / Inkling Small (1M ctx), Nemotron 3.5 Lightning (1M ctx), Gemma 4 31B, Laguna S/XS 2.1 and North Mini Code. `OPENROUTER_FREE_ONLY=0` lifts the free-only gate. |
| `NVIDIA_API_KEY` | *(unset)* | Adds NVIDIA's hosted models — live catalogue (GLM, DeepSeek, Kimi, MiniMax, Devstral, Qwen, Nemotron, Gemma, Mistral, gpt-oss and the rest, as served). |
| `GROQ_API_KEY` | *(unset)* | Adds **Groq** — free tier with fast inference. Models include Llama 3.3 70B, Llama 3.1 8B, Mixtral 8x7B, Gemma 2 9B, Gemma 7B. Get your API key from https://console.groq.com/keys. |
| `OPENAI_API_KEY` | *(unset)* | Adds **OpenAI** on a key of your own - chat from the live catalogue, plus the image models no free service carries. `gpt-image-1` draws (square, landscape, portrait) and edits through the images/edits endpoint; `OPENAI_IMAGE_MODEL` pins a different drawing model and `OPENAI_DISABLED=1` switches it off. Billed, so the provider stays out of the picker until the key is set. |
| `GEMINI_API_KEY` | *(unset)* | Adds **Google Gemini** on the free tier (no card, daily quota) through the OpenAI-compatible endpoint - chat from the live catalogue, key from aistudio.google.com. `GEMINI_MODELS` pins a subset and `GEMINI_DISABLED=1` switches it off. Chat only: image models are not available on the Gemini API free tier. | | `KILO_API_KEY` | *(not needed)* | Adds **Kilo Code** — a free gateway that answers with **no key at all**, so this provider is on in every deployment without anything being set. 200 requests an hour per IP (shared by every visitor on a container host), no signup, no card. Pinned to Kilo's free pool, led by `kilo-auto/free` (its own rotating router), Poolside **Laguna S 2.1** and **North Mini Code** (agentic coding, tool calling, 262K context), and Nemotron 3 Ultra 550B at 1M context. Setting this variable is only ever an override for a keyed account; `KILO_MODELS` pins a different subset and `KILO_DISABLED=1` switches it off. |
| `OVHCLOUD_API_KEY` | *(not needed)* | Adds **OVHcloud AI Endpoints** — also **keyless**, EU-hosted, no signup. Qwen3-Coder 30B, gpt-oss 120B/20B, Qwen3.5 397B, Llama 3.3 70B, Qwen2.5-VL 72B. Its limit is the tightest here: **2 requests a minute per IP for the whole catalogue** — measured live, one request leaves `remaining: 0` for every model on that address, so the allowance is shared rather than one per model — and a handful of requests from one address turns the endpoint into `429`. It is a pool to fall back on, never one to rely on. `OVHCLOUD_MODELS` pins a subset; `OVHCLOUD_DISABLED=1` switches it off. |
| `OVHCLOUD_IMAGE_MODEL` | *(unset)* | **The one free image drawer this app has that needs no key at all.** Setting it to `stable-diffusion-xl-base-v10` makes OVHcloud a drawing service — verified live, a request with no `Authorization` header at all answers `200` with a real PNG. It is opt-in rather than always-on because 2 requests a minute per IP is far too tight to sit silently in front of every draw; with the variable set it joins the order behind the five named services. |
| `G4F_BASE_URL` | *(unset)* | Points the **gpt4free** provider at a self-hosted `Interference API` (see `deploy/g4f-railway/`). Include `/v1` or leave it off — the version segment is added when it is missing. This is the **last** service tried for a picture, because it works by reading third-party sites rather than through a documented API and individual adapters break without notice. `G4F_API_KEY` is only sent when set; `G4F_MODELS` pins the picker and `G4F_IMAGE_MODEL` (default `flux`) picks the drawing model. It declares no edit support, so an edit is stepped past rather than mis-drawn. |
| `FREEBUFF_BASE_URL` | *(unset)* | Points the **Freebuff** provider at a self-hosted Freebuff2API proxy - we recommend **trefeon/freebuff-proxy** (MIT-licensed, Go-based gateway with token pool and admin dashboard). Include `/v1` or leave it off - the version segment is added when it is missing. The provider appears once this is set; the model list is read live from the proxy's `/v1/models` endpoint. `FREEBUFF_API_KEY` is only sent when set (matching a proxy deployed with `API_KEYS`), `FREEBUFF_MODELS` pins a subset and `FREEBUFF_DISABLED=1` switches it off. Chat only: the proxy serves no image endpoint. |
| `<PROVIDER>_DISABLED` | *(unset)* | Switches any provider off — `KILO_DISABLED=1`, `OVHCLOUD_DISABLED=1`, and so on. It exists because of the keyless providers: they activate with nothing set, so before this there was no variable to remove to deactivate one. |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | *(unset)* | Adds **Cloudflare Workers AI** on its official free allowance (10,000 Neurons a day, no card). Both are needed: the token from the dashboard's *Workers AI* template **with your account selected under Account Resources**, and the 32-character account id. Chat models are pinned (gpt-oss 120B/20B, Llama 3.3 70B, Llama 4 Scout, Qwen2.5 Coder 32B, QwQ 32B, Mistral Small 3.1; Gemma 3 is not open to every account); `CLOUDFLARE_MODELS` replaces the list. It is also the **first image service tried**: FLUX.1 [schnell] via `/ai/run`, pinned with `CLOUDFLARE_IMAGE_MODEL`. It does not edit pictures. |
| `DEEPGRAM_API_KEY` | *(unset)* | Adds Deepgram. Speech service; its chat endpoint answers 404. |
| `ASSEMBLYAI_API_KEY` | *(unset)* | Adds AssemblyAI. Speech service; its chat endpoint answers 404. |
| `YOUCOM_API_KEY` | *(unset)* | Adds You.com. Search and research service. |
| `OMNIROUTE_BASE_URL` | *(unset)* | Adds **OmniRoute** — a self-hosted AI gateway that fronts hundreds of upstream providers behind one OpenAI-compatible endpoint, including the `auto` model that routes each request to the best connected provider. Set it or `OMNIROUTE_API_KEY`. See [OmniRoute](omniroute.md). |
| `OMNIROUTE_API_KEY` | *(unset)* | Optional key, sent as `Bearer`. A fresh OmniRoute install answers without one (`REQUIRE_API_KEY=false`); when the gateway is hardened to require a key, set it here — and an unset key means *no* auth header at all, never a bare `Bearer`. |
| `OMNIROUTE_MODELS` | *(the lead list)* | Comma-separated ids that replace the lead list — the `auto` variants and the free-tier flagships — when your gateway's catalogue routes different names. |
| `FREE_MODELS_ONLY` | `0` | `1` applies the picker's free-only rule at the source: `/api/llm/models` returns only the rows a free tier covers, which is what an API consumer wants and what the page has its own switch for. Off by default, because a provider the operator is paying for is not a mistake. |
| `OPENROUTER_FREE_ONLY` | `1` | Free models only. Also means **no drawing**: OpenRouter's Image API has no free tier — its own docs say so, and none of its image models carries a `:free` id — so a free-only key is not offered as an image candidate. Set `0` once the key has credits. |

## Free tiers, and what they meter

Free-ness is settled by **entitlement**, not by price. A provider that declares a
free tier has its declaration win: every model it covers is reported `free: true`
with the limits in words, whatever its catalogue says about pricing. That is what
makes OVHcloud read correctly — it publishes per-token prices for a funded
account while answering on a keyless anonymous tier, so a price-based rule
offered its seven chat models as paid rows with no free label and ranked them
last.

Declared today: **OVHcloud** (`2/min · per IP · shared`), **Kilo Code**,
**Cloudflare** (10,000 Neurons a day), **OpenRouter** (`:free` ids, 50 requests a
day unfunded) and **OmniRoute** (whatever its own connections serve). Everything
else keeps the price rule, including its documented assumption about a catalogue
that publishes no prices — those rows are labelled **`free (assumed)`**, because a
provider that wanted billing first is free to say so, and its error is the honest
answer.

Two surfaces report it:

- `GET /api/llm/models?provider=<id>` — each row carries `free`, `limits` (the
text above), and `observedMs` when this process has measured that model.
- `GET /api/llm/providers` — each provider carries `freeTier` (`limits`, `text`,
  `note`, `callsToday`, `cap`, `share`) and `health` (`latencyMs`, `cooling`,
  `cooldownMs`, `lastStatus`, `lastRetryAfterMs`, `lastAt`).

The numbers are this process's own beats, not the provider's reporting: they reset
on every deploy, and a provider that publishes no rate-limit headers (Kilo) can
only ever be counted rather than quoted. `GET /api/llm/limits` lists every declared
tier with its limits and today's count.

Those two reports are what the app routes by. The failover order puts a cooling
provider last, then one whose free tier is past 80% of a known cap, then orders
by observed latency; the picker labels a row that has been slow here, and says
once a day when a free tier is nearly spent — before the turn that would have run
into it.

### The free-only picker

**Settings → Chat → Free models only** (on by default) hides the rows a provider
charges for, so the picker leads with what costs nothing. It is a view preference,
stored in the browser, and it never filters a provider down to nothing: a provider
whose whole catalogue reads as paid is shown anyway, with the row count and the
reason stated under the list. `FREE_MODELS_ONLY=1` applies the same rule at the
API instead, for consumers that are not this page.

<br>

> Each provider stays out of the picker until its key is set — **except the two keyless ones** (`KILO_API_KEY`, `OVHCLOUD_API_KEY`, both of which need no variable at all and are on in every deployment), because a free tier behind a key is the one that runs out, and a variable that has to be set is the one that is missing on a fresh deploy. Any `*_API_KEY` also accepts a matching `*_BASE_URL` override, for a self-hosted endpoint or a proxy.
>
> **OpenRouter free tier, one note.** The picker never offers a paid model by default: the allowlist carries only `:free` ids, a `freeOnly` gate double-checks the live catalogue, and OpenRouter's own rate limits apply (about 20 requests/min; 50/day without any top-up, 1,000/day once you've ever bought $10 of credits). If a pinned id is retired upstream it silently drops out of the picker — and if every pinned id were retired at once, the picker degrades to the full live catalogue instead of going empty.
>
> The last three are speech and search services rather than LLMs. They're wired up so a key can settle it, but a chat request to Deepgram or AssemblyAI returns `404` because neither has a chat completions endpoint.
>
> Model lists are read from each provider at runtime, and free models are floated to the top. Where a provider publishes prices — OpenRouter — that decides it. Where one publishes none, the app assumes an account allowance and shows the catalogue, letting the provider be the one to refuse. That assumption is not always right: a catalogue with no prices can still refuse on billing or plan limits.
>
> A refusal naming one model retires that model. A refusal about the account — "a payment method is required" — suspends the whole provider and switches back to Puter, rather than spending a failed request per model.

> GitHub tokens are sealed with AES-256-GCM using `SESSION_SECRET` and stored in an httpOnly cookie — browser JavaScript never sees them. The connector asks for the `public_repo` scope only, every commit needs an explicit confirmation, and each token is bound to the app account that connected it, so a shared browser can't leak repo access between users.

<br>
