# Freebuff on Railway (free coding models, your own tokens)

This runs [Freebuff2API](https://github.com/Quorinex/Freebuff2API) as a
Railway service and points `freeopenai` at it over Railway's private network.
It fronts Freebuff's free coding models (it tracks the upstream free-agent
roster, currently Minimax and GLM coding models plus Gemini flash variants)
behind a plain OpenAI-compatible endpoint: `GET /v1/models` and
`POST /v1/chat/completions`, with streaming and tool calling.

## What it buys you

- **More free coding models with no per-model key.** The proxy rotates your
  Freebuff auth tokens across its free agents, so this is one more
  independent pool next to Kilo and OVHcloud.
- **Nothing to pin.** The model list is read live from the proxy on every
  catalogue refresh, so when the upstream roster changes the picker follows
  without a redeploy. `FREEBUFF_MODELS` narrows it if you want a subset.

## What it costs you

- **Your Freebuff tokens.** Get them at
  [freebuff.llm.pm](https://freebuff.llm.pm) (log in, copy the token) or from
  the Freebuff CLI credentials file (`authToken` in
  `~/.config/manicode/credentials.json`). Several accounts means higher
  throughput -- the proxy rotates through all of them.
- **A service slot and a volume-free deploy.** The image is stateless; no
  volume needed. Throughput follows however many tokens you feed it.

## Deploying it

1. Railway → your project → **New → GitHub Repo** → this repo, with
   **Root Directory** set to `deploy/freebuff-railway`. Railway builds the
   `Dockerfile` in that folder.
2. Rename the service to `freebuff` (Settings → General). This is what makes
   its private address predictable.
3. **Settings → Variables**:
   ```
   AUTH_TOKENS=<token1,token2>
   API_KEYS=<pick one, optional>
   ```
   `AUTH_TOKENS` are your Freebuff tokens, comma-separated -- the service
   refuses to boot without them, so a missing variable reads as a crash with
   its name in the log rather than a proxy that 502s everything. `API_KEYS`
   puts a key in front of the proxy; set it if you expose the domain
   publicly, and leave it unset on the private network.
4. **Settings → Networking → Generate Domain**, target port **8080**. You
   need this once, to check `…/v1/models` answers JSON.
5. On the **freeopenai** service (same project), set:
   ```
   FREEBUFF_BASE_URL=http://freebuff.railway.internal:8080
   FREEBUFF_API_KEY=<the API_KEYS value from step 3, if you set one>
   ```
   Leave the `/v1` off — the app adds it. (You can include it; it will not be
   doubled.) An unset key means *no* auth header at all, never a bare
   `Bearer`.
6. Redeploy freeopenai. Freebuff now appears in the provider picker with its
   live model list.

## Checking it worked

```bash
# 1 · the service itself (through its public domain, first time only)
curl -s https://<your-freebuff-domain>/v1/models | head -c 300

# 2 · what freeopenai thinks it has
curl -s https://<your-app-domain>/api/llm/providers

# 3 · a chat turn through it
curl -s -X POST 'https://<your-app-domain>/api/llm/chat?provider=freebuff' \
  -H 'Content-Type: application/json' \
  -d '{"model":"<an id from step 1>","messages":[{"role":"user","content":"hi"}]}' \
  | head -c 300
```

## Known limits

- **Chat only.** The proxy serves no image endpoint, so this provider
  declares no image block and never draws -- it is stepped past for pictures
  like any chat-only service.
- **Free-tier behaviour is upstream's.** Rate limits and roster changes are
  Freebuff's, not this app's; when the roster moves, the picker follows on
  the next catalogue refresh.
