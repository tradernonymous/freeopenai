# Features and models

[← Back to README](../README.md)

<a name="features"></a>

<img src="readme/banner-features.svg" alt="Features" width="100%">

<br>

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>💬 Chat</h3>
      Ask anything and get a streamed, markdown-rendered reply — headings, tables, task lists, strikethrough, autolinked URLs, nested and continued lists, a safe HTML subset (collapsible details, highlights, links), and syntax-highlighted code blocks (bare fences highlighted by language detection) with a language chip, copy button, and sandboxed live preview for HTML — at compact density, set to a <b>760px reading measure</b> inside a window you can actually see the edges of. Scroll up while a reply is still being written and it stays where you put it — a count of what arrived appears above the composer, and one tap takes you back down. Web research rides every turn — the model searches (DuckDuckGo + Wikipedia) and reads pages itself, citing sources, instead of guessing or sticking to your repos. Starts on a prompt hero with suggestion cards, copy or retry any response, Ctrl+P palette for models and actions, turn stats (model · seconds · chars) in the status bar, and System/Light/Dark plus tokyonight, gruvbox and green theme packs in the header — on every screen size, including the smallest phone. One **Session** surface (a chip in the composer, a button in the header) holds the skills this chat uses, the plan it recorded, and whether the next message is read as a drawing — the two floating cards and three composer switches they replace.
    </td>
    <td width="33%" valign="top">
      <h3>🔐 Sign in with Puter</h3>
      Google, Telegram, or a Magic Key — no account with this app, no API key, no server-side secret. Your Puter account meters the usage.
    </td>
    <td width="33%" valign="top">
      <h3>🔀 Model switching</h3>
      Swap between the GPT-6 / 5.6 / 4o families, the Codex coding models, and Claude from the composer's model picker or Settings. Your pick is remembered next visit.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>📎 Attachments</h3>
      Attach a picture, a PDF/DOCX document, or any text file — code, config, logs — and it rides along with your next message. What it is decides how it attaches, not what it is named, and the chip says what it will cost the request (`~25.0k tokens`) before you send it.
    </td>
    <td valign="top">
      <h3>⚙️ Settings</h3>
      Grouped under named sections — Model, Chat, Workspace, Skills, Account, GitHub, Server — with a chip rail across the top that jumps to any of them, so fourteen rows no longer read as one undifferentiated scroll. Default model, sign-in state, and a one-click "clear history" are all local; nothing leaves your browser.
    </td>
    <td valign="top">
      <h3>♿ Accessible by default</h3>
      Keyboard navigation on the model picker, a focus-trapped help dialog, and live-region announcements for new messages.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🖼️ Image generation</h3>
      Just describe the picture — <i>"draw a neon Tokyo street at 16:9"</i> — and it is drawn instead of answered. Nothing needs switching on: <b>Session → Image → Read the next message as a drawing</b> is there for the turn whose wording could go both ways, which is the exception rather than the rule. A labelled placeholder holds the spot while it renders (instant failures say so instead of flashing past). Click any result to zoom in, download, copy, edit with a brush mask, or make variations — every image lands in the Gallery view, newest first. <b>Drawing follows the conversation</b>: the service answering the chat draws first, and the model the chat is on is offered to it as a preference before it falls back to that service's own image model — one picker, not two. Puter, when you switch it on, draws with the image model its own list names for the job — **Sunburst** to edit, **Flare** to draw — because its images endpoint takes an image model and the picker beside it offers chat ones. Pictures go through the server's own image route, walking Nara → Cloudflare → OpenRouter → NVIDIA → HuggingFace → OmniRoute → Ollama until one of them answers. <b>Puter is opt-in</b>, because its monthly credit allowance does not roll over and images are the dearest thing on it: switch on <b>Session → Image → Draw with Puter</b> for the occasional high-end picture, and a route that fails says so rather than quietly spending credits. The status line says which one did, and when every backend fails the message lists each one with what stopped it — see <a href="#image-providers">Image providers</a>.<br><br>
      <b>Ask for a size and get it.</b> Write it the way you would say it — <code>1536x1024</code>, <code>16:9</code>, a square icon, a tall phone wallpaper, a wide banner — and the request carries it to whichever service draws. A small chip appears in the composer as you type it (`16:9`, with the pixels behind it on hover), so the shape is visible while it can still be changed rather than only in the status line after the picture arrives; it stays away for a turn that is going to be a chat, because a hint about a size nobody will send is worse than no hint. Nothing on screen says the shape you asked for used to be ignored; that is what a request with no dimensions in it does, and every service has a default of its own. A service that ignores it anyway is answered by cutting, not by apologising: a 1024×1024 drawing for a 16:9 request already contains a 1024×576 picture, and that picture is the one you asked for — see <a href="#image-providers">Image providers</a>. The status line still reports both halves when it happens (<code>asked for 16:9 (1536x864), drawn 1:1 (1024×1024) — cut to 16:9 (1024×576)</code>), because which shape you got and which shape arrived are different facts.
      <br><br>
      <b>Every drawing is read back against what you asked for.</b> The prompt an image model receives is a rewrite of your words, so the app now shows a model that can see the picture what you asked, what was sent, and asks one question: does the picture show it? One line comes back — <i>Checked: this looks like what you asked for</i>, or <i>Checked: the sign reads HLLO, not HELLO</i> — under the prompt that drew it. It is a cheap model that does the looking — the same free-first, cheapest-known ordering a tool-reading step goes through — and it never reports a guess: a service with nothing that can see, a refusal, or an answer that is not one of the two verdicts leaves no note at all. A difference comes with a <b>Fix it</b> beside it, which redraws through the same runner that made the picture — for an edit, that means the same source, and for a brushed edit the same mask — with the difference folded into the prompt verbatim. Nothing is redrawn until you tap, one tap is one render, and the Edit button stays there for changing it yourself.<br><br>
      Attach a picture and say what you want changed — "make the sky purple", "add a hat", "recolour the car" — and the turn is read by the model, which decides whether that means draw something new or change what you gave it, and writes the prompt the image model actually receives (the same job the `<code>revised_prompt</code>` field does in OpenAI's API). No attachment and no need to re-upload: follow-up instructions edit <i>the last picture in the chat</i>, so "now make it look warmer" works the way it does in ChatGPT. A refusal comes back as what to reword rather than which backend failed.
    </td>
    <td valign="top">
      <h3>🧠 Reasoning summaries</h3>
      Reasoning-capable models return their thinking separately. While it works, one moving line above the reply shows the tail of what it is thinking; when the answer arrives it folds away behind a <b>Reasoning</b> summary you can click open. Switch the whole thing off in <b>Settings → Reasoning summary</b>.
    </td>
    <td valign="top">
      <h3>🔒 Private deployments</h3>
      Set <code>AUTH_USER_1</code> / <code>AUTH_PASS_1</code> and the whole app sits behind a username/password login, so a public Railway URL isn't open to the world.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🐙 GitHub connector</h3>
      Connect up to three GitHub accounts in Settings and the model can browse, read, and commit files in your public repos straight from the chat. Tokens are encrypted into an httpOnly cookie and every write asks first.
    </td>
    <td valign="top">
      <h3>🎚️ Reasoning effort</h3>
      On models that take one, a picker sets how hard to think — <code>none</code> through <code>xhigh</code>. It stays hidden on models that would ignore it.
    </td>
    <td valign="top">
      <h3>📄 PDF in and out</h3>
      Attach a PDF or DOCX and its text rides along with your message. Save any conversation back out as a PDF from the drawer — no library, just the browser's own printer.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🗂️ Saved chats</h3>
      Every conversation is kept in a sidebar, titled by your first message. Reopen, delete, or start a new one without losing the last. Hide the sidebar when you want the room.
    </td>
    <td valign="top">
      <h3>🔌 Many providers</h3>
      Puter needs no key at all. Add a key for Nara, OpenRouter or NVIDIA and they appear in a picker — so one running dry never stops the work — and a self-hosted OmniRoute gateway fronts hundreds of providers, including the `auto` router, behind one endpoint. Keys stay on the server.
    </td>
    <td valign="top">
      <h3>📱 Built for a phone</h3>
      One small-screen definition covers a portrait phone <b>and</b> a landscape one — the landscape case matters because at 844×390 the screen is <i>wider</i> than the 640px breakpoint, so keying everything to width alone left it with a mouse-sized UI. Both get off-canvas side panels with a scrim, 44px finger targets, 16px fields everywhere (so iOS never zooms a focused one), finger-sized rows, and no hover-only deletes. The composer's controls are two groups — actions (attach) and settings — so on a phone the settings move to a second row and the one button every message reaches for cannot scroll off the edge; every control in the strip is one height, and the model picker is first in the settings. Draw-by-force, auto-skills and the plan now live in one **Session** panel (one chip in the composer, one button in the header) instead of three controls in the strip. Plus safe-area insets, a Send key on soft keyboards, no double-tap delay, a layout that resizes with the keyboard instead of hiding behind it, wrapped links and capped image heights. Desktop keeps its own density: 30px controls, three columns, no forced 16px text.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>⚡ SSE streaming</h3>
      Direct-provider replies arrive token-by-token via Server-Sent Events — no waiting for the full answer before text appears.
    </td>
    <td valign="top">
      <h3>🛑 Stop / cancel</h3>
      Hit the red stop button or press Escape mid-reply to abort a generation instantly. The upstream fetch is cancelled server-side too.
    </td>
    <td valign="top">
      <h3>⏱️ Model-catalog cache</h3>
      Provider model lists are cached in memory with a configurable TTL, so switching providers or reloading the page doesn't re-fetch the catalogue every time.
    </td>
  </tr>
</table>

<br>

<a name="models"></a>

<img src="readme/banner-models.svg" alt="Models" width="100%">

<br>

This is the curated Puter.js list — no OpenAI account or key required on your end. Add a provider key and its own catalogue is fetched live instead, ranked free-first.

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
