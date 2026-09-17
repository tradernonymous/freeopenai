# The Android app

[← Back to README](../README.md)

<a name="android-app"></a>

### 📲 The Android app

`android/` is **FreeAI4U**, a native Android client (Kotlin, Jetpack Compose, Material 3) for this server. Its layout follows the ChatGPT Android app, always dark with the web app's green accent. It talks to the same routes the web page uses (`/api/llm/chat`, `/api/llm/models`, `/api/llm/images/generations`, `/api/llm/websearch`, `/api/llm/fetch`). Anything only the page can do — Puter models, GitHub, skills, the workspace — stays one tap away under **Web app**, a locked-down WebView of the deployed site.

**Install it (first time)**

1. On the phone, open **https://github.com/tradernonymous/freeopenai/releases/tag/apk-latest** and tap `freeai4u.apk`.
2. Allow Chrome to install apps from this source. OPPO's ColorOS adds its own warning for apps outside its store; tap **Install anyway**.
3. Open the app. The server is filled in; type the username (`AUTH_USER_1`) and its password once and tap **Sign in**. It stays signed in from then on.

**Updating.** The app checks `version.json` in the same release once a day and offers **Download** when a newer build exists; install it over the top and the app keeps its data. **Settings → Check for updates** asks straight away. Every push to `main` that touches `android/` rebuilds and republishes it.

**What is in it**

- **Chat:** streamed replies with a folding *Thought* section and copyable code blocks. Under each reply are **copy, read aloud, regenerate, share** and **⋯** (branch, select text). Long-press your own message to copy or edit it; an edit can continue in a new branch. A **Latest** button jumps down, and the screen stays awake while a reply streams.
- **Side drawer:** search, **New chat**, **Images**, **Tools** and **Web app**, then pinned chats and history grouped by day. Long-press a chat to pin, rename, share or delete it. Your account row opens **Settings**.
- **Composer:** the **+** sheet adds photos (for vision models), text and code files, **Image**, and the mode; there is also a **Puter images** switch. Type `/` for saved prompts. The mic dictates, the waveform button starts **voice mode** (hands-free: listen, reply, read aloud, listen again; say "stop" to end), and while a reply streams the same button stops it.
- **Chat / Plan / Build:** *Chat* answers, searches and reads the web, draws, and proposes phone actions. *Plan* also records a task list. *Build* also writes files into the chat and works through the tasks. Tool steps fold into a **Worked · n steps** log with a live timer. The task list sits above the composer, and **Build it** hands a plan over to Build.
- **Phone actions:** the assistant can propose setting an alarm or timer, adding a calendar event, opening a map, dialling, drafting an email, opening a link, sharing or copying. Each one appears as a button and **does nothing until you tap it**. Every action then opens the phone's own app for you to finish, so nothing is sent or saved behind your back.
- **Images:** the free server services draw by default (Cloudflare FLUX first). **Puter images** is an optional switch that draws with *your* Puter account. It is off by default and turns itself off after a failure (such as used-up credits) or an app restart. Sign in to Puter once in **Web app** with a Puter username and password; Google sign-in cannot work inside apps. Pictures open full screen with pinch-zoom, save and share, and are listed in **Images** with style presets and an **Enhance** button.
- **Tools:** quick tools (translate, summarize a link, fix grammar, explain code, rewrite, reply), personas, the prompt library, and a status card that tests each provider's speed.
- **Also:** custom instructions sent with every chat, share text or photos from any app into a new chat, **Ask FreeAI4U** in any app's text-selection menu, launcher shortcuts, a Quick Settings tile, a "reply ready" notification when a reply finishes in the background, export as text, Markdown or PDF, an optional fingerprint/screen lock, and a copyable crash log.

**Privacy and security.**
- Chats, pictures, personas and prompts are stored only on the phone, sealed with an AES-256-GCM key held in the Android Keystore. Backup and device transfer are off.
- The password is kept only so the app can sign in again when the server's seven-day session lapses, and it is sealed the same way. Sign out offers to keep or erase everything.
- Traffic is HTTPS only, with system trust anchors only, and the window is flagged secure, so screenshots and the recents thumbnail come out blank.
- The sign-in screen ignores taps while another app draws over it.
- Error text masks anything that looks like a key.
- **Web app** and the hidden Puter page run with no JavaScript bridge. The Puter picture is read back in slices by polling a page property.
- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `USE_BIOMETRIC` and `SET_ALARM` are granted at install. `RECORD_AUDIO` is asked for the first time voice mode opens, and `POST_NOTIFICATIONS` once on Android 13+. The app requests no location, contacts, SMS, call-log or storage permission.
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
- `AgentTest`: modes, tasks, files, phone-action validation, streamed tool calls, history grouping.

With a signing key in the repository secrets, CI builds the release APK and publishes it together with `version.json` to the rolling `apk-latest` release. The key is a PKCS12 keystore held in four secrets: `APK_KEYSTORE_BASE64`, `APK_KEYSTORE_PASSWORD`, `APK_KEY_ALIAS` and `APK_KEY_PASSWORD`. **Back it up off GitHub**, because Android only installs an update signed with the same key. Without the secrets the workflow builds the debug variant as an artifact instead. Each build's `versionCode` is the run number plus 100.
