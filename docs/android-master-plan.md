# NeuraOS APK — master refinement plan

[← Back to README](../README.md)

Status of this document: **plan only**, except where a phase is marked done.
Written against `aa9e6bf`, 2026-09-22. Revised 2026-09-22 after Phases 0 and 1
shipped and a real-device bug hunt changed what the next phase should be (§2.4).

Goal in one sentence: **make the APK feel like a shipped product on a 2026 phone,
close the Android debt already written down in [BACKLOG.md](BACKLOG.md), and add
only the capabilities a phone is the right place for.**

What the app *is* lives in [The Android app](android.md); this page owns only what is
still to be done and why. Open items keep their `NEURA-0xx` IDs from the backlog.

---

## 0. Where the APK stands (evidence, not impressions)

| Fact | Value |
| :-- | :-- |
| Native source | 62 Kotlin files, ~12,150 lines under `android/app/src/main` |
| Largest units | `AppViewModel.kt` 1,565 · `NativeActivity.kt` 1,115 · `MainScreen.kt` 1,000 |
| Unit tests | 12 JVM test classes |
| E2E | 5 Maestro flows: 2 run in CI, 3 tagged `needs-provider` and run against a real engine |
| CI | Android run #114 green on `main` (`34d61e9`): build → smoke → publish |
| Toolchain | AGP 8.13.2 · Kotlin 2.3.21 · Compose BOM 2026.06.01 · Gradle 8.14.5 |
| SDK | compileSdk 36 · targetSdk 36 · minSdk 29 |
| Release | `versionCode` = run number + 100, `versionName` 2.0.x, rolling `apk-latest` |

The toolchain and SDK rows are Phase 1's result, not the starting point; the
counts above are from the original survey and drift slowly.

**The agent loop already exists.** `data/Agent.kt` dispatches `web_search`,
`web_fetch`, `task_list`/`task_add`/`task_update`, `generate_image`, `phone_action`,
`device_snapshot`, and in Build mode `file_list`/`file_read`/`file_write`/`file_patch`
— capped at `MAX_TOOL_ROUNDS = 8` and `MAX_TOOL_STEPS_PER_TURN = 12`, with
`ToolApproval.CONFIRM` gating every write and every phone action.

**The sandbox is structural, not prompt-deep.** `data/Workspace.kt` is pure Kotlin —
no `java.io`, no `java.nio`, no `android.*` — and `RatchetTest` fails the build if
that stops being true.

### The honest gaps

1. ~~**No adaptive icon.**~~ **Closed in Phase 0** — `mipmap-anydpi-v26` with
   foreground, background and monochrome layers.
