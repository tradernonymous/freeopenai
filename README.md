<p align="center">
  <img src="docs/readme/hero.svg" alt="FreeOpenAI. Free access to OpenAI models, no key required." width="100%">
</p>

<p align="center">
  <b>A free, serverless chat UI for OpenAI models — no API key, no backend, no bill in your name.</b><br>
  Sign in once through Puter · pick a model · chat · your Puter account covers the usage.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/Puter.js-v2-6C5CE7?style=for-the-badge" alt="Puter.js v2">
  <img src="https://img.shields.io/badge/tests-41%20passing-22c55e?style=for-the-badge" alt="41 tests passing">
  <img src="https://img.shields.io/badge/API%20keys-none%20needed-f472b6?style=for-the-badge" alt="No API keys">
  <img src="https://img.shields.io/badge/license-MIT-0ea5e9?style=for-the-badge" alt="MIT">
</p>

<p align="center">
  <a href="#quickstart"><img src="https://img.shields.io/badge/🚀%20Quick%20start-run%20it%20locally-0b1030?style=flat-square&labelColor=22d3ee" alt="Quick start"></a>
  &nbsp;
  <a href="#deploy"><img src="https://img.shields.io/badge/☁️%20Deploy-Railway%20in%203%20steps-0b1030?style=flat-square&labelColor=8b5cf6" alt="Deploy"></a>
  &nbsp;
  <a href="#features"><img src="https://img.shields.io/badge/🧠%20How%20it%20works-no%20backend%2C%20no%20keys-0b1030?style=flat-square&labelColor=f472b6" alt="How it works"></a>
</p>

<br>

<a name="contents"></a>

## 🧭 Contents

