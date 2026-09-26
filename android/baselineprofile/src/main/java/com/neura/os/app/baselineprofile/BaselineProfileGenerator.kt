package com.neura.os.app.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Records which classes and methods the app touches getting from a cold
 * process start to its home screen, and writes them to
 * app/src/main/baseline-prof.txt. AOT-compiling that ahead of time is the
 * whole point: this app is never installed from the Play Store, which is
 * the usual place a device compiles a fresh install's hot classes on its
 * own, so a sideloaded install has nothing else driving that until a
 * shipped baseline profile (installed by the app's own profileinstaller
 * dependency) tells ART what to compile before the first launch.
 *
 * Deliberately just the cold start: this module's only job is producing the
 * profile, not measuring it, and a route beyond the launch screen would tie
 * the profile to a signed-in server session this CI run does not have. */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule val rule = BaselineProfileRule()

    @Test
    fun startup() = rule.collect(
        packageName = "com.neura.os",
        includeInStartupProfile = true,
    ) {
        pressHome()
        startActivityAndWait()
    }
}
