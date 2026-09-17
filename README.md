<p align="center">
  <img src="docs/readme/hero-3d.svg" alt="FreeAI4U. Free AI chat, images and agents. One login. Keys stay on the server." width="100%">
</p>

<p align="center">
  <a href="#-quick-start"><img src="docs/readme/btn-quickstart.svg" alt="Quick start" height="48"></a>
  <a href="docs/deploy.md"><img src="docs/readme/btn-deploy.svg" alt="Deploy" height="48"></a>
  <a href="https://github.com/tradernonymous/freeopenai/releases/tag/apk-latest"><img src="docs/readme/btn-apk.svg" alt="Get the APK" height="48"></a>
  <a href="#-docs"><img src="docs/readme/btn-docs.svg" alt="Docs" height="48"></a>
</p>

<p align="center">
  <a href="https://github.com/tradernonymous/freeopenai/actions/workflows/ci.yml"><img src="https://github.com/tradernonymous/freeopenai/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/tradernonymous/freeopenai/actions/workflows/android.yml"><img src="https://github.com/tradernonymous/freeopenai/actions/workflows/android.yml/badge.svg?branch=main" alt="Android build"></a>
  <a href="https://github.com/tradernonymous/freeopenai/releases/tag/apk-latest"><img src="https://img.shields.io/github/release-date/tradernonymous/freeopenai?label=APK&logo=android&color=3fb950" alt="APK"></a>
  <img src="https://img.shields.io/badge/tests-987%20passing-3fb950" alt="987 tests passing">
  <img src="https://img.shields.io/badge/node-22%2B-3fb950?logo=node.js&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/license-MIT-3fb950" alt="MIT">
</p>

## ✨ What you get

| 💬 **Chat** | 🧩 **Plan · Build** | 🖼️ **Images** |
| :-- | :-- | :-- |
| Free models: Puter, Cloudflare, NVIDIA, OpenRouter, Nara, OmniRoute. Web search built in. | Task lists, skills, workspace, GitHub tools, optional commands. | Free FLUX first. Puter only when you switch it on. |
| 📲 **Android** | 🔐 **Your login** | ☁️ **One deploy** |
| ChatGPT-style app. Voice mode. Encrypted chats. | Up to 3 accounts. Keys never reach the browser. | Push to `main`. Railway ships it. |

## 🚀 Quick start

```bash
git clone https://github.com/tradernonymous/freeopenai.git
cd freeopenai && npm install && npm start   # → http://localhost:3000
```

<details>
<summary><b>Run the checks</b></summary>

```bash
npm test        # node --test
npm run lint    # eslint
npm run smoke   # clean-profile Chrome check (Node 22+)
```

</details>

> [!TIP]
> Nothing is required to start. Add keys and a login later — see [Configuration](docs/configuration.md).

## ☁️ Deploy

1. Push to GitHub.
2. Railway → **New Project → Deploy from GitHub repo**.
3. Set `AUTH_USER_1`, `AUTH_PASS_1`, `SESSION_SECRET` and your provider keys.

<details>
<summary><b>Is my deploy current?</b></summary>

```bash
curl -s https://<project>.up.railway.app/api/health
```

`commit` must match `git rev-parse main`. `uptimeSeconds` resets on every deploy. More in [Deploy](docs/deploy.md).

</details>

## 📲 Android app

1. On the phone, open **[apk-latest](https://github.com/tradernonymous/freeopenai/releases/tag/apk-latest)**.
2. Tap `freeai4u.apk` → **Install**.
3. Sign in once. Updates are offered in the app.

> [!NOTE]
> Puter sign-in inside apps needs a Puter username and password. Google sign-in is blocked in app browsers.

## 🧭 How it fits

```mermaid
flowchart LR
  W[Web app] --> S
  A[Android app] --> S
  S[server.js<br/>login · keys] --> C[Cloudflare]
  S --> N[NVIDIA]
  S --> O[OpenRouter free]
  S --> R[Nara · OmniRoute]
  W -. your account .-> P[Puter]
```

## 📚 Docs

| | | |
| :-- | :-- | :-- |
| 📖 [Features](docs/features.md) | ⚙️ [Configuration](docs/configuration.md) | 🧩 [Modes & tools](docs/modes-and-tools.md) |
| ⌨️ [Using the app](docs/usage.md) | ☁️ [Deploy](docs/deploy.md) | 🖼️ [Image providers](docs/providers.md) |
| 📲 [Android app](docs/android.md) | 🔀 [OmniRoute](docs/omniroute.md) | 🏗️ [Architecture](docs/architecture.md) |

<details>
<summary><b>⚠️ Disclaimer</b></summary>

Unofficial client, not affiliated with OpenAI, Puter or any provider. Each provider's own terms and limits apply; Puter usage bills your own Puter account. Web chats live in your browser (`localStorage` and IndexedDB); Android chats live encrypted on the phone. Clearing either loses them — there is no server copy.

</details>

<p align="center"><sub>MIT · <a href="#-quick-start">Back to top ↑</a></sub></p>
