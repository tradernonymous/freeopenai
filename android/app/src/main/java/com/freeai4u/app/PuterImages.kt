package com.freeai4u.app

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject

/** Draws with the user's own Puter account. A hidden WebView loads
 * /puter-bridge.html from the app's own server -- the same origin, and so the
 * same Puter sign-in, as the web app screen -- and runs puter.ai.txt2img
 * there. Kotlin reads the result by polling with evaluateJavascript, in
 * slices: no JavaScript bridge is added, so the page gets no handle into the
 * app. The page is reloaded for every picture because Puter reads its sign-in
 * only when it loads, and the sign-in happens in the web app screen. */
class PuterImages(private val context: Context, private val baseUrl: () -> String) {
    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var onLoaded: (() -> Unit)? = null

    @SuppressLint("SetJavaScriptEnabled")
    private fun load(then: () -> Unit) {
        val view = web ?: WebView(context).also { created ->
            WebShell.harden(created, "FreeAI4U/" + BuildConfig.VERSION_NAME, popup = true)
            created.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean =
                    !sameOrigin(originOf(baseUrl()), request.url.toString())

                override fun onPageFinished(v: WebView, url: String?) {
                    val callback = onLoaded ?: return
                    onLoaded = null
                    // Give puter.js a moment to restore the saved sign-in.
                    main.postDelayed(callback, 600)
                }
            }
            web = created
        }
        onLoaded = then
        view.loadUrl(baseUrl() + "/puter-bridge.html")
    }

    /** Calls [done] on the main thread with the media type and bytes. [model]
     * and [ratio] pick a Puter model and shape; [source] (a data URL) turns the
     * job into an edit. All three are optional and ignored by an older page. */
    fun draw(
        prompt: String,
        model: String = "",
        ratio: Pair<Int, Int>? = null,
        source: String? = null,
        done: (Result<Pair<String, ByteArray>>) -> Unit,
    ) {
        if (baseUrl().isEmpty()) {
            done(Result.failure(IllegalStateException("not signed in")))
            return
        }
        load {
            val view = web
            if (view == null) {
                done(Result.failure(IllegalStateException("no WebView")))
                return@load
            }
            val options = JSONObject()
            if (model.isNotEmpty()) options.put("model", model)
            if (ratio != null) options.put("ratio", JSONObject().put("w", ratio.first).put("h", ratio.second))
            if (source != null) options.put("source", source)
            val job = "j" + System.nanoTime()
            view.evaluateJavascript("window.fa4uDraw && window.fa4uDraw(" + JSONObject.quote(job) + "," + JSONObject.quote(prompt.take(2000)) + "," + options + ");", null)
            poll(view, job, 0, done)
        }
    }

    private fun unquote(raw: String?): String = try {
        JSONArray("[" + (raw ?: "null") + "]").optString(0, "")
    } catch (e: Exception) {
        ""
    }

    private fun poll(view: WebView, job: String, tries: Int, done: (Result<Pair<String, ByteArray>>) -> Unit) {
        main.postDelayed({
            view.evaluateJavascript("window.fa4uStatus ? window.fa4uStatus(" + JSONObject.quote(job) + ") : '{\"state\":\"missing\"}'") { raw ->
                val status = try {
                    JSONObject(unquote(raw))
                } catch (e: Exception) {
                    JSONObject().put("state", "missing")
                }
                when (status.optString("state")) {
                    "pending" -> if (tries < 300) poll(view, job, tries + 1, done) else done(Result.failure(IllegalStateException("timed out")))
                    "done" -> readChunks(view, job, status.optInt("length"), StringBuilder(), done)
                    "missing" -> done(Result.failure(IllegalStateException("Puter did not load")))
                    else -> done(Result.failure(IllegalStateException(status.optString("error", "Puter failed"))))
                }
            }
        }, 500)
    }

    private fun readChunks(view: WebView, job: String, length: Int, out: StringBuilder, done: (Result<Pair<String, ByteArray>>) -> Unit) {
        if (out.length >= length) {
            view.evaluateJavascript("window.fa4uForget && window.fa4uForget(" + JSONObject.quote(job) + ")", null)
            val decoded = decodeDataUrl(out.toString())
            if (decoded == null) done(Result.failure(IllegalStateException("no picture")))
            else done(Result.success(decoded))
            return
        }
        view.evaluateJavascript("window.fa4uChunk(" + JSONObject.quote(job) + "," + out.length + "," + CHUNK + ")") { raw ->
            val piece = unquote(raw)
            if (piece.isEmpty()) {
                done(Result.failure(IllegalStateException("picture read failed")))
            } else {
                out.append(piece)
                readChunks(view, job, length, out, done)
            }
        }
    }

    fun close() {
        web?.destroy()
        web = null
    }

    private companion object {
        const val CHUNK = 400_000
    }
}
