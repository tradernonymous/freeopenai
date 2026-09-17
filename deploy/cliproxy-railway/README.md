# CLIProxyAPI on Railway (slot 1)

One gateway in front of your own **free agent-CLI logins** — Gemini CLI, Claude Code, OpenAI Codex, Grok. After you log the accounts in, models like **Gemini 3.1 Pro, GPT-5.6 series, Claude, Grok 4.5** appear as an ordinary OpenAI-compatible `/v1` API that this app's *Custom endpoint 2* slot speaks.

Source: <https://github.com/router-for-me/CLIProxyAPI> (52k+ stars, actively maintained).

## Deploy it (10 minutes)

1. Railway → **New Service** → **GitHub Repo** → this repo.
2. **Settings → Source**: Root Directory = `deploy/cliproxy-railway`.
3. **Variables** (Railway → your new service → Variables):

   | Variable | Value | Why |
   |---|---|---|
   | `CLIPROXY_API_KEYS` | any long random string, e.g. `sk-slot1-4f9d2a…` | The Bearer key this app sends. You invent it; nothing to buy. |
   | `CLIPROXY_SECRET_KEY` | another long random string | Unlocks the web management panel, which is how you log accounts in from a browser. |

4. **Settings → Networking → Generate Domain**. Note the port it asks for: `8317`.
5. **Volumes**: create a volume and mount it at `/CLIProxyAPI/auths`. Without it, every redeploy logs your accounts out.

## Log your free accounts in (the part that needs a browser)

1. Open `https://<your-service-domain>` in a browser → the management panel asks for `CLIPROXY_SECRET_KEY`.
2. In the panel, choose **Log in / Add account** → pick Gemini, Claude (Claude Code), Codex or Grok → a Google/OpenAI/xAI login page opens → sign in with the free account you already have.
3. The panel shows the account as connected and the gateway starts listing its models. Repeat for as many accounts as you like — they load-balance automatically.

## Connect freeopenai to it

On the **freeopenai app service**, set:

```
CUSTOM2_BASE_URL=https://<your-service-domain>/v1
CUSTOM2_API_KEY=<the CLIPROXY_API_KEYS value>
```

The picker fills with your logged-in accounts' models. `CUSTOM2_MODELS` can narrow the list to a comma-separated subset.

## Honest limits

- Your free-tier CLI quotas apply exactly as they do in the CLIs — this gateway changes the *shape* of access, not the *size* of the allowance.
- OAuth tokens can expire; the gateway refreshes them automatically, but a provider changing its login flow can break an account until the upstream project updates (it updates fast — it's the most active repo in this space).
- The management panel is protected by `CLIPROXY_SECRET_KEY`; keep that string private and never reuse `CLIPROXY_API_KEYS` for it.
