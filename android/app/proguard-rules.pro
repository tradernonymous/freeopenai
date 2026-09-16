# Release shrink rules. The app is plain Kotlin + the framework WebView with
# reflection-free JSON (org.json), so the defaults are enough; app classes
# are kept by name for crash-report readability.
-keep class com.freeai4u.app.** { *; }
