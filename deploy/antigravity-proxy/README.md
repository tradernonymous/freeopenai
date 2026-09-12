# Antigravity proxy, for a hosted freeopenai

This folder builds the gateway that serves Claude Opus / Sonnet and Gemini
through a Google account you already have, and seeds it with the accounts it
needs. Deploy it as a **second service in the same Railway project** as the app,
and point the app at it over the private network.

## Why it needs its own image

Two things the published image cannot do on a hosted platform:

- **Accounts cannot be created there.** The proxy's OAuth redirect is hardcoded
  to `http://localhost:3000/oauth-callback`, so the sign-in only completes where
  `localhost:3000` *is* the proxy. Sign in once on a machine running it locally
  (`bunx antigravity-proxy@0.7.0`, then the dashboard at `http://localhost:3000`),
  and carry the result here. `antigravity-accounts.json` lands beside the
  process — on the app's machine that is `.proxy-runtime/proxy/` in this repo's
  workspace, outside git.
- **A container cannot be handed a file.** So the accounts travel as a variable
  and `entrypoint.sh` writes them to `$ACCOUNTS_FILE` before the proxy starts.

## Service variables

| Variable | Value |
| --- | --- |
| `ACCOUNTS_FILE` | `/app/data/antigravity-accounts.json` |
| `AG_ACCOUNTS_JSON` | the contents of `antigravity-accounts.json` — a live Google refresh token, so treat it as a secret |

Set the app service's `ANTIGRAVITY_BASE_URL` to
`http://antigravity-proxy.railway.internal:3000` (name the service
`antigravity-proxy` and the DNS name follows). Use `http://`, not `https://`:
private traffic is already encrypted by Wireguard.

**No public domain.** The proxy has no authentication of any kind — no key, no
user check, CORS `*` — so anything that reaches it spends your Google quota.

## Working out whether it worked

The proxy's own logs are the fastest answer. On a healthy boot, `entrypoint.sh`
prints the byte count it seeded, then the startup line appears:

```
[entrypoint] seeded /app/data/antigravity-accounts.json from AG_ACCOUNTS_JSON (6718 bytes)
[Manager] Loaded 1 accounts from storage.
Antigravity Proxy running on http://127.0.0.1:3000
```

From the app, the failure tells you which half is wrong:

| Message | Meaning |
| --- | --- |
| Antigravity absent from the model picker | `ANTIGRAVITY_BASE_URL` is unset on the app service, or it was not redeployed |
| `Could not reach Antigravity: fetch failed (ENOTFOUND: the host name did not resolve)` | the service name does not resolve — wrong name, or a different project/environment |
| `... fetch failed (ECONNREFUSED: the host resolved but nothing is listening on that port)` | the name resolves, the container is not up — check its deploy logs |
| `429: Quota Exhausted: All accounts failed` | the proxy is reachable and has no accounts — the seed variable or the entrypoint did not take |
| Works, then stops | the account's daily quota is spent |

## Adding a second account later

More Google accounts means more quota, and each one has to be signed in
locally, because of the hardcoded redirect above. Sign in, copy the updated
`antigravity-accounts.json` into `AG_ACCOUNTS_JSON`, redeploy the service.

## The catch

Using Antigravity through a proxy runs against Google's Terms of Service, and
both upstream projects document account suspensions and bans. The account you
sign in with is the account at risk.
