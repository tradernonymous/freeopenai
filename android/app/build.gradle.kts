plugins {
    id("com.android.application")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.freeai4u.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.freeai4u.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        // Personal testing build, not a release.
        versionName = "1.0-testing"
    }

    buildTypes {
        debug {
            // NOT debuggable, even for testing: adb must not be able to attach
            // and read memory, and logcat must not see app logs. Installs and
            // runs like any store app; debugging happens through the UI itself.
            isDebuggable = false
            applicationIdSuffix = ".debug"
        }
        release {
            // The release shape, for when this outgrows personal testing:
            // non-debuggable, minified, shrunk. Needs a real keystore, so CI
            // does not build it -- see .github/workflows/android.yml.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.foundation:foundation")
    // Real org.json for local JVM tests only: on device the framework copy is
    // used and this never ships. (android.jar methods throw Teb "not mocked"
    // under plain unit tests, so the parser tests need the real thing.)
    testImplementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
}
