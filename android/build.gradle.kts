// Top-level build file for the NeuraOS Android app.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.roborazzi) apply false
    // Applied in app/build.gradle.kts only when google-services.json exists --
    // see the comment there for why push notifications have to be optional.
    alias(libs.plugins.google.services) apply false
}
