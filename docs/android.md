# The Android app

[← Back to README](../README.md)

<a name="android-app"></a>

### 📲 The Android app

`android/` is **FreeAI4U**, a native Android client (Kotlin, Jetpack Compose, Material 3) for this server. Its layout follows the ChatGPT Android app, always dark with the web app's green accent. It talks to the same routes the web page uses (`/api/llm/chat`, `/api/llm/models`, `/api/llm/images/generations`, `/api/llm/websearch`, `/api/llm/fetch`). Everything runs as native Compose screens; there is no in-app browser view of the deployed site.

**Install it (first time)**

1. On the phone, open **https://github.com/tradernonymous/freeopenai/releases/tag/apk-latest** and tap `freeai4u.apk`.
2. Allow Chrome to install apps from this source. OPPO's ColorOS adds its own warning for apps outside its store; tap **Install anyway**.
3. Open the app. The server is filled in; type the username (`AUTH_USER_1`) and its password once and tap **Sign in**. It stays signed in from then on.

**Updating.** The app checks `version.json` in the same release once a day and offers **Download** when a newer build exists; install it over the top and the app keeps its data. **Settings → Check for updates** asks straight away. Every push to `main` that touches `android/` rebuilds and republishes it.

**What is in it**

- **Chat:** streamed replies with a folding *Thought* section and copyable code blocks. Under each reply are **copy, read aloud, regenerate, share** and **⋯** (save as Markdown, export PDF, branch, select text). Long-press your own message to copy it, select part of it, or edit it; an edit can continue in a new branch. Each draft is kept per chat, and a **Latest** button jumps down while the screen stays awake during a reply.
- **Navigation:** six real destinations — **Chat**, **Images**, **Tools**, **Skills**, **Library** and **Settings** — each keeping its own place when you switch away and back; only Chat itself has no page over it. Every row and icon is at least 48dp, and the bars respect the system bars. Back uses the system's predictive-back gesture.
- **Session panel:** the button beside the model name opens mode, model, persona, task and pinned-skill info for the chat on screen.
- **Side drawer:** search, **New chat** and **Library**, then pinned chats and history grouped by day. Swipe in from the left edge to open it. Long-press a chat to pin, rename, share or delete it. Your account row opens **Settings**.
- **Composer:** the **+** sheet adds photos (for vision models), text and code files, **Image**, and the mode; there is also a **Puter images** switch. Type `/` for saved prompts, or a **slash command** — the list shows commands and installed skills as you type, and a recognised command runs on the phone instead of being sent to the model. The mic dictates, the waveform button starts **voice mode** (hands-free: listen, reply, read aloud, listen again; say "stop" to end), and while a reply streams the same button stops it.
- **Chat / Plan / Build:** *Chat* answers, searches and reads the web, draws, and proposes phone actions. *Plan* also records a task list. *Build* can also read and stage changes to text this chat already owns — a proposed file lands in a review sheet, and nothing is real until you tap Apply there; there is still no filesystem, shell or git on the phone, so anything that needs to compile, run or deploy goes to a remote build instead. Tool steps fold into a **Worked · n steps** log with a live timer, where each step opens its own output on tap, and the task list sits above the composer.
- **Build remotely:** under a plan reply, **Build remotely** hands the plan to your server ([Remote builds](builds.md)). The **Build** screen shows the steps ticking off, each file change as a coloured diff, command output, and an **Approve / Reject** card for every change — nothing is written or run until you approve it. A build that needs you while the app is in the background sends a notification. All builds are listed under **Builds** (drawer or Tools), including ones started on the web or desktop app.
- **Phone actions:** the assistant can propose setting an alarm or timer, adding a calendar event, opening a map, dialling, drafting an email, opening a link, sharing or copying. Each one appears as a button and **does nothing until you tap it**. Every action then opens the phone's own app for you to finish, so nothing is sent or saved behind your back.
- **Images:** the free server services draw by default. **Puter images** is an optional switch that draws with *your* Puter account. It is off by default and turns itself off after a failure (such as used-up credits) or an app restart. Puter is reached through a hidden bridge page that keeps the Puter sign-in the app already holds; first-time signing in to Puter (a username and password — Google sign-in cannot work inside apps) is moving into the app itself in an upcoming build. The prompt is joined by **shape chips** for the five declared sizes (`1:1`, `3:2`, `2:3`, `16:9`, `9:16` — no size is ever invented), a **model row** (draw models when generating, edit models when a picture is attached), style presets and an **Enhance** button. **Edit a photo** attaches a picture and turns the same prompt into an edit; the request is retried with a capped backoff, and an image returned as a link is downloaded with resume. Pictures open full screen with pinch-zoom and big **Save** and **Share** actions, and are listed in **Images** newest first.
- **Tools:** quick tools (translate, summarize a link, fix grammar, explain code, rewrite, reply), plan templates, coding templates (a React component, a REST endpoint, a Dockerfile, a unit test...), builds, and a status card that tests each provider's speed.
- **Library:** one destination for everything that teaches a chat something — search across **Skills** (each opens its full `SKILL.md`, and **Use** starts a chat with it pinned), **personas** and the **prompt library** at once, or browse them by card along with the image gallery and the command list.
- **Commands:** `/help`, `/skill <name>` (or just `/skillname`), `/skills`, `/mode chat | plan | build`, `/clear`, `/compact on | off`, `/doctor`. They act on the phone — a pinned skill's text is added to that chat's system prompt, `/compact` shortens what is sent without touching what is on screen, and `/doctor` reports providers, models, skills, mode, pinned skills and the server's own budget. A line that merely starts with a slash but names nothing installed is still sent as a normal message.
- **Settings:** account, custom instructions, the default model, the **Puter images** switch, app lock, delete-all, update check, crash log, version and sign out — plus the server's own **timeouts and retry budget** from `/api/llm/limits`, read on demand rather than assumed.
- **Also:** custom instructions sent with every chat, share text or photos from any app into a new chat, **Ask FreeAI4U** in any app's text-selection menu, launcher shortcuts, a Quick Settings tile, export as text, Markdown or PDF, an optional fingerprint/screen lock, and a copyable crash log.
- **Reliability:** a foreground **Replying…** notification holds the process open so a long answer or a run of tool steps finishes while the phone is in your pocket, and a "reply ready" notification is posted when it does. If the server's seven-day session lapses mid-turn, the app signs in again with the password it already holds and finishes the turn instead of dropping you at the sign-in screen. If Android closes the app in the background, it reopens on the same chat and screen, with unsent text kept.

