---
name: r8-analyzer
description: "R8/ProGuard rule review. Use when changing android/app/proguard-rules.pro, minify settings, or when a release build crashes or bloats after shrinking."
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-08-28'
  keywords:
  - R8
  - proguard
  - keep rules
  - app size
  - optimization
---

## Step 1. Setup and configuration check

- Inspect `build.gradle`, `build.gradle.kts`, and `gradle.properties`.
- Use [references/CONFIGURATION.md](references/CONFIGURATION.md) to identify missing optimizations.
- **AGP** : If version is lower than 9.0, suggest migration to 9.0 for [build-time performance improvement](references/android/topic/performance/app-optimization/enable-app-optimization.md).
- **Full Mode** : Verify `android.enableR8.fullMode=false` is removed from gradle.properties.

## Step 2. Analysis path selection

- Inspect `build.gradle`, `build.gradle.kts`, and `gradle.properties` and
  `libs.versions.toml` to get the AGP and R8 versions.

- This project uses AGP 8.7 and has no local Gradle, so always use **Path C (Heuristic)** below.

### Path C: Heuristic evaluation and recommendation (R8 \< 9.3.7-dev)

*(Use ONLY if quantitative data generation is not possible)*

- **Step 1: Manual evaluation** : Inspect `proguard-rules.pro`.
- **Step 2: Library check** : Compare rules against [references/REDUNDANT-RULES.md](references/REDUNDANT-RULES.md). Suggest **Remove** for bundled rules.
- **Step 3: Custom rule check** : Use [references/KEEP-RULES-IMPACT-HIERARCHY.md](references/KEEP-RULES-IMPACT-HIERARCHY.md) and [references/REFLECTION-GUIDE.md](references/REFLECTION-GUIDE.md) to prioritize and evaluate. Suggest **Refine** for broad rules (for example, package-wide).
- **Step 4: Validation** : Suggest Macrobenchmark tests using [UI Automator](references/android/training/testing/other-components/ui-automator.md) for any proposed changes. Proceed to Step 3.

## Step 3. Report generation

- **Format** : Follow [references/REPORT_FORMAT.md](references/REPORT_FORMAT.md) strictly.
- **Input**: Extract metrics (Scores, Impacts, Example Classes) directly from generated file analysis.txt if using Path A, or from manual findings if using Path B.
- **Output** : Output ONLY the raw Markdown report in the chat. Do NOT output conversational filler (for example, "Here is your report..."). Do NOT provide recommendations, next steps, or any other text outside of the sections defined in [references/REPORT_FORMAT.md](references/REPORT_FORMAT.md) Do NOT mention the path used for analysis of the configuration

## Constraints

- **Strict output limit**: The final output MUST strictly be the Markdown report and nothing else.
- **No code changes**: Research and suggest only; Do not modify files.
- **No redundancy**: Do not explain R8 benefits or reference skill internal files in the report.
- **Focus**: Omit sections (for example, Subsumed Rules, Configuration) if no issues or items are found.
