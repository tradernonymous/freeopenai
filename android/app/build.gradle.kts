plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    // Screenshot tests on the JVM (master plan v2, V2); test-only.
    alias(libs.plugins.roborazzi)
}

// Push notifications need a Firebase project, which is the user's own (free)
// account, not something this repo can ship a config for -- so the plugin
// that reads google-services.json only runs when that file has actually been
// dropped next to this one. Its absence (every CI build, and any developer
// who has not set one up) must build a perfectly normal app that simply never
// registers for push; BuildConfig.FCM_CONFIGURED below is how the Kotlin side
// knows which case it is in without ever touching a Firebase class when it is
// not configured.
val fcmConfigured = file("google-services.json").exists()
if (fcmConfigured) {
    apply(plugin = "com.google.gms.google-services")
}

// Build-time defaults, so the first launch has the server (and, if set, the
// username) already filled in. Neither is a secret: the server address is
// public and a username on its own opens nothing. The password is never a
// build input -- an APK can be unpacked by anyone who has it, so anything
// baked in here is published, not protected. It is typed once on the phone
// and sealed there (see SecureStore).
val defaultServer: String = System.getenv("APK_SERVER_URL") ?: (project.findProperty("apkServerUrl") as String?) ?: ""
val defaultUsername: String = System.getenv("APK_USERNAME") ?: (project.findProperty("apkUsername") as String?) ?: ""
// CI passes the run number so every build installs over the one before it;
// Android refuses an update whose versionCode does not go up.
val buildNumber: Int = System.getenv("APK_VERSION_CODE")?.toIntOrNull() ?: 2
val keystorePath: String? = System.getenv("APK_KEYSTORE_FILE")
// Where the app looks for a newer build: version.json in the rolling
// apk-latest release. CI sets it from the repository; a local build has none
// and simply never offers updates.
val updateUrl: String = System.getenv("APK_UPDATE_URL") ?: ""

