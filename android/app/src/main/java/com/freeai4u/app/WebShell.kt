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
        WebView.setWebContentsDebuggingEnabled(false)
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(web, false)
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
