# NeuraOS APK — master plan v2

[← Back to README](../README.md)

Status: **V1–V8 shipped 2026-09-23**, with V3, the phase gaps and P7 finished the
same day (§4.1), then P8 and P11, then a perf/security/a11y batch and its review fix
batch (build 245, §4.1). Open: V0's phone session. v2 written 2026-09-23 against
`9b70b7d` (the R2 reskin). v1 (Phases 0–5, all done) is in git history:
`git show 5d136ca:docs/android-master-plan.md`.

**Goal:** the APK should feel **futuristic, fluid and one-handed**. Four places to
go instead of seven, motion that explains where you came from and what the AI is
doing, and a visual layer that comes alive only while the AI works. Underneath, every
piece of background work gets an owner, so a stopped reply or a closed screen really
stops what it started.

What the app *is* lives in [The Android app](android.md). The brand (tokens, emblem,
colours, type) lives in the [rebrand plan](neuraos-rebrand-plan.md). This page owns
everything still to be done on Android, and why. The backlog rows marked `android`
point here.

---

## 0. Where the APK stands (measured 2026-09-23)

| Fact | Value |
| :-- | :-- |
| Source | 59 Kotlin files, 14,507 lines under `android/app/src/main` |
| Largest files | `AppViewModel.kt` 1,831 · `NativeActivity.kt` 1,164 · `MainScreen.kt` 1,026 |
| Tests | 24 JVM test classes; the web suite (2,222 tests) covers the server routes the app calls |
| Toolchain | AGP 8.13.2 · Kotlin 2.3.21 · Compose BOM 2026.06.01 · activity 1.10.1 · core 1.15.0 |
| SDK | compileSdk 36 · targetSdk 36 · minSdk 29 |
| Look | Neural Violet, dark and light, Inter + JetBrains Mono, the NeuraOS pulse (R2) |

**What v1 and the rebrand shipped** (each green in CI, `apk-latest` republished):

| Phase | Commit | What |
| :-- | :-- | :-- |
| 0 Debt | — | Adaptive icon, Maestro tags, TODO markers, dead dependency removed |
| 1 Toolchain | `34d61e9` | AGP 8.13 / Kotlin 2.3 / Compose BOM 2026.06 / SDK 36 |
| 2 Diagnosability | `88ffc6e` | Copy diagnostics, the failure ring, every failure names its cause |
| 3 Polish | `5791927` | Cold start measured, visible Outbox, opt-in offline answers |
| 4 Surfaces | `50587b1` | PR review, plan map, summarise/translate, charts, Tone editor |
| 5 Parity | `f0ef97a` | Scheduled prompts (remind, never run) |
| R2 Reskin | `9b70b7d` | Neural Violet, light theme, emblem icons, fonts, the pulse |

### What the audit found (why v2 exists)

1. **Navigation is flat and hidden.** Seven destinations (Chat, Images, Tools, Skills,
   Library, Automate, Settings) sit in a side drawer, with Builds and PR review deeper
   in. Pages are an `AnimatedContent` layered over the chat, driven by a hand-written
   `NavState`.
2. **Back does not animate.** `NativeActivity`'s `PredictiveBackHandler` collects the
   gesture's progress and throws it away (`progress.collect { }`), then pops. Android
   16's back preview is a system promise the app does not keep.
3. **Background work has no owner.** `AppViewModel` runs 44 `io.execute { }` blocks
   that report back through 53 `main.post { }` / `runOnUiThread` callbacks, and has no
   coroutines. Stopping a reply sets flags a pool thread checks later; leaving a
   screen cancels nothing; a failure is seen only if its callback remembered to
   report it. The `kotlin-concurrency-and-flow` skill calls this "detached work": no
   caller can observe its completion, cancellation or failure.
4. **One-shot events are stored as state.** `notice`, `commandInfo`, `finishedReply`
   and friends are `mutableStateOf` values that screens clear by hand. Two notices in
   one frame show as one; one that arrives while its screen is gone waits there.
