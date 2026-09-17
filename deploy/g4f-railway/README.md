# gpt4free on Railway (free image generation, no key)

This runs [gpt4free](https://github.com/xtekky/gpt4free) as a Railway service and
points `freeopenai` at it over Railway's private network. It is the last service
in the app's draw order, and the only deployable *free* image generator it can
point at.

## What it buys you

- **Free image generation with no API key.** `POST /v1/images/generations` with
  `model: "flux"` draws through community media providers.
- **One more independent pool of free chat models**, so a day when your other
  providers are rate-limited is not a day you cannot work.

## What it costs you

Read this before spending a service slot on it.

- **It scrapes.** gpt4free reaches models by reading third-party web endpoints
  rather than through documented APIs. Individual adapters break without notice
  when the site behind them changes, and the upstream project ships fixes
  continuously. Expect to redeploy this service to pick those up.
- **It may route your prompts somewhere that logs them.** The chat pool is a
  set of community providers, not one vendor with a data policy.
- **It is not private and not a guarantee.** If what you need is reliability, the
  keyless Kilo and OVHcloud providers already in the app are more dependable, and
  Cloudflare's Workers AI is the roomier free image allowance.

So this is a rescue, not a first choice — which is exactly where the app puts it.

## Deploying it

1. Railway → your project → **New → GitHub Repo** → this repo, with
   **Root Directory** set to `deploy/g4f-railway`. Railway builds the
   `Dockerfile` in that folder.
2. Rename the service to `g4f` (Settings → General). This is what makes its
   private address predictable.
3. **Settings → Volumes → New Volume**, mount path `/app/har_and_cookies`. Add a
   second one for `/app/generated_media` if your plan allows; one volume is
   enough to keep the service working.
4. **Settings → Networking → Generate Domain**, target port **8080**.
5. Open that URL and check `…/v1/models` answers JSON. If it does, the service is
   up.
6. On the **freeopenai** service (same project), set:
   ```
   G4F_BASE_URL=http://g4f.railway.internal:8080
   ```
   Leave the `/v1` off — the app adds it. (You can include it; it will not be
   doubled.)
7. Redeploy freeopenai. gpt4free now appears in the provider picker, and as the
   last service in the image order.

## Optional: put a key in front of it

Anything that can reach this service can spend every provider it fronts. On
Railway's private network that is only your own project, but if you expose the
domain publicly, do not leave it open. gpt4free reads `G4F_API_KEY` and then
requires it as a bearer token; set the same value on both services as `G4F_API_KEY`.

## Checking it worked

```bash
# 1 · the service itself (through its public domain, first time only)
curl -s https://<your-g4f-domain>/v1/models | head -c 300

# 2 · what freeopenai thinks it has
curl -s https://<your-app-domain>/api/llm/providers

# 3 · the image order, and which service is ready to draw
curl -s https://<your-app-domain>/api/llm/images/providers
```

`/api/llm/images/providers` lists `g4f` **last** and reports whether it is ready,
with the model it would draw with (`flux`) and what it is missing if it is not.

## Known limits

- **No image editing.** gpt4free's media adapters can edit on some backends and
  not others, so the app declares no edit support for it. An edit request steps
  past this service instead of sending it a prompt alone and getting a fresh
  picture back wearing the word *edit*.
- **Chat is best-effort.** The app pins a short list (`gpt-4o-mini`, `gpt-4o`,
  `deepseek-v3`, `llama-3.3-70b`) and intersects it with the service's own
  catalogue, so a renamed alias degrades to a differently-ordered picker rather
  than an empty one.