2. ~~**The toolchain is ~20 months old.**~~ **Closed in Phase 1** — see the table
   above. Took three tries (runs #110–#113); §2.1 records what it cost.
3. **Failures do not name their cause.** Promoted to a gap of its own by §2.4, and
   the reason Phase 2 now leads with it.
4. **No offline answers.** `data/Outbox.kt` is an offline *retry queue*: it remembers
   which chat is owed a reply and re-asks when the network returns. There is no
   response cache.
5. **Desktop-vs-Android drift** (NEURA-039): MCP Apps, scheduled recipes and Evals
   history exist on desktop, not on the phone.
6. ~~**Dead `leakcanary` entry** in `libs.versions.toml`.~~ **Closed in Phase 0.**

---

## 1. Scope: what this plan refuses, and why

This plan was commissioned alongside a generic "AI app" feature list. Most of that
list is already shipped — voice in and out (`VoiceSession.kt`), image understanding
(`ImageIntelligence.kt`), file attachments, the tool-calling framework, the sandbox,
AES-256-GCM sealing, permission gating, adaptive layout. The rest is refused here so
it does not get re-proposed:

| Proposed | Why not |
| :-- | :-- |
| **React Native rewrite** | Discards ~12,150 lines of working Kotlin/Compose and with it the Keystore sealing, `FLAG_SECURE`, the R8 config and the `RatchetTest` guarantee. Buys nothing the app lacks. |
| **MongoDB / PostgreSQL / Redis / S3** | The engine is a zero-dependency Node server on a free tier. See CLAUDE.md. |
| **Firebase for auth and storage** | Auth exists: server login gate, sealed password, 7-day session with silent re-auth. FCM is already optional and correctly so. |
| **Twilio SMS · AWS Polly · Google Cloud Vision** | All metered; the project uses official free tiers only. The phone's own TTS/STT is free *and* more private, and vision is already solved twice over. |
| **TensorFlow Lite for on-device LLMs** | Wrong tool and a stale name — and moot now, see §2.2. |
| **Jest + Detox** | New dependency trees replacing `node:test`, JUnit and Maestro, which all work. |
| **ASO / marketing / revenue streams** | There is no store listing to optimise, by decision — see §2.3. |
| **Symptom checking (health)** | The FDA's January 2026 revision of its Clinical Decision Support guidance sharpened the exemption around software supporting *a clinician's* review rather than a patient's own decisions; a patient-facing checker driving time-critical action falls outside it, and 2026 product-liability commentary treats clinician review and a documented safety case as the baseline. A free sideloaded app has neither. General health questions are answered like any other topic; no symptom-checker surface is built. |
| **Smart-home control** | Per-vendor cloud APIs and stored credentials — against the free-tier rule and a large new attack surface. |

Also refused: restructuring `AppViewModel.kt`, `NativeActivity.kt` or `MainScreen.kt`
merely because they are large. Per CLAUDE.md, a new function plus a thin hook beats
restructuring a shared file. If one becomes genuinely unworkable during a phase, that
split gets its own `safe-refactor` pass with tests either side — never a drive-by.

---

## 2. Four findings that shaped the plan

### 2.1 Android 16 / API 36 is the deadline-shaped work

At targetSdk 36:

- **Edge-to-edge stops being optional** — `windowOptOutEdgeToEdgeEnforcement` is
  deprecated and disabled. *NeuraOS is already adapted*: `NativeActivity.kt` calls
  `enableEdgeToEdge` and wraps content in `safeDrawingPadding()`; `MainScreen.kt` uses
  `consumeWindowInsets` + `imePadding`.
- **Predictive back is mandatory** — the system stops calling
  `Activity.onBackPressed()` and stops dispatching `KEYCODE_BACK`. The manifest
  already sets `enableOnBackInvokedCallback="true"`.
- **Foreground service types are enforced** — a mismatched or undeclared type crashes
  or ANRs. `ReplyService` declares `dataSync` and starts only from the foreground,
  which is the compliant shape.

Google Play's own target-36 deadline does not bind a sideloaded APK, but these are
*runtime* behaviour changes that bind on any Android 16 phone regardless of where the
APK came from. Because the app looks pre-adapted, the cost here is mostly
verification — which is exactly why it is worth doing early and alone.

### 2.2 Offline inference: decided against (2026-09-22)

The route would have been LiteRT-LM or llama.cpp with GGUF, not TensorFlow Lite. Size
decides the design: Gemma 3 270M is ~125 MB quantized at roughly 22 tok/s, Gemma 3 1B
is ~529 MB. Neither can be bundled in an APK served from a GitHub release, so offline
would mean a user-initiated download plus a chat-only local mode (a 270M-class model
cannot drive an approval-gated tool loop safely).

**Decision: not building it.** The phone is rarely without signal, so the response
cache in Phase 3 is the whole offline story. Revisit only if the cache ships and
proves insufficient.

### 2.3 Device control vs. the Play Store: decided (2026-09-22)

Two 2026 developments land on `DeviceControlService`:

- **Android 13+ already blocks accessibility services for sideloaded apps** behind the
  "Restricted setting" flow, which the app documents and, as of `7faa151`, guides the
  user through.
- **Google Play's accessibility policy tightened with enforcement from 28 January
  2026**: an app using AI to read the screen and tap buttons on the user's behalf no
  longer qualifies, and a general assistant does not become an accessibility tool
  merely because it could help someone with a motor impairment.

This app's implementation is about as defensible as the category gets — labelled
elements only, never a screenshot, never a raw coordinate, every action approved by a
tap, off by default. That does not change the conclusion: **device control is
compatible with sideloading and incompatible with a Play listing.**

**Decision: stay sideloaded and keep device control.** The Play Store is not a goal.
Distribution stays the rolling `apk-latest` release, and "put it on Play" is not an
option this plan keeps open.

### 2.4 The app cannot be debugged from a phone (2026-09-22)

This is the finding that changed the plan, and it came from trying to fix one bug.

Puter sign-in has now failed on a real device across four attempts. Every report
came back as the same sentence — *the button animates, no window appears* — and
that sentence turned out to be the observable symptom of at least four unrelated
causes: `js.puter.com` never arriving, arriving and throwing during its own setup,
`window.open()` never being called, and `window.open()` being called and refused
by the WebView. The app recorded none of them. Each attempt could only narrow the
field by guessing, shipping, and waiting for the next screenshot.

The failure messages were the problem. `"timed out"`, `"Puter did not load"` and
`"Puter failed"` are the three strings that path can produce, and none of them
distinguishes a network failure from a WebView setting from an SDK bug. Under
`setWebContentsDebuggingEnabled(false)` — correct for a shipped app — there is no
other channel: no remote inspector, no logcat the user can reach, nothing.

**This generalises well past Puter.** The same shape is everywhere in the app:
a provider that answers `502`, a tool call that returns nothing, a `ReplyService`
that dies in the background, an Outbox entry that never drains. Each has a short
generic message and no way for the user to hand back the one fact that would name
the cause. Every one of those is a round trip, and on a sideloaded app each round
trip is a full CI build, a release, and a manual install.

**Decision: the next phase is diagnosability, ahead of new surfaces.** A feature
that cannot report why it failed is not finished, and the app has reached the size
where that is the binding constraint on fixing anything. `3e00ee5` is the first
instalment — the bridge page now reports the SDK's load state, whether a window was
ever requested, whether storage works, and attaches that to the failure message —
and Phase 2 generalises the pattern rather than leaving it as one page's fix.

The alternative was to keep guessing, which has a measured cost: four builds and
four installs so far, and the bug is still open.

**How it actually ended (2026-09-23), and why it proves the decision.** No guess
found it; looking did. A debug build with `chrome://inspect` access (`769bf1e`, debug
variant only) plus one request typed into a browser tab produced two root causes in
an hour, after four blind rounds had produced none:

1. **The bridge page answered `401`.** It sits behind the server's login gate, and
   the app's login is native: the session cookie travelled as a header on the app's
   own HTTP calls and never reached WebView's cookie jar. Every symptom — `puter`
   undefined, no window, even the new diagnosis missing — was the 401 error body
   loading in place of the page. Fixed in `2174ecb` (the session is synced into
   `CookieManager` on sign-in, silent re-auth, sign-out, and once at start).
2. **Puter opens its window only from a real tap.** Its `signIn()` checks
   `hasUserActivation()`; a call through `evaluateJavascript` has none, so Puter
   showed its consent prompt *inside* a 1×1 invisible page. The fix makes the page
   full-screen for the sign-in with its own Continue button, whose tap calls Puter.
   `fa4uDiagnose()` reported `opened: 0` — the probe added for exactly this.

The general rule this leaves for Phase 2: an embedded page must be inspectable in a
debug build, and anything that needs a user gesture must get one from the page itself.

---

## 3. The phases

Five phases. Each is independently shippable. Phases 0 and 1 are done; Phase 2 is
new, inserted ahead of the polish work that used to hold that number, for the
reason §2.4 gives.

**Every phase's stop condition is the same three facts:** `gradle :app:testDebugUnitTest`
green, the Android CI run green end to end (build → smoke → publish), and `apk-latest`
carrying the new `versionCode`. A green build is not runtime proof — anything only CI
proved is reported as such, with the check that would confirm it on a real phone.

**Verification note.** There is no local Android SDK, and `android.yml` and `ci.yml`
both trigger on `main` only. Work on a branch is verified by dispatching `android.yml`
against that branch (`workflow_dispatch`), not by a local build.

### Phase 0 — Close the written-down debt · **done**

| Item | Work | State |
| :-- | :-- | :-- |
| NEURA-004 | Adaptive icon: `mipmap-anydpi-v26` with foreground and background layers plus a `monochrome` layer for themed icons. | **done.** Built from the existing vector, art scaled to the 72dp safe zone. The emblem below replaces the foreground layer alone when it arrives. |
| NEURA-020 | The three provider-dependent flows carry `needs-provider`; `maestro-smoke.sh` runs `--exclude-tags=needs-provider`. | **was already done** in `fbbe32a`; the stale backlog row is corrected. |
| NEURA-040 | `TODO(NEURA-xxx)` markers at the Android code sites, plus the test that every marker names an open ID. | **done** — by the desktop session's `test/backlog.test.js`, which scans every source including Android; Phase 2 added `test/android-backlog.test.js` so Android also carries no bare TODO. |
| cleanup | Drop the dead `leakcanary` entry from `libs.versions.toml`. | **done.** |

### Phase 1 — Modern toolchain and Android 16 · **done**

AGP 8.13.2 · Kotlin 2.3.21 · Compose BOM 2026.06.01 · Gradle 8.14.5, compileSdk and
targetSdk 36, with `platforms;android-36` / `build-tools;36.0.0` in `android.yml`.
CI moved to Node 24 in the same pass.

**It took three tries, and the reason is worth keeping.** Run #110/#111 failed on
`kotlinOptions.jvmTarget`, deprecated at Kotlin 2.0 and a hard error at 2.3. Run
#112 then failed on Compose BOM 2026.09.00, which pulls Compose 1.12.1 and requires
AGP 9.1 / compileSdk 37 — two version choices made independently that turned out
mutually incompatible. BOM 2026.06.01 is the last release before that boundary.

**The lesson, recorded because it will recur:** a version matrix cannot be verified
by reading a `.toml`. Only a Gradle resolution proves it, and there is no local
Android SDK here, so each attempt costs a full CI round trip. Bump the four pins
*together and alone*, exactly as this phase did — that is what made each failure
bisectable in one run instead of ambiguous across a mixed commit.

**Still owed (needs a real Android 16 phone; CI's emulator is API 29 and cannot
prove any of it):** predictive back through every screen, edge-to-edge with the
keyboard open, `ReplyService` surviving a long streaming reply in the background,
and the release APK size before/after with an `r8-analyzer` pass on
`proguard-rules.pro`.

### Phase 2 — Nothing fails silently · **done**

New phase, and the highest-value one in this document. §2.4 is the argument; this
is the work. The principle: **every failure the user can see must carry the one
fact that names its cause**, and that fact must be copyable off the phone.

1. **A diagnostics surface in Settings — ported, not invented.** The desktop
   already has exactly this: `desktop/src/diagnostics.js` builds a copyable report
   and `test/desktop-diagnostics.test.js` asserts both halves of the contract —
   *"it has to say enough to find the problem, and contain nothing they would
   regret pasting."* Android has no equivalent, which is a second instance of the
   NEURA-039 drift and the one that hurts most. Mirror the desktop's field list
   where it applies (version, engine URL, sign-in state, shell, OS) and add the
   phone's own: `versionCode`, which providers are configured and their last
   status, Outbox depth, whether device control is enabled, the last few failures
   with timestamps. Nothing sealed, no chat text, no keys, no tokens — the same
   discipline `/api/health` already follows on the server, and the same discipline
   the desktop test already enforces. Port that test alongside it.
2. **A bounded in-memory failure ring.** The last ~50 failures as (when, where,
   short reason), in RAM only, never sealed to disk and never logged. It feeds the
   screen above and nothing else.
3. **Audit every terminal failure message for a bare string.** `"timed out"`,
   `"Puter did not load"`, `"Puter failed"`, `"not signed in"`, `"no WebView"` and
   their siblings across the provider, tool, WebView and service paths. Each either
   names what was being attempted and what came back, or it is a bug. `3e00ee5` did
   this for one file; this generalises it.
4. **Make the WebView paths self-reporting by construction.** `fa4uDiagnose()` is
   the pattern: a probe defined ahead of anything that can throw, reporting the
   state of the things that actually break (subresource load, window creation,
   storage). Any future embedded page gets one.

5. **NEURA-040**, carried forward from Phase 0 and a natural fit here: `TODO(NEURA-xxx)`
   markers at the Android code sites plus the test that every marker names an open
   ID. Same principle at source level — a known gap that does not say which one it
   is costs a search every time someone meets it.

**Shipped (2026-09-23):** `data/Diagnostics.kt` (report + redaction + the ring, 7 JVM tests) · Settings → App → **Copy diagnostics** · failures recorded at the io guard, every chat turn that ends in an error, images, the provider catalogue, Puter sign-in and Puter images, GitHub connect and remote builds · the bare Puter messages ("no WebView", "timed out", "no picture", "Puter failed") now say what was being tried and for how long · item 4 was already true of the only embedded page (§2.4) · item 5 done as above. Still owed: the stop condition below, on a real phone.

**Stop condition, in addition to the usual three:** take one real failure — a
provider turned off, airplane mode, a bad server URL — and confirm the copied block
names it without a follow-up question.

**Why this one is worth a phase.** It is the only item in this document that makes
every *other* item cheaper. Phases 3, 4 and 5 all ship features that can fail on a
phone nobody here can attach a debugger to, and each will otherwise repeat §2.4's
four-round-trip pattern. It also has the shortest path to done: the desktop already
solved it and the port is mostly field selection.

### Phase 3 — "Shipped product" polish · **done**

1. **Cold start budget.** Measure it, write the number down, set a target. The desktop
   has this discipline (NEURA-035); Android has no number at all.
2. **Outbox visibility.** The retry queue works but is invisible. Surface "queued, will
   retry" on the chat it belongs to, so a failed turn reads as pending, not lost.
   Phase 2's Outbox depth makes this cheap — the state is already being read.
3. **Response cache.** Answers cached by (model, mode, normalised prompt), sealed like
   chats, opt-in, with an obvious "cached" marker and a one-tap re-ask. Per §2.2 this
   is the entire offline story, so it carries that weight deliberately.

**Shipped (2026-09-23):** (1) cold start is measured — process start to the first frame, once per fresh launch — and reported by Copy diagnostics against the 2 s target; the number itself needs a real phone. (2) a queued chat shows why and when above its composer ("Tried 2 times. Next try in 3 s…"), with Retry now. (3) **Offline answers**, off by default (Settings → Data): answers kept sealed on the phone, keyed by model, mode and every question in the chat; on a lost connection the kept answer is shown marked "cached, refreshes when online" and the chat stays queued for a fresh reply. Turning it off, Delete all chats and Erase all delete what was kept.

### Phase 4 — The surfaces worth adding

In recommended order:

1. **PR review from the phone.** The 2026 mobile-coding pattern is supervision, not
   editing: prompt, review the diff, approve. NeuraOS's Remote builds screen already
   *is* that pattern, and the GitHub connection already exists (Custom Tabs handoff,
   up to 3 accounts) — so "review this PR from my phone" is a short hop and the
   highest-value new surface in this document.
2. **Plan → diagram viewer.** Plan mode already keeps a task list; render it as a
   read-only radial map in Compose Canvas. No dependency. A viewer, not an editor.
3. **Voice transcript actions.** Translate and Summarise on a transcript — a thin
   layer over voice mode, high visibility. Speaker diarization is out of reach
   on-device and not worth a cloud dependency.
4. **One chart from one attached file.** Bar/line/scatter in Compose Canvas from a
   model-returned spec. No dependency.
5. **Library content, not code.** Tutoring, code-review and content-tone personas and
   prompts. The Library already holds these; this is an idle hour, not a phase.

### Phase 5 — Desktop parity, triaged (NEURA-039)

- **Scheduled recipes → yes**, as WorkManager plus an approval notification, matching
  NEURA-036's posture: a scheduled recipe *asks* rather than refusing.
- **MCP Apps → partial**, viewer only if at all.
- **Evals history → no.** Desktop-shaped; a phone is the wrong place to read it.

---

## 4. What is needed from you

**The emblem** — one PNG at `assets/branding/neuraos-logo.png`, emblem only, no text,
no background, square, at least 512×512 (NEURA-004). Phase 0 shipped a correct adaptive
icon built from the existing vector without it; the emblem then replaces the
foreground layer alone.

**One Android 16 phone session**, to close Phase 1's outstanding runtime checks
(predictive back, edge-to-edge with the keyboard up, `ReplyService` under a long
streaming reply). CI cannot prove any of the three.

**Puter sign-in, once more, on the build with the Continue prompt.** Settings →
Sign in to Puter → Continue → Puter's own window. Both root causes in §2.4 are fixed;
this one tap on a real phone is the only proof left.

Nothing else is blocking. The offline and Play Store questions were settled on
2026-09-22 (§2.2, §2.3).

## Sources

On-device inference: [LLM Inference guide for Android](https://developers.google.com/edge/mediapipe/solutions/genai/llm_inference/android) ·
[Gemma 3 on mobile and web](https://developers.googleblog.com/gemma-3-on-mobile-and-web-with-google-ai-edge/) ·
[Gemma 3 270M guide](https://www.datacamp.com/tutorial/gemma-3-270m) ·
[MediaPipe vs llama.cpp vs ExecuTorch](https://meetprajapati.com/blogs/running-on-device-ai-models-android-mediapipe-llamacpp-executorch/)

Android 16: [Behavior changes for apps targeting Android 16](https://developer.android.com/about/versions/16/behavior-changes-16) ·
[Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)

Accessibility policy: [Use of the AccessibilityService API](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en) ·
[Play accessibility policy update 2026](https://myappmonitor.com/blog/google-play-accessibility-services-policy-update) ·
[Android 13 sideloading restriction](https://www.esper.io/blog/android-13-sideloading-restriction-harder-malware-abuse-accessibility-apis)

Health: [FDA limits oversight of AI health software](https://telehealth.org/news/fda-clarifies-oversight-of-ai-health-software-and-wearables-limiting-regulation-of-low-risk-devices/) ·
[Product liability implications of AI health tools](https://www.druganddevicelawblog.com/2026/04/guest-post-%E2%88%92-ai-enters-the-exam-room-product-liability-implications-of-ai-health-tools.html)

Feature research: [Mobile AI coding tools 2026](https://codepick.dev/en/guides/mobile-ai-coding-tools-2026/) ·
[Codex on phones](https://techcrunch.com/2026/05/14/openai-says-codex-is-coming-to-your-phone/) ·
[Best mind mapping apps 2026](https://www.taskade.com/blog/best-mind-mapping-apps) ·
[Otter.ai vs Whisper 2026](https://get-whisper.com/blog/otter-ai-vs-whisper) ·
[Julius AI guide 2026](https://aitoolradar.io/guides/julius-ai)
