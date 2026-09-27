// Top-level build file for the NeuraOS Android app.
plugins {
    alias(libs.plugins.android.application) apply false
    // com.android.test ships in the same AGP artifact as android.application,
    // which the line above already puts on this root classloader. Requested
    // with a version only inside :baselineprofile, Gradle refused it ("already
    // on the classpath with an unknown version") and every build failed at
    // configuration. Declared here, both subprojects share this one copy.
    alias(libs.plugins.android.test) apply false
    alias(libs.plugins.baselineprofile) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.roborazzi) apply false
    // Applied in app/build.gradle.kts only when google-services.json exists --
    // see the comment there for why push notifications have to be optional.
    alias(libs.plugins.google.services) apply false
}
