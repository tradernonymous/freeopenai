# Deploy to Railway

[← Back to README](../README.md)

<a name="deploy"></a>

<img src="readme/banner-deploy.svg" alt="Deploy to Railway" width="100%">

<br>

```bash
# 1 · push this repo to your own GitHub account (or use it as-is)

# 2 · in Railway: New Project → Deploy from GitHub repo → select the repo

# 3 · Railway auto-detects package.json and runs `npm start` — no env vars needed
```

Your app is live at `https://<project>.up.railway.app` a few seconds later.

### 🩺 Is the deploy actually current?

A 200 from your Railway URL only proves *something* is running. `GET /api/health` answers the real question, needs no login, and is never cached:

```bash
curl -s https://<project>.up.railway.app/api/health
# {"ok":true,"version":"1.0.0","commit":"4b97790…","branch":"main","uptimeSeconds":142,"providers":[…]}
```

`commit` is Railway's `RAILWAY_GIT_COMMIT_SHA`, so comparing it against `git rev-parse main` tells you whether the merge you just made is live instead of guessing from timestamps — and `uptimeSeconds` resets on every deploy, which is the quickest way to see that a redeploy happened at all. `branch` and `commit` are `null` when the server is not running on Railway.

The response carries provider **ids** only. It deliberately never includes keys, base URLs, account names, paths, or even which providers are configured — a public endpoint that lists which of your API keys exist is reconnaissance.