**Privacy and security.**
- Chats, pictures, personas and prompts are stored only on the phone, sealed with an AES-256-GCM key held in the Android Keystore. Backup and device transfer are off.
- The password is kept only so the app can sign in again when the server's seven-day session lapses, and it is sealed the same way. Sign out offers to keep or erase everything.
- Traffic is HTTPS only, with system trust anchors only, and the window is flagged secure, so screenshots and the recents thumbnail come out blank.
- The sign-in screen ignores taps while another app draws over it.
- Error text masks anything that looks like a key.
- The hidden Puter page runs with no JavaScript bridge. The Puter picture is read back in slices by polling a page property.
- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `USE_BIOMETRIC`, `SET_ALARM` and `FOREGROUND_SERVICE` (`dataSync`, only while a reply streams) are granted at install. `RECORD_AUDIO` is asked for the first time voice mode opens, and `POST_NOTIFICATIONS` once on Android 13+. The app requests no location, contacts, SMS, call-log or storage permission.
- Nothing in the app drives other apps, uses an accessibility service, or impersonates another client.

**Where the ideas came from.** Patterns were re-implemented, not copied, from:
- Paseo and AgentDeck: mode chip, plan hand-off, tool timeline, status dot, reply notifications.
- Mobile-Harness: jump-to-latest, keep screen on, code-block copy.
- callstack/agent-device: tap-to-confirm phone actions and tool errors with hints.
- Artemis: the repeated-call guard.
- FirebaseUI-Android: test tags as resource ids, tapjacking filter, password toggle.
- alan-sdk-android: the voice state machine.
- android-lead-agent-skills: the accessibility, insets and performance checklist.
- awesome-android-ui: native replacements for shimmer, typing dots, sheets and zoom.

**Building and signing.** CI (`.github/workflows/android.yml`) builds on every push that touches `android/` and runs the JVM unit tests:
- `ApiTest`: URL policy, session contract, update manifest.
- `DataTest`: storage round trips, SSE parsing, chat bodies.
- `AgentTest`: modes, tasks, approvals and action tickets, phone-action validation, streamed tool calls, history grouping.
- `RemoteBuildTest`: build sessions, events and the approval reducer.
- `TurnsTest`: grouping messages into turns and matching tool results, including a 2,000-message chat.

With a signing key in the repository secrets, CI builds the release APK and publishes it together with `version.json` to the rolling `apk-latest` release. The key is a PKCS12 keystore held in four secrets: `APK_KEYSTORE_BASE64`, `APK_KEYSTORE_PASSWORD`, `APK_KEY_ALIAS` and `APK_KEY_PASSWORD`. **Back it up off GitHub**, because Android only installs an update signed with the same key. Without the secrets the workflow builds the debug variant as an artifact instead. Each build's `versionCode` is the run number plus 100.
