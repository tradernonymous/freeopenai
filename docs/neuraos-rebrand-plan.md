# NeuraOS rebrand: UI/UX master plan

Status: **plan only.** Written 2026-09-23 against `4709da1`. Nothing below is built yet.
It covers the web page, the Android app and the Windows desktop app. For
Android features see [android-master-plan.md](android-master-plan.md); for the
desktop shell work already in progress see NEURA-069 in [BACKLOG.md](BACKLOG.md).

**Goal:** NeuraOS should look and feel like one product on every screen. Every
change here is judged against that.

---

## 1. Where the brand stands today (evidence)

| | Web (`index.html`, `style.css`) | Android (`ui/Theme.kt`) | Desktop (`desktop/src/index.css`, `theme.ts`) |
| :-- | :-- | :-- | :-- |
| Look | ChatGPT-style grey: `#212121` background, **white** accent | GitHub-dark: `#0D1117`, **green** `#3FB950` accent | Accent hue picker (default green, hue 152, OKLCH), light + dark |
| Themes | Dark only | Dark only | Light and dark |
| Styles | `style.css` (164 KB) plus 7 extra sheets (`phase1-zen`, `magnetic-effects`, `performance-optimized`, `hub`, ...) | One `Palette` object | `index.css` (146 KB) |
| Icons | Font Awesome from a CDN | Material icons | Own set |
| Type | System font stack | Default Roboto | System |

Also:

- **The old name is still in 148 source files** (`freeai4u`, `fa4u`): storage
  keys, function names, one page title. Users only see a few of them, but each
  one is a place the brand can leak.
- **There is no logo yet** (NEURA-004). The APK still uses the old chat-bubble mark.
- **Only the desktop checks contrast** (`test/desktop-look.test.js` sweeps every accent
  hue for WCAG AA). Web and Android have no such check.

**Conclusion:** this is not a reskin of one app. It is **one design system, with a
single source file, that all three apps are generated from.** Everything visual
follows from that.

## 2. What the leading projects do (research, September 2026)

