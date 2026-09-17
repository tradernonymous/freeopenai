# Kiro Gateway on Railway (slot 2)

Free-tier **Claude Sonnet 4.5**, **Claude Haiku 4.5**, **DeepSeek-V3.2**, **GLM-5**, **MiniMax M2.x** and **Qwen3-Coder** behind one OpenAI-compatible `/v1` endpoint — currently the strongest free coding models available from any source.

Source: <https://github.com/jwadow/kiro-gateway> (2.3k+ stars, actively maintained, AGPL-3.0).

## Before you start: get your Kiro refresh token

The gateway needs one credential from a **Kiro IDE** login (the IDE is free):

1. Install [Kiro](https://kiro.dev/) on your computer and sign in (free Builder ID is fine).
2. Open the credentials file the IDE writes:
   - **Windows:** `%USERPROFILE%\.aws\sso\cache\kiro-auth-token.json`
   - **macOS/Linux:** `~/.aws/sso/cache/kiro-auth-token.json`
3. Copy the value of `"refreshToken"` from that JSON file. That string is your `REFRESH_TOKEN`.

## Deploy it (5 minutes)

1. Railway → **New Service** → **GitHub Repo** → this repo.
2. **Settings → Source**: Root Directory = `deploy/kiro-gateway-railway`.
3. **Variables**:

   | Variable | Value | Why |
   |---|---|---|
   | `PROXY_API_KEY` | any long random string | The Bearer key this app sends. You invent it. |
   | `REFRESH_TOKEN` | the token from the Kiro IDE file above | The one credential; the gateway refreshes access tokens itself. |
   | `KIRO_REGION` | `us-east-1` (default) | Only change if you know your region differs. |

4. **Settings → Networking → Generate Domain** (port `8000`).

## Connect freeopenai to it

On the **freeopenai app service**, set:

```
CUSTOM3_BASE_URL=https://<your-service-domain>/v1
CUSTOM3_API_KEY=<the PROXY_API_KEY value>
```

The picker fills with Claude Sonnet 4.5 and the rest of the free tier.

## Honest limits

- The Kiro free tier's own limits apply (they are generous for chat but not infinite); this gateway changes the *shape* of access, not the *size* of the allowance.
- A refresh token can be revoked if you sign that Kiro account out of the IDE — re-grab the file's token if models suddenly 401.
- One token per gateway service; multiple accounts would mean multiple services, and your OmniRoute deployment may already hold a Kiro login — one or the other will do.
