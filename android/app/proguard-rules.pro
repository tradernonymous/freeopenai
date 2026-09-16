# Release shrink rules for the testing APK. The app is plain Kotlin + Compose
# with reflection-free JSON (org.json), so the defaults are enough; model
# classes are kept by name for crash-report readability.
-keep class com.freeai4u.app.** { *; }
