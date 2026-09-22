package com.neura.os.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** App-private settings. The password and the session are sealed with an
 * AES-256-GCM key that lives in the Android Keystore -- hardware-backed on
 * any recent phone -- so the preferences file holds ciphertext, and nothing
 * outside this app's uid, on this device, can turn it back into either.
 * Backup is off in the manifest, so neither leaves the phone.
 *
 * The password is kept at all only because the user asked the app to stay
 * signed in without typing: the server's sessions last a week, and this is
 * what signs in again when one lapses. Signing out inside the app clears it. */
class SecureStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var server: String?
        get() = prefs.getString(KEY_SERVER, null)?.ifEmpty { null }
        set(value) = put(KEY_SERVER, value)

    var username: String?
        get() = prefs.getString(KEY_USERNAME, null)?.ifEmpty { null }
        set(value) = put(KEY_USERNAME, value)

    var password: String?
        get() = open(prefs.getString(KEY_PASSWORD, null))
        set(value) = put(KEY_PASSWORD, value?.let { seal(it) })

    var session: String?
        get() = open(prefs.getString(KEY_SESSION, null))
        set(value) = put(KEY_SESSION, value?.let { seal(it) })

    /** The sealed GitHub connect session (the server's fo_gh cookie value),
     * picked up once through /api/github/pickup after a Custom Tab round
     * trip -- see NativeApi.githubPickup. Sent back as a second Cookie on
     * every call, exactly like [session] already is for fo_auth. */
    var githubSession: String?
        get() = open(prefs.getString(KEY_GITHUB_SESSION, null))
        set(value) = put(KEY_GITHUB_SESSION, value?.let { seal(it) })

    /** Plain settings: neither is a secret. */
    var appLock: Boolean
        get() = prefs.getBoolean(KEY_APP_LOCK, false)
        set(value) = prefs.edit().putBoolean(KEY_APP_LOCK, value).apply()

    var askedNotifications: Boolean
        get() = prefs.getBoolean(KEY_ASKED_NOTIFY, false)
        set(value) = prefs.edit().putBoolean(KEY_ASKED_NOTIFY, value).apply()

    var lastUpdateCheck: Long
        get() = prefs.getLong(KEY_UPDATE_CHECK, 0L)
        set(value) = prefs.edit().putLong(KEY_UPDATE_CHECK, value).apply()

    fun clearSession() {
        prefs.edit().remove(KEY_SESSION).apply()
    }

    /** What sign-out forgets: the password, the session, and any connected
     * GitHub account -- the next person to sign in on this phone must not
     * inherit it. The server and the username stay, so the next sign-in is
     * one field. */
    fun clearSecrets() {
        prefs.edit().remove(KEY_PASSWORD).remove(KEY_SESSION).remove(KEY_GITHUB_SESSION).apply()
    }

    private fun put(key: String, value: String?) {
        val editor = prefs.edit()
        if (value.isNullOrEmpty()) editor.remove(key) else editor.putString(key, value)
        editor.apply()
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun seal(plain: String): String = try {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val encoder = Base64.getEncoder()
        encoder.encodeToString(cipher.iv) + ":" + encoder.encodeToString(sealed)
    } catch (e: Exception) {
        // A Keystore that refuses to make or use a key (some OEM builds, a
        // restore from another phone) is an error the sign-in screen shows,
        // not a crash on the IO thread.
        throw ApiException("This phone's secure storage refused to keep the credential: " + (e.message ?: e.javaClass.simpleName))
    }

    /** Null for anything that does not open cleanly -- a key the OS rotated,
     * a value from an older build -- which reads as "not saved" and asks for
     * the password again, never as a crash. */
    private fun open(sealed: String?): String? {
        if (sealed.isNullOrEmpty()) return null
        return try {
            val cut = sealed.indexOf(':')
            if (cut <= 0) return null
            val decoder = Base64.getDecoder()
            val iv = decoder.decode(sealed.substring(0, cut))
            val body = decoder.decode(sealed.substring(cut + 1))
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(body), Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }

    private companion object {
        const val PREFS = "neuraos"
        const val KEY_SERVER = "base_url"
        const val KEY_USERNAME = "username"
        const val KEY_PASSWORD = "password_sealed"
        const val KEY_SESSION = "session_sealed"
        const val KEY_GITHUB_SESSION = "github_session_sealed"
        const val KEY_APP_LOCK = "app_lock"
        const val KEY_UPDATE_CHECK = "last_update_check"
        const val KEY_ASKED_NOTIFY = "asked_notifications"
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "neuraos-secrets"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
