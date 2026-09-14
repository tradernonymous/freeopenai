# antigravity-proxy-v2 (CLIProxyAPI) on Railway

Replacement for `../antigravity-proxy` (the archived `frieser` 0.7.0 image).
Same job — serve the Google quota our accounts already have as an
OpenAI-compatible API — on an actively maintained proxy, with a current model
catalogue (including `claude-sonnet-4-6`, which the old proxy 404s).

## How it is wired

New Railway service from this directory (`deploy/cliproxyapi/Dockerfile`).
Variables below, then point the app at the private-network name —
`http://antigravity-proxy-v2.railway.internal:8317` for a service named
`antigravity-proxy-v2`. Use `http://`, not `https://`: Railway encrypts
private-network traffic itself. No public domain: the API key is the only
thing between the internet and your Google quota.

| Variable | Value |
|---|---|
| `PORT` | Railway injects this itself; the entrypoint honours it, default `8317` |
| `CPA_API_KEYS` | bearer key(s) for `/v1/*`, comma-separated if several |
| `CPA_ACCOUNTS_JSON` | seed array (see below) — live Google refresh tokens, treat as a secret |
| `CPA_HOST` | *(unset)* — bind override; default `::` (dual-stack, see entrypoint.sh) |
| `CPA_AUTH_DIR` / `CPA_CONFIG_FILE` | *(unset)* — path overrides; defaults `/app/data/auth`, `/app/data/config.yaml` |

## Seeding accounts

Accounts cannot be created on the deployed instance (OAuth is a localhost
loopback), so they are signed in once locally and carried over as
`CPA_ACCOUNTS_JSON`: a JSON array of `{email, refreshToken, projectId}`. The
old proxy's seed file has exactly that shape (same Google OAuth client, so the
same refresh tokens work), e.g. from the local `antigravity-accounts.json`:

```bash
node -e "const fs=require('fs');let r=fs.readFileSync('antigravity-accounts.json','utf8').replace(/^\uFEFF/,'');const a=(JSON.parse(r).accounts||[]).filter(x=>x.refreshToken);console.log(JSON.stringify(a.map(x=>({email:x.email,refreshToken:x.refreshToken,projectId:x.projectId||'aicode-consumers'}))))"
```

Paste the output as the whole variable value. Seed only burner accounts that
hold nothing else — a restricted Google account takes its Gmail, Drive and
social logins with it. Mains never go here.

On every boot the entrypoint writes one `antigravity-<email>.json` per entry
with an empty access token and an expired stamp — the honest "needs refresh"
state. The proxy refreshes from the refresh token itself and writes the fresh
access token back (verified in the spike: blanked tokens healed to full
models + 200s with no clicks).

## Reading the logs

```
[entrypoint] seeded 2 Google account(s) into /app/data/auth
[entrypoint] 2 Google account(s) ready in /app/data/auth
```

| Log line | Meaning |
|---|---|
| `0 Google account(s) ... CPA_ACCOUNTS_JSON is empty` | same fault as the old service: the variable was empty or unset at boot |
| `unknown provider for model <id>` on requests | the id is not in the proxy's catalogue (it drifts between releases) — check `/v1/models`, then the app's pinned list |
