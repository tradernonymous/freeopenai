# Kiro Gateway on Railway (slot 2)

Free-tier **Claude Sonnet 4.5**, **Claude Haiku 4.5**, **DeepSeek-V3.2**, **GLM-5**, **MiniMax M2.x** and **Qwen3-Coder** behind one OpenAI-compatible `/v1` endpoint — currently the strongest free coding models available from any source.

Source: <https://github.com/jwadow/kiro-gateway> (2.3k+ stars, actively maintained, AGPL-3.0).

## How the token actually behaves (read this once, save hours later)

Kiro **rotates** the refresh token: every refresh hands back a *new* refresh token and invalidates the old one, and signing in again in the Kiro IDE invalidates every token the previous session produced. Two consequences:

1. **A token must live on a volume, not only in a variable.** This image enables upstream's account system and keeps its state in `/data/kiro` on the container. When the gateway refreshes, the *rotated* token is written there and survives redeploys — but only if you mount a Railway volume at `/data/kiro`.
2. **Pasting a fresh token always works.** The entrypoint compares fingerprints (SHA-256 prefixes only — the secret is never logged): if the `REFRESH_TOKEN` you pasted differs from what the file holds, your paste wins and the file is rebuilt around it; if they match, the file's rotated token is kept and the paste is ignored. Re-adding a token is therefore always safe.

If the gateway ever 401s again after you signed in to the IDE on this PC, that is expected rotation behavior: do the 60-second re-add below. It is not a bug in the deploy.

## Before you start: get your Kiro refresh token

The gateway needs one credential from a **Kiro IDE** login (the IDE is free):

1. Install [Kiro](https://kiro.dev/) on your computer and sign in (free Builder ID is fine).
2. Open the credentials file the IDE writes:
   - **Windows:** `%USERPROFILE%\.aws\sso\cache\kiro-auth-token.json`
   - **macOS/Linux:** `~/.aws/sso/cache/kiro-auth-token.json`
3. Copy the value of `"refreshToken"` from that JSON file — the *whole* long string, nothing else. (Pasting the whole file also works; the entrypoint cleans it.)

## Deploy it (5 minutes)

1. Railway → **New Service** → **GitHub Repo** → this repo.
2. **Settings → Source**: Root Directory = `deploy/kiro-gateway-railway`.
3. **Volumes → New Volume**: mount path **`/data/kiro`** — required, this is what makes rotations survive redeploys.
4. **Variables**:

   | Variable | Value | Why |
   |---|---|---|
   | `PROXY_API_KEY` | any long random string | The Bearer key this app sends. You invent it. |
   | `REFRESH_TOKEN` | the token from the Kiro IDE file above | Installed once; the gateway rotates and persists it itself. |
   | `KIRO_REGION` | `us-east-1` (default) | Only change if you know your region differs. |

5. **Settings → Networking → Generate Domain** (port `8000`).

## Re-adding a token later (60 seconds, the routine fix)

When the IDE was signed in again on this PC (or the gateway 401s at boot):

1. Open the IDE for a moment so it signs in and rewrites `%USERPROFILE%\.aws\sso\cache\kiro-auth-token.json` (or just copy from it if freshly signed in).
2. Copy the new `refreshToken` value.
3. Railway → this service → Variables → update `REFRESH_TOKEN` with the new value → save. The entrypoint detects the change by fingerprint and installs it on boot.

No volume deletion, no service rebuild.

## Connect freeopenai to it

On the **freeopenai app service**, set:

```
CUSTOM3_BASE_URL=https://<your-service-domain>/v1
CUSTOM3_API_KEY=<the PROXY_API_KEY value>
```

The picker fills with Claude Sonnet 4.5 and the rest of the free tier.

## Honest limits

- The Kiro free tier's own limits apply (they are generous for chat but not infinite); this gateway changes the *shape* of access, not the *size* of the allowance.
- Signing out of the Kiro account in the IDE revokes the whole session — re-add as above.
- One token per gateway service; multiple accounts would mean multiple services, and your OmniRoute deployment may already hold a Kiro login — one or the other will do.
