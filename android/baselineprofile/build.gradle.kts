plugins {
    alias(libs.plugins.android.test)
    alias(libs.plugins.baselineprofile)
}

// AGP builds Kotlin itself (see app/build.gradle.kts's note); no separate
// Kotlin plugin needed here either.

android {
    namespace = "com.neura.os.app.baselineprofile"
    compileSdk = 37

    defaultConfig {
        // Baseline Profile collection needs API 33+ to run without a rooted
        // device (see the CI job's aosp_atd image); this module's own minSdk
        // only has to satisfy that, not the app's minSdk 29.
        minSdk = 33
        targetSdk = 36
        // The AndroidJUnitRunner class itself comes transitively through
        // androidx.benchmark:benchmark-macro-junit4 below; this just names it.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // This module instruments :app rather than shipping anything of its own.
    // The baselineprofile plugin (applied to app/build.gradle.kts too) adds a
    // matching "nonMinifiedRelease" build type to :app on its own: real
    // signing and non-debuggable like release, but without R8, so the
    // profile's class/method references match what release would produce
    // before obfuscation renames them.
    targetProjectPath = ":app"
    experimentalProperties["android.experimental.self-instrumenting"] = true
}

dependencies {
    implementation(libs.androidx.test.ext.junit)
    implementation(libs.androidx.benchmark.macro.junit4)
}
