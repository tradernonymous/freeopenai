# 🚀 freeopenai – AI‑Powered OpenAI Playground

A minimalist, self‑hosted chat dashboard that gives you free, unlimited access to **OpenAI** models via **Puter.js**. No API keys, no server management – just open the URL and start chatting.

![Demo animation](https://media.giphy.com/media/3o7aCTfyhYVYcVnB3G/giphy.gif)

## ✨ Highlights
- **🖥️ Full‑screen chat UI** – black/white/green theme, mobile‑optimized, model selector, file attachments.
- **⚡ Instant model switching** – choose from 7 models (GPT‑5.4‑nano, GPT‑5.6‑sol, GPT‑6‑astra, GPT‑4o, etc.).
- **🗂️ History & export** – conversation persists in `localStorage` and can be saved.
- **📱 Mobile‑first** – responsive layout, safe‑area insets, 100dvh viewport.
- **🚀 One‑click deployment** – Railway static site (Node server) or local Python server.

## 🚀 Quick Start
```bash
# Clone the repo
git clone https://github.com/tradernonymous/freeopenai.git
cd freeopenai

# Serve locally (Python)
python -m http.server 8000
# Open http://localhost:8000/index.html in any browser
```

Or deploy instantly on Railway:

1. Create a Railway project → **Connect GitHub** → select *freeopenai*.
2. Railway detects `package.json` → runs `npm start` (Node static server).
3. Your app is live at `https://<project>.railway.app`.

## 🛠️ Development
```bash
# Install optional dependencies (just for linting)
npm install

# Run a quick lint check
npm run lint
```

## 📚 How it works
- **Puter.js** handles free‑tier OpenAI usage, charging the end‑user via Puter credits.
- UI built with plain HTML/CSS/JS – no frameworks, easy to customize.
- The server (`server.js`) serves `index.html` over the port provided by `process.env.PORT`.

## 🤝 Contributing
Feel free to open issues or PRs – add new models, improve the UI, or tighten security.

## 📄 License
MIT – see `LICENSE` file.
