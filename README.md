<p align="center">
  <img src="docs/readme/hero.svg" alt="FreeAi4U. Free access to OpenAI models, no key required." width="100%">
</p>

<p align="center">
  <b>Free AI chat, images and agents — web app + Android app — on official free tiers.</b><br>
  Puter, Cloudflare Workers AI, NVIDIA, OpenRouter free models and more, behind your own login.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/Puter.js-v2-6C5CE7?style=for-the-badge" alt="Puter.js v2">
  <img src="https://img.shields.io/badge/tests-986%20passing-22c55e?style=for-the-badge" alt="986 tests passing">
  <img src="https://img.shields.io/badge/Android-app-3FB950?style=for-the-badge&logo=android&logoColor=white" alt="Android app">
  <img src="https://img.shields.io/badge/license-MIT-0ea5e9?style=for-the-badge" alt="MIT">
</p>

<p align="center">
  <a href="#quickstart"><img src="https://img.shields.io/badge/🚀%20Quick%20start-run%20it%20locally-0b1030?style=flat-square&labelColor=22d3ee" alt="Quick start"></a>
  &nbsp;
  <a href="#deploy"><img src="https://img.shields.io/badge/☁️%20Deploy-Railway%20in%203%20steps-0b1030?style=flat-square&labelColor=8b5cf6" alt="Deploy"></a>
  &nbsp;
  <a href="docs/android.md"><img src="https://img.shields.io/badge/📲%20Android-install%20the%20app-0b1030?style=flat-square&labelColor=f472b6" alt="Android app"></a>
</p>

<br>

## What it is

- 💬 **Chat** with free models from Puter, Cloudflare Workers AI, NVIDIA, OpenRouter (`:free`), Nara and OmniRoute — streamed, Markdown, code blocks, web search built in.
- 🧩 **Chat / Plan / Build modes** with skills, a task list, a workspace, GitHub tools and an optional server command runner.
- 🖼️ **Images** from free services first (Cloudflare FLUX), Puter only when you switch it on.
- 📲 **Android app** with a ChatGPT-style UI, voice mode, Plan/Build agent and encrypted local chats.
- 🔐 **Your own login** (up to three accounts); keys stay on the server, never in the browser or the APK.

<a name="quickstart"></a>

## 🚀 Quick start

```bash
git clone https://github.com/tradernonymous/freeopenai.git
cd freeopenai
npm install
npm start          # → http://localhost:3000
```

```bash
npm test           # node --test
npm run lint       # eslint
npm run smoke      # clean-profile Chrome smoke check (Node 22+)
```

Nothing is required to start. Add provider keys and a login in `.env` or your host's variables — see [Configuration](docs/configuration.md).

## ☁️ Deploy

1. Push the repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Set `AUTH_USER_1`, `AUTH_PASS_1`, `SESSION_SECRET` and the provider keys you have.

Check the deploy is current: `curl -s https://<project>.up.railway.app/api/health` — `commit` should match `git rev-parse main`. More in [Deploy](docs/deploy.md).

## 📲 Android app

On the phone open **[the apk-latest release](https://github.com/tradernonymous/freeopenai/releases/tag/apk-latest)**, tap `freeai4u.apk`, install, sign in once. The app offers updates by itself. Details in [The Android app](docs/android.md).

<a name="contents"></a>

## 📚 Docs

| Page | What is in it |
| --- | --- |
| [Features and models](docs/features.md) | Everything the web app does, and the models it lists |
| [Using the app](docs/usage.md) | Everyday actions, appearance, using it on a phone |
| [Configuration](docs/configuration.md) | Every environment variable |
| [Deploy](docs/deploy.md) | Railway and the health check |
| [Modes, skills and tools](docs/modes-and-tools.md) | Chat/Plan/Build, skills, GitHub, workspace, commands, tasks |
| [OmniRoute](docs/omniroute.md) | Hundreds of providers through one self-hosted gateway |
| [Image providers](docs/providers.md) | Which service draws, retries, provider quirks |
| [The Android app](docs/android.md) | Install, features, privacy, signing |
| [Architecture](docs/architecture.md) | How the pieces fit |

<a name="disclaimer"></a>

## ⚠️ Disclaimer

FreeAi4U is an unofficial client — it is not affiliated with OpenAI or Puter. Usage is billed to your own Puter account under Puter's terms, not this project's. Conversations are stored only in your browser — the text in `localStorage` (the last 50, each capped at 200 messages) and the pictures themselves in an IndexedDB index beside them. Clearing site data or switching browsers loses them; there is no server-side copy to restore from.

<p align="center">
  <sub>MIT licensed · Built on <a href="https://puter.com">Puter.js</a> · <a href="#quickstart">Back to top ↑</a></sub>
</p>