5. **The newest motion APIs are one toolchain step away.** Compose 1.12 (BOM ≥
   2026.08) brings mesh gradients, `DeferredAnimatedContent` for predictive back and
   shared-element fixes, but needs AGP 9.1 and compileSdk 37: the same boundary v1's
   Phase 1 hit on its third try.

---

## 1. Pending tasks carried forward

Nothing from v1 or the rebrand is dropped. Each item has a home below.

| # | Item | Needs | Where |
| :-- | :-- | :-- | :-- |
| P1 | R2 reskin: CI green, `apk-latest` republished. **Done** | CI | V0 |
| P2 | Real Android 16 phone: predictive back on every screen, edge-to-edge with the keyboard up, `ReplyService` through a long background reply | you, once | V0 |
| P3 | Cold-start number from a real phone (Copy diagnostics shows it) | you, once | V0 |
| P4 | One real failure (airplane mode) in Copy diagnostics names its cause | you, once | V0 |
| P5 | A scheduled prompt fires and its notification opens the chat | you, once | V0 |
| P6 | R2 on the phone: light theme, launcher and themed icon, fonts | you, once | V0 |
| P7 | APK size and an `r8-analyzer` pass. **Done** (`39f35f5`): the package-wide `-keep` became `-keep,allowshrinking,allowoptimization` (names and line numbers kept for crash logs); build 239 → 240 went from 5,113,069 to 4,801,773 bytes (−6.1%). The pre-R2 size was not recorded and the release keeps only the latest APK, so R2's font cost is not measurable any more | CI | V1 |
| P8 | Puter "Continue with Google / Apple / Microsoft": sign in through the phone's browser and collect the token from Puter's `/login/wait` (the SDK's own path; the desktop already does it). **Done**: the sign-in page opens in a Custom Tab, the wait is a coroutine owned by the activity (a second tap retires the first; closing the app ends it and says so), and the token goes only into the bridge page's SDK | you said "later" | V7 |
| P9 | Rebrand R4 (message anatomy), R5 (home, agents, command palette), R6 (generative UI), R7 (canvas): the Android halves. **Done** | — | V4, V5, V8 |
| P10 | NEURA-004 (logo) and NEURA-039 (desktop parity) are done by R0 and Phase 5; the backlog's owner can close both rows | backlog owner | — |
| P11 | The old `fa4u` prefix in `puter-bridge.html` and `PuterBridge.kt` (internal names, never shown). **Done**: renamed to `neura`; the page keeps each old name as a read-through alias for app builds up to 2.0.241, to be removed once those are gone | — | V3, while those files are open |

---

## 2. Design direction: "calm until it thinks"

A futuristic app is not a busy one. The rules for everything below:

1. **Quiet by default, alive when the AI works.** Resting screens are near-black ink,
   type and one accent. Light, glow and motion appear while the AI thinks, speaks or
   runs a tool, and stop when it stops. The pulse is the seed of this.
2. **Motion explains where you are.** Something grows out of what you tapped (shared
   elements), back previews where it returns to, sheets rise from the thumb.
3. **One hand.** Everything used daily is reachable from the bottom third. The top
   bar holds reading, not doing.
4. **Depth by light, not boxes.** Floating surfaces (dock, composer, sheets) are
   translucent glass over the content, not grey rectangles with borders.
5. **Always optional.** Remove animations turns every effect into a still state;
   TalkBack names every control; contrast is tested by `test/tokens.test.js`.

### 2.1 Navigation: four spaces and an orb

```
   ╭────────────────────────────────────────────────╮
   │  Chat     Create     ( ◉ )     Agents   Activity │   floating glass dock
   ╰────────────────────────────────────────────────╯
```

| Space | Takes over | Why |
| :-- | :-- | :-- |
| **Chat** (home) | Chat, the chat list (was the drawer), search | What the app is for; opens on a home screen (rebrand §4.2), not an empty thread |
| **Create** | Images, charts and generated files, the canvas (V8) | Things the AI *makes* |
| **( ◉ ) the orb** | Voice mode (tap), new chat (long-press) | The AI itself: idle, breathing while it listens, pulsing while it works anywhere in the app |
| **Agents** | Library (agents, skills, prompts), Tools, Automate and schedules | Who works for you, and how |
| **Activity** | Builds, PR reviews, the Outbox, scheduled runs | Everything running or waiting; the dock badge counts what needs you |

**Settings** moves to the avatar in the top bar. **Go anywhere** (the command
palette) opens from the search icon or a swipe down on the dock and finds chats,
agents, settings and actions by name.

At ≥ 600 dp (tablet, unfolded phone) the dock becomes a rail, and Chat and Activity
become list–detail: the list stays while the detail changes.

### 2.2 Motion system

| Moment | What it does | Built with |
| :-- | :-- | :-- |
| Page change | A shared element grows from the tapped card: chat row → chat header, picture → viewer, build card → build, agent card → new chat | `SharedTransitionLayout` + Navigation 3 scenes |
| Back | While you drag, the page shrinks toward where it returns and follows your finger; letting go commits or springs back | Navigation 3 predictive back; `DeferredAnimatedContent` after V1 |
| Send | The send button morphs into Stop; your message rises into the thread on a spring | Token springs, shape morph |
| Streaming | Words fade in behind a soft caret; the orb pulses | `NeuraPulse` (done), text reveal |
| Thinking | A folded "Thinking…" line with a light sweep, then "Thought for 12 s" | Rebrand R4 |
| AI working | A thin violet → cyan glow breathes along the screen edge | AGSL shader on API 33+, static gradient on 29–32 |
| Voice | A full-screen aurora that follows your voice level; the orb becomes a waveform pill | AGSL shader; today's `VoiceOrb` below 33 |
| Approve / done | Haptic tick, check morph, success colour | Haptics already in `Motion.kt` |

Springs come from `design/tokens.json`. Material 3 Expressive (`MotionScheme.expressive()`,
`FloatingToolbar`, `LoadingIndicator`, `ButtonGroup`) is adopted **once material3 1.5
is stable**: today every Expressive component is still in the 1.5 alpha line, and an
alpha in a sideloaded app nobody can debug on the phone is the wrong trade.

**Guardrails:** shaders pause off screen and in battery saver; no effect runs while
the AI is idle; every effect has a still state for Remove animations; frame time is
checked on the CI emulator.

---

## 3. Engineering foundations

### 3.1 An owner for every background job

Following the `kotlin-concurrency-and-flow` skill:

- **The data layer stays blocking; the view model changes threads** (revised when
  V3 shipped). The receivers below call `NativeApi` synchronously inside `goAsync`,
  so blocking calls stay. The view model reaches them only through one `onIo {}`
  (`withContext` on its pool). The data layer keeps no scope and launches nothing.
- **The view model owns every launch**, on `viewModelScope`: the one place a UI event
  becomes work. Stop is `job.cancel()`. Leaving a screen cancels what it started.
- **Streams become cold `Flow`s.** A streaming reply and a build's event stream
  become `callbackFlow`s over the existing readers; closing the flow is the
  cancellation, not a flag.
- **State and events are separated.** Renderable state stays Compose state (or one
  `StateFlow` per feature). One-shot handoffs (notices, "open this chat", "reply
  finished → notify") become a buffered `Channel` read through `receiveAsFlow()`:
  an event that arrives while its collector is away is delivered once, never lost,
  never replayed.
- **Every broad `catch` rethrows `CancellationException`.**
- **Broadcast receivers keep `goAsync()`** with one named worker each
  (`RecipeAlarmReceiver`, `RecipeBootReceiver`). A synchronous platform entry point
  with no lifecycle owner is the one place a detached worker is correct.
- **Migrate by feature, hottest first:** chat send/stream/stop → provider catalogue →
  images → builds SSE → PR review → the rest. Each step removes its
  `io.execute`/`main.post` pairs, and each phase reports the remaining count.
- **Tests:** `kotlinx-coroutines-test` (test-only) and `runTest` for cancellation
  (Stop really closes the reader), restart (send again after Stop) and failure (a
  provider error reaches the failure ring).

`AppViewModel` is split **only along these seams**, one feature at a time with the
`safe-refactor` skill: chat, builds, reviews, schedules and Puter each get a small
state holder that its screen reads. The split falls out of the ownership fix; it is
not restructuring for its own sake.

### 3.2 Navigation 3

Navigation 3 (stable 1.0) keeps the back stack as a list the app owns, which is what
`NavState` already is, so this is a move rather than a rewrite:

- one back stack per dock space (today's per-tab stacks); `Route` stays the key type,
  and `screenKey()` / `screenFromKey()` keep notification deep links working;
- predictive back per destination, from the library;
- list–detail scenes on wide screens;
- today's `NavState` tests move with it and gain cases for the new spaces.

### 3.3 Visual regression tests

A visual overhaul on a phone nobody here can see needs pictures. Screenshot tests
(Roborazzi on the JVM, **a test-only dependency**) record the main screens in dark
and light at phone and tablet width. CI fails on an unexplained pixel change and
uploads the diff for review. Baselines are recorded *before* V4, so the redesign is
compared against today rather than against itself.

---

## 4. The phases

**Stop condition for every phase:** JVM tests green, the Android CI run green end to
end (build → smoke → publish), `apk-latest` carries the new `versionCode`, and from
V2 on the screenshot tests green or their diffs approved. Anything only CI proved is
reported as such, with the phone check that would confirm it.

**Rules carried from v1:** bump toolchain versions together and alone; there is no
local Android SDK, so every attempt is a CI run; `git pull --rebase` before starting
and before pushing (two agents push to `main`).

| Phase | What | Size |
| :-- | :-- | :-- |
| **V0 Land and look** | R2 green and published (P1); one phone session covers P2–P6 (checklist in §5) | S |
| **V1 Toolchain v2** | AGP 9.1, compileSdk 37, Compose BOM ≥ 2026.08, activity ≥ 1.12, core ≥ 1.17, Navigation 3, lifecycle-viewmodel-compose, `kotlinx-coroutines-test`; nothing else in the commit. APK size and R8 check (P7) | M |
| **V2 Screenshot baseline** | Roborazzi; the main screens in both themes at two widths; a CI job with diff upload | S |
| **V3 Owners for background work** | §3.1 for chat send/stream/stop, the catalogue, images and builds SSE; an event channel for notices and handoffs; coroutine tests; `io.execute` count reported (target under 15); P11 while `PuterBridge` is open | L |
| **V4 Navigation and home** | Navigation 3; the dock with the orb; Chat, Create, Agents and Activity; Settings on the avatar; the home screen with suggestion tiles and continue cards (rebrand R5); Go anywhere; predictive back with preview; list–detail on wide screens | L |
| **V5 Motion and message anatomy** | Shared elements on the four journeys in §2.2; send ↔ Stop morph; text reveal; Reasoning, tool cards, sources, actions and context meter (rebrand R4); the agents gallery (rebrand R5) | L |
| **V6 The futuristic layer** | Glass dock, composer and sheets (blur on API 31+, translucent fill below); the AI edge glow; voice aurora and waveform pill (AGSL on API 33+, today's orb below); battery and off-screen guards; still states for Remove animations | M |
| **V7 System surfaces** | Android 16 Live Updates (`ProgressStyle`) for a streaming reply and a running build, with a normal progress notification below 16; Approve on a build notification, behind device unlock; P8 Puter browser sign-in if you want it by then | M |
| **V8 Generative UI and canvas** | The ` ```ui ` block (rebrand R6, an A2UI subset: choices, form, date/time, table, chart, card) drawn with native components and never running code; long output in a canvas sheet with versions (rebrand R7) | L |

### 4.1 Shipped (2026-09-23)

One commit per phase on `main`; each compiled on its first CI run. "Left" is
what the row above asked for and the phase did not do.

| Phase | Commit | Shipped | Left |
| :-- | :-- | :-- | :-- |
| V1 | `014b6d1`, `39f35f5` | AGP 9.4.0 / Gradle 9.6 (builds Kotlin itself), compileSdk 37, targetSdk 36, BOM 2026.09.00, Navigation 3, lifecycle 2.11, coroutines-test; R8 now shrinks app code (P7) | — |
| V2 | `59585a1`, `cbfeae0` | Roborazzi on Robolectric (SDK 35); baselines in the Actions cache; `[screenshots]` in a commit message records them; a contact sheet at the end of the build log; tablet shots of the chat, a space and the ui blocks | The two-pane chat itself (it needs a live view model) |
| V3 | `8c8dc9a`, `5581c72` | Notices through a `Channel`; replies and the build stream as cold flows (`data/Streams.kt`: cancelling closes the connection; builds reconnect from the last event); every job on `viewModelScope`, 0 `io.execute` (target under 15); Stop ends a Puter wait too; `CancellationException` rethrown | The data layer stays blocking by design (§3.1) |
| V4 | `09d451e`, `d13c935` | Navigation 3 back stack; the dock with the orb; Chat, Create, Agents, Activity; home with greeting and Continue cards; Go anywhere; from 840 dp the chat list stands beside the chat | — |
| V5 | `4b299e1`, `cbfeae0` | "Thought for 12 s", streaming caret, source chips, context meter; send ↔ Stop morph; shared titles, and a build card that grows into the build page with its status pill; the agents gallery | The other §2.2 journeys open inside one page or switch tabs, so there is no page transition for them to ride |
| V6 | `274e8f6`, `d13c935` | Glass surfaces (translucent); AI edge glow; voice aurora (AGSL on API 33+); the voice waveform pill; still under Remove animations or battery saver | Blur behind glass, **decided against**: nothing scrolls behind the dock or composer, so it would blur a plain background |
| V7 | `438cdac`, `d13c935`, P8 | "Replying…" and a followed running build as Live Updates (`ProgressStyle`, promoted ongoing; the build's shows its step and a bar of steps done); Approve on a build's notification, behind the device unlock | — |
| V8 | `70fb4dc`, `d13c935`, `cbfeae0` | ` ```ui ` blocks (choices, form with Material date and time pickers, table, card, chart; data only, checked against fixed limits) drawn natively, latest reply only; "Open in canvas" for long replies, stepping through the chat's replies and each reply's versions (Regenerate keeps up to four earlier answers, never sent to a model) | — |

`6e78972` made screenshots stable: they are taken with animations off, and entrances
now honour "Remove animations" too.

**Perf/security/a11y batch** (`0f2a9e6`, `50c10db`, `a30625f`, `f42ab7b`, `a198ac0`,
opencode, after P8/P11): Keystore key caching, durable atomic sealed writes,
`device_snapshot` moved from auto-run to a confirmed approval, `signOut` now clears
the previous account's outbox and response cache unconditionally, cleartext HTTP
refused for any private address instead of silently failing, `@Stable` plus a
`currentChat`/`conversationIndex` boundary to stop the whole chat screen recomposing
on every streaming publish, and an accessibility/touch-target pass. Reviewed and
fixed (see the next entry) rather than reverted.

**Review fix batch** (build 245, this session): five bugs found reviewing the batch
above, all fixed. (1) `tap_text`/`scroll_until` compared the foreground app against
itself at the moment Approve is tapped -- always NeuraOS -- so every device action was
silently cancelled; now compares against `DeviceControlService.lastOtherPackage`, the
app actually in front before the switch. (2) `delete()` and `newChat()` patched only
the touched id in `conversationIndex` after a removal that shifts every later chat's
position, risking a crash or a save landing on the wrong chat; both now call a shared
`rebuildConversationIndex()` (new, unit-tested in `ConversationIndexTest`). (3)
`signedIn` was assigned after the full disk load instead of right after its own two
Keystore reads, and a stray main-thread cookie sync ran before the pooled `work{}`
block even started -- both flashed the sign-in screen on a cold start; fixed. (4) An
approved `device_snapshot`'s screen text was appended as a plain user message, so a
malicious app on screen could have its own text read back to the model with the
user's authority; now fenced and labelled as untrusted screen content. (5) The
streaming draft's periodic save (`STREAM_PERSIST_MS`) and the end-of-turn save could
race and let the stale one land last; both now go through `CoalescingSaver` (new,
`CoalescingSaverTest`), which keeps only the newest queued write per chat and never
runs two for the same chat at once.

**Why this order.** V1 first because V4–V6 need its APIs, and a toolchain bump must
travel alone. V2 before any visual change, so every later phase has a before picture.
V3 before V4, so the new screens are born with owners instead of inheriting
callbacks. V6 after V5, because effects decorate transitions that must already be
right.

---

## 5. What is needed from you

**One phone session** (Android 16, about 20 minutes), once V0 publishes:

1. Install the new APK from `apk-latest`.
2. Look at the launcher icon; turn on themed icons and look again.
3. Settings → App → Theme: try Light, then System, then Dark again.
4. Open any page and swipe back slowly: does a preview appear? (P2)
5. Open a chat, tap the message box: does anything hide behind the keyboard?
6. Ask a long question, switch to another app for a minute, come back: has the reply finished?
7. Automate → calendar → schedule a prompt 3 minutes ahead; tap the notification when it comes.
8. Turn on airplane mode, send a message, then Settings → App → **Copy diagnostics**
   and paste the text to me (it also carries the cold-start number, P3).

**Three decisions** (the bold default is used unless you say otherwise):

- The dock: **Chat · Create · orb · Agents · Activity**, with Settings on the avatar.
- Screenshot tests as a **test-only** dependency (nothing added to the APK).
- The **AGP 9.1 / compileSdk 37** bump in V1.

---

## 6. Decisions still in force (from v1)

- **No on-device LLM** (2026-09-22): the response cache is the offline story.
- **Sideloaded, not the Play Store** (2026-09-22): device control fits sideloading
  and not a Play listing.
- **No React Native rewrite, no new backend services, no metered APIs**, no symptom
  checker, no smart-home control (v1 §1 has the reasons).
- **No dynamic colour**: it would replace the brand's violet with the wallpaper's.
- Large files are split only along seams a phase needs (§3.1), with `safe-refactor`.

## Sources

Navigation: [Navigation 3 releases](https://developer.android.com/jetpack/androidx/releases/navigation3) ·
[Announcing Navigation 3](https://android-developers.googleblog.com/2025/05/announcing-jetpack-navigation-3-for-compose.html) ·
[Shared elements with navigation](https://developer.android.com/develop/ui/compose/animation/shared-elements/navigation) ·
[Predictive back setup](https://developer.android.com/develop/ui/compose/system/predictive-back-setup)

Compose and Material: [Compose August '26 release](https://android-developers.googleblog.com/2026/08/jetpack-compose-august-2026-release.html) ·
[Compose Material 3 releases](https://developer.android.com/jetpack/androidx/releases/compose-material3) ·
[M3 Expressive motion](https://m3.material.io/blog/m3-expressive-motion-theming)

Android 16: [Features and APIs](https://developer.android.com/about/versions/16/features) (ProgressStyle, Live Updates, AGSL `RuntimeColorFilter`) ·
[Live Updates at JET](https://medium.com/justeattakeaway-tech/live-updates-and-progress-notifications-for-android-16-at-jet-b0c87eab17b4)

Design references: [Gemini Live's refreshed UI](https://www.sammyfans.com/2026/05/14/google-quietly-refreshing-gemini-live-with-new-interactive-ui/) ·
[UI/UX trends for AI apps 2026](https://www.groovyweb.co/blog/ui-ux-design-trends-ai-apps-2026) ·
the open-source AI apps surveyed in [rebrand plan §2](neuraos-rebrand-plan.md)
