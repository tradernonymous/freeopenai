package com.neura.os.app

import com.neura.os.BuildConfig

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView

/** The WebView's lockdown, in one place so the hidden Puter drawing page and
 * any future window get the same one. That page needs JavaScript and its own
 * storage (Puter's saved sign-in) and nothing else: no file or content
 * URLs, no mixed content, no geolocation, no JavaScript bridge anywhere. */
object WebShell {
    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION")
    fun harden(web: WebView, userAgentSuffix: String, popup: Boolean) {
        val settings = web.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.setGeolocationEnabled(false)
        // The page may open one popup (Puter's sign-in); a popup opens none.
        settings.setSupportMultipleWindows(!popup)
        settings.javaScriptCanOpenWindowsAutomatically = !popup
        settings.mediaPlaybackRequiresUserGesture = true
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.safeBrowsingEnabled = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.userAgentString = settings.userAgentString + " " + userAgentSuffix
        web.overScrollMode = View.OVER_SCROLL_NEVER
        // A separate switch from the build's own debuggability, which stays
        // off in every build type this project ships (build.gradle.kts:
        // "NOT debuggable, even for testing: adb must not be able to attach
        // and read memory" -- that stance is untouched here). This one only
        // opens chrome://inspect's view into *this WebView's own page* --
        // its console, network tab and DOM -- and only in a debug variant
        // someone built and installed themselves from Android Studio, never
        // in the release build android.yml publishes to apk-latest.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.WEBVIEW_DEBUG_ALLOWED)
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(web, false)
    }

    /** Pushes this deployment's session cookie into WebView's own cookie jar,
     * so every WebView the app creates -- the hidden Puter bridge foremost --
     * carries the same fo_auth session the app's native API calls already
     * send as a header. Without this, that WebView's very first request for
     * puter-bridge.html hits the server's login gate with no cookie at all
     * and is answered 401 before a single line of the real page -- the SDK
     * script tag included -- is ever served. That is indistinguishable from
     * every "Puter did not load" / stuck-signing-in report this app has
     * chased under other explanations: onPageFinished still fires (the
     * WebView did load *something*, just the 401 error body), so every
     * window.fa4uX function this file calls is silently undefined, and even
     * fa4uDiagnose -- built specifically to explain a failure like this --
     * never gets served either. WebView's CookieManager persists to disk on
     * its own once flushed, so this only needs calling when the cookie
     * actually changes: sign-in, a silent re-auth, sign-out, and once at
     * startup for an account already signed in before this existed. See
     * AppViewModel's call sites. */
    fun syncSessionCookie(server: String, cookie: String?) {
        if (server.isEmpty()) return
        val manager = CookieManager.getInstance()
        manager.setCookie(server, sessionCookieHeaderValue(cookie))
        manager.flush()
    }

    /** Writes a file into Downloads/NeuraOS through MediaStore: visible in
     * the Files app, no storage permission involved (Android 10+). */
    fun saveToDownloads(context: Context, name: String, mime: String, bytes: ByteArray): Boolean {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/NeuraOS")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
        return try {
            val stream = resolver.openOutputStream(uri) ?: throw IllegalStateException("no stream")
            stream.use { it.write(bytes) }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            true
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            false
        }
    }
}