- ✨ [Features](#features)
- 🧠 [Models](#models)
- ⌨️ [Using the app](#usage)
- 🚀 [Quick start](#quickstart)
- ⚙️ [Configuration](#config)
- ☁️ [Deploy to Railway](#deploy)
- 🏗️ [Architecture](#architecture)
- ⚠️ [Disclaimer](#disclaimer)

<br>

<a name="features"></a>

<img src="docs/readme/banner-features.svg" alt="Features" width="100%">

<br>

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>💬 Chat</h3>
      Ask anything and get a streamed, markdown-rendered reply (bold, lists, code blocks). Copy or retry any response. History saves to your browser and survives a reload.
    </td>
    <td width="33%" valign="top">
      <h3>🔐 Sign in with Puter</h3>
      Google, Telegram, or a Magic Key — no account with this app, no API key, no server-side secret. Your Puter account meters the usage.
    </td>
    <td width="33%" valign="top">
      <h3>🔀 Model switching</h3>
      Swap between the GPT-6 / 5.6 / 4o families, the Codex coding models, and Claude from the header, the Models tab, or Settings. Your pick is remembered next visit.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>📎 Attachments</h3>
      Attach an image, a PDF/DOCX document, or a small text file (<code>.txt .md .csv .json .js .ts .log .yml</code>) and it rides along with your next message.
    </td>
    <td valign="top">
      <h3>⚙️ Settings</h3>
      Default model, sign-in state, and a one-click "clear history" — all local, nothing leaves your browser.
    </td>
    <td valign="top">
      <h3>♿ Accessible by default</h3>
      Keyboard navigation on the model picker, a focus-trapped help dialog, and live-region announcements for new messages.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🖼️ Image generation</h3>
      Toggle the image icon next to the input to generate a picture instead of chatting. Click any result to zoom in or download it.
    </td>
    <td valign="top">
      <h3>🧠 Reasoning summaries</h3>
      Reasoning-capable models return their thinking separately. It appears as a collapsed <b>Reasoning</b> strip above the reply — click to show or hide it.
    </td>
    <td valign="top">
      <h3>🔒 Private deployments</h3>
      Set <code>APP_USERS</code> and the whole app sits behind a username/password login, so a public Railway URL isn't open to the world.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🐙 GitHub connector</h3>
      Connect a GitHub account in Settings to read and commit files in your public repos. The token is encrypted into an httpOnly cookie and every write asks first.
    </td>
  </tr>
</table>

<br>

<a name="models"></a>

<img src="docs/readme/banner-models.svg" alt="Models" width="100%">

<br>

All served through Puter.js — no OpenAI account or key required on your end.

| Model | Description | Id |
| --- | --- | :---: |
| **GPT-6 Astra** | Newest, most capable — complex reasoning, coding, computer use | `gpt-6-astra` |
| **GPT-5.6 Sol** | Flagship of the 5.6 family | `gpt-5.6-sol` |
| **GPT-5.6 Terra** | Mid-tier | `gpt-5.6-terra` |
| **GPT-5.6 Luna** | Smallest, cheapest of the 5.6 family | `gpt-5.6-luna` |
| **GPT-5.4 Nano** | Fast, cheap — the default | `gpt-5.4-nano` |
| **GPT-4o** | Balanced, general-purpose | `gpt-4o` |
| **GPT-4o Mini** | Fast and cheap | `gpt-4o-mini` |
| **GPT-5.3 / 5.2 Codex** | Coding-tuned | `openai/gpt-5.3-codex`, `openai/gpt-5.2-codex` |
| **GPT-5.1 Codex Max** | Coding, max context | `openai/gpt-5.1-codex-max` |
| **Claude Opus 5** | Anthropic, most capable | `claude-opus-5` |
| **Claude Sonnet 5** | Anthropic, balanced | `claude-sonnet-5` |
| **Claude Haiku 4.5** | Anthropic, fast | `claude-haiku-4-5` |

Each family has its own id convention on Puter.js: the GPT models take a bare id, the **Codex** models need an `openai/` prefix ([tutorial](https://developer.puter.com/tutorials/free-unlimited-codex-api/)), and the **Claude** models take a bare id again ([tutorial](https://developer.puter.com/tutorials/free-unlimited-claude-35-sonnet-api/)). Puter.js supports several hundred more ids beyond this curated list (o1, o3, the 4.1 line, Gemini, Llama, DeepSeek, Grok, Mistral) — see the [tutorials index](https://developer.puter.com/tutorials/) if you want to wire up additional ones.

> A model id restored from a previous session is checked against this list before use — a stale or tampered value always falls back to the default instead of silently failing.

<br>

<a name="usage"></a>

<img src="docs/readme/banner-usage.svg" alt="Using the app" width="100%">

<br>

| Action | How |
| --- | --- |
| Send a message | Type and press `Enter` (`Shift+Enter` for a newline) |
| Switch model | Click the model pill in the chat header, or open the **Models** tab |
| Attach a file | Paperclip icon — text files only, 200KB max |
| Generate an image | Image icon next to the input — describes what to draw instead of chatting |
| View / download an image | Click any generated image to zoom in, with a download link |
| Copy a reply | Copy icon under any assistant message |
| Retry a reply | Retry icon under any assistant message — resends the same prompt (or regenerates the image) |
| Start a new chat | **New chat** icon, top right — asks for confirmation first |
| Show a model's thinking | Click the **Reasoning** strip above a reply (reasoning-capable models only) |
| Connect GitHub | **Settings** tab → **Connect GitHub** → load or commit a file in any of your public repos |
| Sign in / out | Account icon, top right, or the **Settings** tab |

<br>

<a name="quickstart"></a>

<img src="docs/readme/banner-quickstart.svg" alt="Quick start" width="100%">

<br>

```bash
git clone https://github.com/tradernonymous/freeopenai.git
cd freeopenai
npm install
npm start
# → http://localhost:3000
```

**Run the tests**

```bash
npm test      # node --test — server logic + shared chat helpers
npm run lint  # eslint
```

<br>

<a name="config"></a>

<img src="docs/readme/banner-config.svg" alt="Configuration" width="100%">

<br>

Nothing to configure to get running — no API key, no `.env` file. Everything below is optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port the static server listens on |
| `APP_USERS` | *(unset)* | Login gate, as `user:password` pairs separated by commas — e.g. `alice:s3cret,bob:hunter2`. Leave it unset and the app stays open to everyone. |
| `SESSION_SECRET` | *(random)* | Signs the login cookie. Set it so sessions survive a restart. |
| `GITHUB_CLIENT_ID` | *(unset)* | GitHub OAuth App client id — enables the GitHub connector in Settings. |
| `GITHUB_CLIENT_SECRET` | *(unset)* | GitHub OAuth App client secret. |

> The GitHub token is sealed with AES-256-GCM using `SESSION_SECRET` and stored in an httpOnly cookie — browser JavaScript never sees it. The connector asks for the `public_repo` scope only, and every commit needs an explicit confirmation.

<br>

<a name="deploy"></a>

<img src="docs/readme/banner-deploy.svg" alt="Deploy to Railway" width="100%">

<br>

```bash
# 1 · push this repo to your own GitHub account (or use it as-is)

# 2 · in Railway: New Project → Deploy from GitHub repo → select the repo

# 3 · Railway auto-detects package.json and runs `npm start` — no env vars needed
```

Your app is live at `https://<project>.up.railway.app` a few seconds later.

<br>

<a name="architecture"></a>

<img src="docs/readme/banner-architecture.svg" alt="Architecture" width="100%">

<br>

**Request path.** Browser loads `index.html` → Puter.js authenticates the user and meters usage → the page calls `puter.ai.chat()` directly from the browser → the reply streams back into the chat. `server.js` never sees a message or a model response; it serves static files and, when configured, handles the login gate and proxies the GitHub connector so the OAuth token never reaches the page.

<details>
<summary><b>🗂️ Project layout</b> &nbsp;·&nbsp; click to expand</summary>

```text
index.html      chat UI: markup, styles, and all client-side logic
login.html      username/password screen shown when APP_USERS is set
chatlib.js      shared, dependency-free logic (model list, HTML escaping,
                attachment allowlist) — used by the page and by the tests
auth.js         session-cookie signing and credential checking
github.js       AES-256-GCM sealing for the stored GitHub token
server.js       zero-dependency static server + the login and GitHub routes
test/           node --test suite for server.js, chatlib.js, auth.js, github.js
```

</details>

<br>

<img src="docs/readme/divider.svg" alt="" width="100%">

<a name="disclaimer"></a>

## ⚠️ Disclaimer

FreeOpenAI is an unofficial client — it is not affiliated with OpenAI or Puter. Usage is billed to your own Puter account under Puter's terms, not this project's. Conversations are stored only in your browser's `localStorage`; clearing site data or switching browsers loses them.

<p align="center">
  <sub>MIT licensed · Built on <a href="https://puter.com">Puter.js</a> · <a href="#contents">Back to top ↑</a></sub>
</p>