| Project | Stars / signal | What is worth taking |
| :-- | :-- | :-- |
| [Open WebUI](https://github.com/open-webui/open-webui) | ~124k, most-used self-hosted chat | **Notes** as a workspace next to chats, attachable to any chat; persistent **artifacts** with their own storage; **Channels** (people and models in one timeline) |
| [LobeHub / Lobe Chat](https://github.com/lobehub/lobehub) | Design-led; ships its own [Lobe UI](https://github.com/lobehub/lobe-ui) kit | An **agent market** of cards with avatars; a polished PWA on phones; now presents agents as a "team" working 24/7 |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | ~47k, 2.0 rewrite Aug 2026 | **300+ ready assistants**; side-by-side answers from several models; **mini-apps**; translucent windows |
| [OpenClaw](https://github.com/openclaw/openclaw) | Fastest-growing repo of 2026 (210k+) | A **Live Canvas** the agent draws on (A2UI); the same assistant reached from phone, desktop and chat apps |
| [Google A2UI](https://developers.googleblog.com/a2ui-v0-9-generative-ui/) | v0.9 at I/O 2026, Apache 2 | **Generative UI without running code**: the agent sends a declarative UI (form, date picker, choices) and each client draws it natively |
| [Vercel AI Elements](https://github.com/vercel/ai-elements) | Official chat component kit | The **anatomy of an AI message**: Reasoning, Tool, Task, Sources, Inline citation, Context meter, Actions |
| [Google AI Edge Gallery](https://github.com/google-ai-edge/gallery) | Google's on-device app | A **tile-based home** of skills and visual summary cards |
| [Material 3 Expressive](https://m3.material.io/blog/m3-expressive-motion-theming) | Android's current design language | **Spring motion** instead of fixed timings, **shape morphing**, new loading indicator, emphasized type |

Two design patterns have become standard, and users now see their absence as broken:
a **visible streaming cursor**, and a **near-black base with translucent panels**
for AI output.

## 3. The brand foundation

### 3.1 One source of truth for design values

`design/tokens.json`, in the W3C Design Tokens (DTCG) format. A small Node script
with no dependencies (`npm run tokens`) generates:

- `design/tokens.css`: CSS variables for the web page and the desktop app
- `android/.../ui/Tokens.kt`: the Compose colour scheme, shapes, type and motion

A test fails when a generated file does not match `tokens.json` (the drift check).
The desktop's WCAG AA hue sweep moves onto the tokens, so all three apps get it.

### 3.2 Colour: pick one direction

Every direction uses the same neutrals: dark `#0A0B10` background, `#12141B`
surface, `#1A1D26` raised; light `#FAFAFB`, `#FFFFFF`, `#EEF0F4`. The accent is
defined in OKLCH, using the desktop's already-tested hue system, so contrast stays
AA in both themes.

| Direction | Accent | Character |
| :-- | :-- | :-- |
| **A. Neural Violet** (recommended) | `oklch(0.68 0.19 290)` ≈ `#8B6CFF`; AI activity drawn as a violet → cyan gradient | Reads as "AI" immediately, sets NeuraOS apart from GitHub-green and ChatGPT-grey |
| **B. Signal Green** | `oklch(0.72 0.17 150)` ≈ `#3FB950` | Continuity: Android and desktop already use it, so users notice the least change |
| **C. Aurora Teal** | `oklch(0.74 0.13 190)` ≈ `#2EC4C9`, indigo as the second colour | Calm and technical; fits a "command centre" feel |

Rule for every direction: **the accent colour means the AI or a primary action.**
Status colours (amber = needs you, red = failed, blue = info) are never the accent.

### 3.3 Type, icons, logo

- **Type:** one variable font family, self-hosted (no CDN): **Inter** for text and
  **JetBrains Mono** for code, both under the SIL Open Font License. Android bundles
  them in `res/font`.
- **Icons:** [Lucide](https://lucide.dev) (ISC licence), with only the icons we use
  copied in as inline SVG. This replaces the Font Awesome CDN on the web and the
  desktop's own set. Android keeps Material Symbols (Rounded), which matches
  Lucide's line weight, because that is what Android users expect.
- **Logo:** NEURA-004 is still open. **Offer:** I draw an SVG emblem (a
  neural-node "N") so this step no longer waits on a PNG, then cut every icon from it:
  favicon, PWA, APK adaptive + monochrome, desktop EXE, tray. If you supply your own
  emblem later, only the source file changes.

### 3.4 Motion: one signature moment

- **The NeuraOS pulse:** a single animated mark that means "the AI is working"
  (thinking, streaming, running a tool) on every platform, replacing the current
  spinners and dots.
- **Springs, not fixed timings:** Material 3 Expressive springs on Android, CSS
  `linear()` spring curves on the web and desktop, and the View Transitions API
  when moving between screens on the web.
- **Reduce motion is respected everywhere.** The desktop already has the setting;
  web and Android read the system setting.

## 4. UX upgrades

### 4.1 One anatomy for every AI message

The same parts, in the same order, drawn natively in each app (from AI Elements):

1. **Reasoning**: folded by default, labelled "Thought for 12 s"
2. **Tool steps**: one card per call with status (running / done / failed / waiting for you)
3. **Answer**: streaming cursor, code blocks with copy and run
4. **Sources**: citation chips; tapping one opens the source
5. **Actions**: copy · retry · branch · read aloud · share
6. **Context meter**: how full the model's context is

### 4.2 A home screen instead of an empty chat

A new chat opens on a home screen: a greeting, **suggestion tiles** (Gallery-style
bento grid), **continue** cards for the last chats and builds, and pinned agents.
On the phone it is one scrolling column; on the web and desktop it is a grid.

### 4.3 Agents, not personas

The Library's personas become **Agents**: a card with an avatar, a one-line
description, a model, and tools. An **agent gallery** ships a curated starter set
(Tutor, Code reviewer, Tone editor, Researcher, Translator, ...) in the spirit of
Cherry Studio's 300 assistants, and "Use" starts a chat with that agent.

### 4.4 Generative UI (A2UI subset)

This generalises the Phase 4 chart block. A model can reply with a fenced `ui`
block holding a declarative spec: **choices, a form, a date/time picker, a table, a
chart, a card**. Each app draws it with native components; **no code from the
model ever runs**. Tapping a choice or submitting a form sends an ordinary message.
The spec is a small subset of A2UI v0.9, so it can grow toward the standard later.
A spec that cannot be drawn stays visible as code, as charts already do.

### 4.5 Command palette everywhere

`Ctrl+K` / `⌘K` on the web and desktop (the desktop already has one); on Android, a
search sheet from the top bar. One place to reach chats, agents, settings and
actions.

### 4.6 Canvas for long output

Code, HTML, documents and diagrams open in a **side canvas** (a bottom sheet on the
phone) with a preview and a version history, instead of a very long chat bubble.
The desktop's Design canvas and HTML Preview become the model for this.

### 4.7 Light theme and accessibility

Web and Android gain a **light theme** (desktop has one). Contrast is tested by the
token drift check on all three apps. Every icon button has a label, touch targets
are at least 48 dp, and focus rings are visible.

## 5. Phases

Each phase ships on its own and is verified green (CI, Android, Desktop) before the
next one starts, the same way as the Android plan.

| Phase | What | Where | Size |
| :-- | :-- | :-- | :-- |
| **R0 Foundation** | `tokens.json` + generator + drift/contrast tests; logo SVG and every icon cut from it; fonts self-hosted; visible old-name strings replaced (storage keys moved with a read-old/write-new migration) | all | M |
| **R1 Web reskin** | Tokens applied; the 7 extra stylesheets folded into `style.css` in `@layer` order (dead rules removed, measured before and after); Font Awesome → Lucide; light theme; the pulse | web | L |
| **R2 Android reskin** | `Tokens.kt` scheme; Material 3 Expressive springs and shapes; light theme + optional dynamic colour; bundled fonts; the pulse; new launcher icon | Android | M |
| **R3 Desktop reskin** | Tokens under the existing hue system (default hue = brand); tray and installer icons; lands **with** NEURA-069, not against it | desktop | M |
| **R4 Message anatomy** | §4.1 in all three apps: Reasoning, Tool cards, Sources, Actions, Context meter | all | L |
| **R5 Home, agents, palette** | §4.2, §4.3, §4.5 | all | L |
| **R6 Generative UI** | §4.4, the `ui` block, parser shared in spirit (JS + Kotlin, each tested), native renderers | all | L |
| **R7 Canvas + showcase** | §4.6; then the README hero, badges and screenshots redrawn in the new brand | all | M |

**Recommended order:** R0 → R2 → R1 → R4 → R5 → R3 → R6 → R7. Android goes first
after the foundation because it has the smallest theme surface (one `Palette`) and
proves the token pipeline cheaply. R3 waits for the desktop agent's NEURA-069, so
the two agents do not edit the same stylesheet at the same time.

## 6. Rules for this work

- Zero new runtime dependencies on the server. Fonts and icons are vendored static
  files; the token generator is a plain Node script.
- No CDN for anything the page needs to look right (fonts, icons).
- Each reskin keeps behaviour identical: the existing web, Android and desktop test
  suites must stay green without edits other than intentional string changes.
- Every reskin phase records before and after screenshots in its "Shipped" note here.
- The desktop is shared with another agent: R3 is coordinated through NEURA-069.

## 7. Decisions needed from you

1. **Colour direction:** A (Neural Violet, recommended), B (Signal Green) or C (Aurora Teal).
2. **Logo:** shall I draw the SVG emblem, or will you supply one?
3. **Order:** start with R0 + R2 (Android first, recommended), or the web first?

## Sources

[Open WebUI features](https://docs.openwebui.com/features/) ·
[LobeHub](https://github.com/lobehub/lobehub) · [Lobe UI](https://ui.lobehub.com/) ·
[Cherry Studio](https://github.com/cherryhq/cherry-studio) ·
[OpenClaw](https://github.com/openclaw/openclaw) ·
[A2UI v0.9](https://developers.googleblog.com/a2ui-v0-9-generative-ui/) ·
[AI Elements](https://github.com/vercel/ai-elements) ·
[AI Edge Gallery](https://github.com/google-ai-edge/gallery) ·
[M3 Expressive motion](https://m3.material.io/blog/m3-expressive-motion-theming) ·
[Top AI repositories 2026](https://blog.bytebytego.com/p/top-ai-github-repositories-in-2026) ·
[AI app UI trends 2026](https://www.groovyweb.co/blog/ui-ux-design-trends-ai-apps-2026)
