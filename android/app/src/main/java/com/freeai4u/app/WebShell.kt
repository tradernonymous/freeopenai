package com.freeai4u.app

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView

/** The WebView's lockdown, in one place so the main page and a popup get the
 * same one. The page needs JavaScript and its own storage (that is where it
 * keeps conversations) and nothing else: no file or content URLs, no mixed
 * content, no geolocation, no zoom chrome, no JavaScript bridge anywhere. */
object WebShell {
    const val SESSION_COOKIE = "fo_auth"
    private const val SESSION_MAX_AGE = 7 * 24 * 60 * 60

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
        WebView.setWebContentsDebuggingEnabled(false)
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(web, false)
    }

    /** Puts the native sign-in's session into the WebView's cookie jar (or
     * takes it out again), so the page's own fetches are signed in from the
     * first one. HttpOnly, so the page's scripts cannot read it either. */
    fun setSessionCookie(baseUrl: String, value: String?) {
        if (baseUrl.isEmpty()) return
        val manager = CookieManager.getInstance()
        val secure = if (baseUrl.startsWith("https://")) "; Secure" else ""
        if (value.isNullOrEmpty()) {
            manager.setCookie(baseUrl, "$SESSION_COOKIE=; Path=/; Max-Age=0$secure")
        } else {
            manager.setCookie(baseUrl, "$SESSION_COOKIE=$value; Path=/; Max-Age=$SESSION_MAX_AGE; HttpOnly$secure")
        }
        manager.flush()
    }

    /** Writes a file into Downloads/FreeAI4U through MediaStore: visible in
     * the Files app, no storage permission involved (Android 10+). */
    fun saveToDownloads(context: Context, name: String, mime: String, bytes: ByteArray): Boolean {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/FreeAI4U")
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
