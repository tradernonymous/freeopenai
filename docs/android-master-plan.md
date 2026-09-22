# NeuraOS APK — master refinement plan

[← Back to README](../README.md)

Status of this document: **plan only**, except where a phase is marked done.
Written against `aa9e6bf` on `claude/epic-hamilton-p8m5ro`, 2026-09-22.

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
| CI | Android run #108 green on `main` (`7faa151`): build → smoke → publish |
| Toolchain | AGP 8.7.3 · Kotlin 2.1.0 · Compose BOM 2025.01.01 · Gradle 8.10.2 |
| SDK | compileSdk 35 · targetSdk 35 · minSdk 29 |
| Release | `versionCode` = run number + 100, `versionName` 2.0.x, rolling `apk-latest` |

**The agent loop already exists.** `data/Agent.kt` dispatches `web_search`,
`web_fetch`, `task_list`/`task_add`/`task_update`, `generate_image`, `phone_action`,
`device_snapshot`, and in Build mode `file_list`/`file_read`/`file_write`/`file_patch`
— capped at `MAX_TOOL_ROUNDS = 8` and `MAX_TOOL_STEPS_PER_TURN = 12`, with
`ToolApproval.CONFIRM` gating every write and every phone action.

**The sandbox is structural, not prompt-deep.** `data/Workspace.kt` is pure Kotlin —
no `java.io`, no `java.nio`, no `android.*` — and `RatchetTest` fails the build if
that stops being true.

### The honest gaps

1. **No adaptive icon.** `res/drawable/ic_app.xml` is a single 108dp vector. There is
   no `mipmap-anydpi-v26`, no foreground/background split, no monochrome layer — so
   every launcher since Android 8 shows the mark unmasked, and Android 13+ themed
   icons have nothing to use. This is NEURA-004 and it is the most visible
   "not a shipped product" tell.
2. **The toolchain is ~20 months old**, and targetSdk 35 predates the Android 16
   behaviour changes. See §2.1.
3. **No offline answers.** `data/Outbox.kt` is an offline *retry queue*: it remembers
   which chat is owed a reply and re-asks when the network returns. There is no
   response cache.
4. **Desktop-vs-Android drift** (NEURA-039): MCP Apps, scheduled recipes and Evals
   history exist on desktop, not on the phone.
5. **`libs.versions.toml` carries a dead `leakcanary` entry** for a dependency removed
   in `a4201b9`.

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

## 2. Three findings that shaped the plan

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

---

## 3. The phases

Four phases. Each is independently shippable.

**Every phase's stop condition is the same three facts:** `gradle :app:testDebugUnitTest`
green, the Android CI run green end to end (build → smoke → publish), and `apk-latest`
carrying the new `versionCode`. A green build is not runtime proof — anything only CI
proved is reported as such, with the check that would confirm it on a real phone.

**Verification note.** There is no local Android SDK, and `android.yml` and `ci.yml`
both trigger on `main` only. Work on a branch is verified by dispatching `android.yml`
against that branch (`workflow_dispatch`), not by a local build.

### Phase 0 — Close the written-down debt

| Item | Work |
| :-- | :-- |
| NEURA-004 | Adaptive icon: `mipmap-anydpi-v26` with foreground and background layers plus a `monochrome` layer for themed icons. Buildable now from the existing vector; the emblem you supply later replaces the foreground without touching the wiring. |
| NEURA-020 | **Already done** in `fbbe32a` — the three provider-dependent flows carry `needs-provider` and `maestro-smoke.sh` runs `--exclude-tags=needs-provider`. The backlog row is stale and gets corrected. |
| NEURA-040 | `TODO(NEURA-xxx)` markers at the Android code sites, plus the test that every marker names an open ID and closed IDs leave none. |
| cleanup | Drop the dead `leakcanary` entry from `libs.versions.toml`. |

### Phase 1 — Modern toolchain and Android 16

1. Bump AGP, Kotlin, Compose BOM and Gradle together, to versions that are mutually
   compatible and support compileSdk 36.
2. compileSdk/targetSdk 36, and the matching `platforms;android-36` /
   `build-tools;36.0.0` in `android.yml` (it currently pins 35).
3. Verify on a real Android 16 phone: predictive back through every screen,
   edge-to-edge with the keyboard open, `ReplyService` surviving a long streaming
   reply in the background. CI's smoke emulator is API 29 and cannot prove any of it.
4. Record the release APK size before and after as a tracked number, and run an
   `r8-analyzer` pass on `proguard-rules.pro` while the toolchain is moving.

**Why alone:** every later phase builds on this toolchain, and a bump done by itself
is a bump you can bisect.

### Phase 2 — "Shipped product" polish

1. **Cold start budget.** Measure it, write the number down, set a target. The desktop
   has this discipline (NEURA-035); Android has no number at all.
2. **Outbox visibility.** The retry queue works but is invisible. Surface "queued, will
   retry" on the chat it belongs to, so a failed turn reads as pending, not lost.
3. **Response cache.** Answers cached by (model, mode, normalised prompt), sealed like
   chats, opt-in, with an obvious "cached" marker and a one-tap re-ask. Per §2.2 this
   is the entire offline story, so it carries that weight deliberately.

### Phase 3 — The surfaces worth adding

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

### Phase 4 — Desktop parity, triaged (NEURA-039)

- **Scheduled recipes → yes**, as WorkManager plus an approval notification, matching
  NEURA-036's posture: a scheduled recipe *asks* rather than refusing.
- **MCP Apps → partial**, viewer only if at all.
- **Evals history → no.** Desktop-shaped; a phone is the wrong place to read it.

---

## 4. What is needed from you

**The emblem** — one PNG at `assets/branding/neuraos-logo.png`, emblem only, no text,
no background, square, at least 512×512 (NEURA-004). Phase 0 ships a correct adaptive
icon built from the existing vector without it; the emblem then replaces the
foreground layer alone.

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