fun quoted(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "com.neura.os"
    // 37 for Compose 1.12 and Navigation 3 (master plan v2, V1). targetSdk
    // stays 36: compiling against 37 changes no runtime behaviour, targeting
    // it would, and that is its own step.
    compileSdk = 37

    defaultConfig {
        applicationId = "com.neura.os"
        // Android 10: MediaStore saves into Downloads with no storage
        // permission, which is what lets the manifest keep INTERNET alone.
        minSdk = 29
        targetSdk = 36
        versionCode = buildNumber
        versionName = "2.0.$buildNumber"
        buildConfigField("String", "DEFAULT_SERVER", quoted(defaultServer))
        buildConfigField("String", "DEFAULT_USERNAME", quoted(defaultUsername))
        buildConfigField("String", "UPDATE_URL", quoted(updateUrl))
        buildConfigField("boolean", "FCM_CONFIGURED", fcmConfigured.toString())
        // Off by default, overridden on in the debug build type alone (see
        // buildTypes below and WebShell.kt). Deliberately not tied to
        // isDebuggable, which stays false everywhere -- this only ever
        // controls chrome://inspect's view into the hidden Puter WebView.
        buildConfigField("boolean", "WEBVIEW_DEBUG_ALLOWED", "false")
    }

    signingConfigs {
        // A release key only when CI (or a developer) supplies one; without
        // it the release variant is unsigned and cannot install, and the
        // debug variant below is what gets built instead.
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("APK_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("APK_KEY_ALIAS") ?: "neuraos"
                keyPassword = System.getenv("APK_KEY_PASSWORD") ?: System.getenv("APK_KEYSTORE_PASSWORD")
                storeType = "PKCS12"
            }
        }
    }

    buildTypes {
        debug {
            // NOT debuggable, even for testing: adb must not be able to attach
            // and read memory, and logcat must not see app logs. Installs and
            // runs like any store app; debugging happens through the UI itself.
            isDebuggable = false
            // No applicationIdSuffix: this variant only ever exists as CI's
            // no-keystore fallback and testDebugUnitTest's target, never
            // installed alongside a release build on the same device, and a
            // suffixed id has no matching client in google-services.json --
            // processDebugGoogleServices failed the whole build over it.

            // The one exception to "no debugging": chrome://inspect on the
            // hidden Puter WebView, for a developer who built this variant
            // themselves in Android Studio. isDebuggable above is untouched
            // and stays false -- adb still cannot attach to the process or
            // read its memory. This only opens the WebView's own devtools
            // socket, which is how a stuck sign-in gets diagnosed by looking
            // at the real page instead of guessing from error strings. CI's
            // build of this same variant (the no-keystore fallback) never
            // reaches a phone, so this never ships anywhere a user runs it.
            buildConfigField("boolean", "WEBVIEW_DEBUG_ALLOWED", "true")
        }
        release {
            // The build that goes on the phone: non-debuggable, minified,
            // shrunk, signed with the project's own key so each build updates
            // the last in place.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.findByName("release")
        }
    }

    lint {
        // Release builds fail on lint *errors* again (warnings still pass).
        // The old softer setting let a full lintRelease stay advisory and
        // drift; the one known-fatal detector (NullSafeMutableLiveData on
        // Kotlin 2.1.x) is suppressed in lint.xml.
        abortOnError = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
        compose = true
    }
    testOptions {
        // Robolectric renders the real resources (fonts, drawables) for the
        // screenshot tests in src/test/.../ui/ScreenshotTest.kt.
        unitTests.isIncludeAndroidResources = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

// AGP 9 builds Kotlin itself (android.builtInKotlin, on by default), so the
// org.jetbrains.kotlin.android plugin and its kotlin { compilerOptions } block
// are gone: the JVM target now follows compileOptions above (17).

dependencies {
    // Native screens are Compose + Material 3. R8 strips the unused parts of
    // the icon set.
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    // Custom Tabs for GitHub connect: a real, isolated browser process, not a
    // WebView -- that isolation from the app is exactly why it is safe here.
    implementation(libs.androidx.browser)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    // Firebase Messaging pulls in an old transitive androidx.fragment that
    // fails the release build's mandatory lint check against the
    // registerForActivityResult calls this app already had
    // (InvalidFragmentVersionForActivityResult wants >= 1.3.0); pinning a
    // current version here is what Gradle's resolution actually picks.
    implementation(libs.androidx.fragment.ktx)
    // No LeakCanary: it throws "LeakCanary in non-debuggable build" at launch,
    // and the debug variant is deliberately non-debuggable (see buildTypes),
    // so every debug install -- CI's Maestro run included -- crashed on start.
    // Real org.json for local JVM tests only: on device the framework copy is
    // used and this never ships. (android.jar methods throw "not mocked"
    // under plain unit tests, so the parser tests need the real thing.)
    testImplementation(libs.org.json)
    testImplementation(libs.junit)
    // Navigation 3 serialization for type-safe routes.
    implementation(libs.androidx.serialization.json)
    // Master plan v2: Navigation 3 (V4), view-model-owned coroutines and
    // lifecycle-aware collection (V3). Added in V1 so V3/V4 change no build file.
    implementation(libs.androidx.navigation3.runtime)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    testImplementation(libs.kotlinx.coroutines.test)
    // Screenshot tests: Robolectric draws the composables, Roborazzi records
    // and compares the pictures. Test classpath only; nothing reaches the APK.
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(platform(libs.androidx.compose.bom))
    // Studio images are decoded in-app from stored data URLs (loadBitmap in
    // AppViewModel), so no Coil dependency is pulled in. If remote image URLs
    // are ever added, that is the moment to add Coil -- not before.
}

// Prints every screenshot baseline as one small JPEG contact sheet, base64
// between two marker lines, into the build log. CI runs it after the
// screenshot step: artifacts cannot be downloaded from where this app is
// developed, but job logs can be read, so this is how a reviewer (human or
// agent) sees what a visual change did. Plain java.awt, headless; no plugin.
tasks.register("printScreenshotSheet") {
    val dir = layout.projectDirectory.dir("src/test/screenshots")
    doLast {
        val files = dir.asFile.listFiles { f -> f.name.endsWith(".png") }?.sortedBy { it.name } ?: emptyList()
        if (files.isEmpty()) {
            println("NEURA-SHEET: no screenshots")
            return@doLast
        }
        val cell = 300
        val columns = 4
        val rows = (files.size + columns - 1) / columns
        val labels = 18
        val sheet = java.awt.image.BufferedImage(columns * cell, rows * (cell * 2 + labels), java.awt.image.BufferedImage.TYPE_INT_RGB)
        val g = sheet.createGraphics()
        g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR)
        g.color = java.awt.Color(128, 128, 128)
        g.fillRect(0, 0, sheet.width, sheet.height)
        files.forEachIndexed { i, f ->
            val img = javax.imageio.ImageIO.read(f)
            val x = (i % columns) * cell
            val y = (i / columns) * (cell * 2 + labels)
            val scale = minOf(cell.toDouble() / img.width, (cell * 2).toDouble() / img.height)
            g.drawImage(img, x, y + labels, (img.width * scale).toInt(), (img.height * scale).toInt(), null)
            g.color = java.awt.Color.WHITE
            g.drawString(f.nameWithoutExtension, x + 4, y + 13)
        }
        g.dispose()
        val out = java.io.ByteArrayOutputStream()
        javax.imageio.ImageIO.write(sheet, "jpg", out)
        println("NEURA-SHEET-BEGIN " + files.size)
        java.util.Base64.getMimeEncoder(76, "\n".toByteArray()).encodeToString(out.toByteArray()).lines().forEach { println(it) }
        println("NEURA-SHEET-END")
    }
}
