---
paths:
  - "android/**"
---

# Android app rules

- Kotlin 2.0, AGP 8.7, Compose BOM 2024.12, minSdk 29, targetSdk 35. No Hilt, no Room, no Retrofit: org.json, HttpURLConnection, executors + a main-thread Handler.
- Screen state: `ui/AppViewModel.kt` with Compose `mutableStateOf`; write state only on the main thread (`main.post`).
- Pure logic goes in `data/` (no Android imports) so JVM tests in `android/app/src/test` cover it. Add tests there for new logic.
- Storage: chats, images and the library are sealed with the Keystore AES-GCM key (`data/Storage.kt`); secrets with `SecureStore`. Never log chat text or secrets.
- WebViews: no JavaScript bridge, origin checks on navigation, no file/content access. Phone actions only run after the user taps.
- New permissions must be justified; runtime ones are asked in context, never at launch.
- Material icons: import each `androidx.compose.material.icons.filled.X` explicitly (a missing import is the most common CI failure).
- Every `when` over `ChatEvent` must handle every branch.
- Verify by pushing and reading the Android run (`gh-fix-ci` skill); the build number is the run number + 100.
