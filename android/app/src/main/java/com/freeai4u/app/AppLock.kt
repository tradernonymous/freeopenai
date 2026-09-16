package com.freeai4u.app

import android.app.KeyguardManager
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal

/** Fingerprint / face / screen-lock gate in front of the page, using the
 * framework BiometricPrompt (API 29+), so no extra library ships. A strong
 * biometric or the phone's own PIN, pattern or password unlocks it; weak
 * face unlock alone does not, which is why the device credential is always
 * allowed as the fallback. */
object AppLock {
    const val GRACE_MS = 2 * 60 * 1000L

    /** Process-wide, so the native screens and the web tools screen share one
     * unlock instead of each asking again. */
    @Volatile var unlocked = false
    @Volatile var backgroundedAt = 0L

    /** A lock only makes sense on a phone that has a screen lock at all. */
    fun available(context: Context): Boolean {
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        return keyguard?.isDeviceSecure == true
    }

    fun prompt(context: Context, onUnlocked: () -> Unit, onFailed: (String) -> Unit) {
        val builder = BiometricPrompt.Builder(context)
            .setTitle(context.getString(R.string.lock_title))
            .setSubtitle(context.getString(R.string.lock_subtitle))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
        } else {
            @Suppress("DEPRECATION")
            builder.setDeviceCredentialAllowed(true)
        }
        val prompt = try {
            builder.build()
        } catch (e: Exception) {
            onFailed(e.message ?: "Screen lock unavailable.")
            return
        }
        prompt.authenticate(
            CancellationSignal(),
            context.mainExecutor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    onUnlocked()
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    onFailed(errString.toString())
                }
            }
        )
    }
}
