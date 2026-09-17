package com.freeai4u.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject

/** The user's own Puter account, reached from the app. A hidden WebView loads
 * /puter-bridge.html from the app's own server and runs puter.ai.txt2img and
 * puter.ai.chat there. Kotlin reads the result by polling with
 * evaluateJavascript, in slices: no JavaScript bridge is added, so the page
 * gets no handle into the app. The page is reloaded for every job because
 * Puter reads its sign-in only when it loads. Signing in itself is the one
 * exception to "hidden": signIn() opens Puter's own popup in a visible dialog
 * (see openSignInPopup below), which is the only way this WebView's storage
 * ever gets a signed-in session in the first place. */
class PuterBridge(private val context: Context, private val baseUrl: () -> String) {
    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var onLoaded: (() -> Unit)? = null

    @SuppressLint("SetJavaScriptEnabled")
    private fun load(then: () -> Unit) {
        val view = web ?: WebView(context).also { created ->
            // false: this page itself is not a popup, so it may open the one
            // popup fa4uSignIn asks for -- the reverse of the flag a popup
            // window gets in openSignInPopup below, which must not open one of
            // its own.
            WebShell.harden(created, "FreeAI4U/" + BuildConfig.VERSION_NAME, popup = false)
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
            created.webChromeClient = object : WebChromeClient() {
                override fun onCreateWindow(v: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean =
                    openSignInPopup(resultMsg)
            }
            // A WebView that is never part of any window can run JavaScript
            // fine (chat and draw always have), but Chromium's window-creation
            // path -- what has to fire for puter.auth.signIn()'s popup to
            // exist at all -- needs the WebView attached to an active window.
            // 1x1 and invisible: present in the tree, never seen.
            (context as? android.app.Activity)?.window?.decorView
                ?.findViewById<ViewGroup>(android.R.id.content)
                ?.addView(created, 1, 1)
            created.visibility = View.INVISIBLE
            web = created
        }
        onLoaded = then
        view.loadUrl(baseUrl() + "/puter-bridge.html")
    }

    /** Puter's sign-in window, made visible: window.open() from the hidden
     * page normally has nowhere to go, so this hosts it in a real dialog the
     * user can type into, and closes it the same way Puter itself does --
     * window.close() after a successful sign-in reaches onCloseWindow below.
     * Navigation is gated the way the app's own browser tabs are: only the
     * app's origin and puter.com may load here, a social sign-in page that
     * WebView cannot complete is explained instead of shown, and anything
     * else is handed to the phone's real browser. */
    private fun openSignInPopup(resultMsg: Message): Boolean {
        val activity = context as? Activity ?: return false
        val popup = WebView(context)
        popup.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        WebShell.harden(popup, "FreeAI4U/" + BuildConfig.VERSION_NAME, popup = true)
        val dialog = Dialog(activity)
        dialog.setContentView(popup)
        // A WebView has no size of its own; without this the dialog wraps it
        // to nothing and the sign-in form the user needs to type into never
        // appears -- the same failure this whole fix exists to end.
        dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        dialog.setOnDismissListener { popup.destroy() }
        popup.webChromeClient = object : WebChromeClient() {
            override fun onCloseWindow(window: WebView) {
                dialog.dismiss()
            }
        }
        popup.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (blockedInWebView(url)) {
                    Toast.makeText(context, context.getString(R.string.puter_social_message), Toast.LENGTH_LONG).show()
                    return true
                }
                if (!popupAllowed(originOf(baseUrl()), url)) {
                    try {
                        activity.startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    } catch (e: ActivityNotFoundException) {
                        // No app on the phone can open it; the popup just stays put.
                    }
                    return true
                }
                return false
            }
        }
        (resultMsg.obj as WebView.WebViewTransport).webView = popup
        resultMsg.sendToTarget()
        dialog.show()
        return true
    }

    /** Chats on the user's Puter allowance. [body] is the same JSON the server
     * routes take ({model, messages}); the reply arrives in pieces through
     * [onDelta] and ends with [done] -- null on success, a reason on failure.
     * Puter answers in the browser, so this is the only way the app can offer
     * it, and the page forces streaming so a long answer is readable as it
     * arrives rather than after it. */
    fun chat(body: String, onDelta: (String) -> Unit, done: (String?) -> Unit) {
        if (baseUrl().isEmpty()) {
            done("not signed in")
            return
        }
        load {
            val view = web
            if (view == null) {
                done("no WebView")
                return@load
            }
            val job = "c" + System.nanoTime()
            view.evaluateJavascript("window.fa4uChat && window.fa4uChat(" + JSONObject.quote(job) + "," + JSONObject.quote(body) + ");", null)
            followChat(view, job, 0, 0, onDelta, done)
        }
    }

    /** Reads whatever the job has written since [read] and asks again until it
     * ends. A job that never grows is given 5 minutes, the same ceiling the
     * drawing path uses. */
    private fun followChat(view: WebView, job: String, read: Int, tries: Int, onDelta: (String) -> Unit, done: (String?) -> Unit) {
        main.postDelayed({
            view.evaluateJavascript("window.fa4uStatus ? window.fa4uStatus(" + JSONObject.quote(job) + ") : '{\"state\":\"missing\"}'") { raw ->
                val status = try {
                    JSONObject(unquote(raw))
                } catch (e: Exception) {
                    JSONObject().put("state", "missing")
                }
                val state = status.optString("state")
                val length = status.optInt("length")
                if (state == "missing") {
                    done("Puter did not load")
                    return@evaluateJavascript
                }
                if (length > read) {
                    view.evaluateJavascript("window.fa4uChunk(" + JSONObject.quote(job) + "," + read + "," + (length - read) + ")") { piece ->
                        val text = unquote(piece)
                        if (text.isNotEmpty()) onDelta(text)
                        val now = read + text.length
                        if (state == "pending") followChat(view, job, now, 0, onDelta, done)
                        else {
                            view.evaluateJavascript("window.fa4uForget && window.fa4uForget(" + JSONObject.quote(job) + ")", null)
                            done(if (state == "done") null else status.optString("error", "Puter failed"))
                        }
                    }
                    return@evaluateJavascript
                }
                when {
                    state == "pending" && tries < 600 -> followChat(view, job, read, tries + 1, onDelta, done)
                    state == "pending" -> done("Puter timed out")
                    else -> {
                        view.evaluateJavascript("window.fa4uForget && window.fa4uForget(" + JSONObject.quote(job) + ")", null)
                        done(if (state == "done") null else status.optString("error", "Puter failed"))
                    }
                }
            }
        }, 300)
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

    /** Opens Puter's own sign-in window and waits for it to close. A
     * deliberate, user-tapped action -- draw() and chat() never call this on
     * their own, so a background picture or reply never pops a login window
     * out of nowhere; they just fail with a message asking to sign in first,
     * and this is what answers that ask. [done] gets a minute past the usual
     * job budget, since a person typing a password takes longer than a draw. */
    fun signIn(done: (Result<Unit>) -> Unit) {
        if (baseUrl().isEmpty()) {
            done(Result.failure(IllegalStateException("not signed in to the app yet")))
            return
        }
        load {
            val view = web
            if (view == null) {
                done(Result.failure(IllegalStateException("no WebView")))
                return@load
            }
            val job = "s" + System.nanoTime()
            view.evaluateJavascript("window.fa4uSignIn && window.fa4uSignIn(" + JSONObject.quote(job) + ");", null)
            pollSignIn(view, job, 0, done)
        }
    }

    private fun pollSignIn(view: WebView, job: String, tries: Int, done: (Result<Unit>) -> Unit) {
        main.postDelayed({
            view.evaluateJavascript("window.fa4uStatus ? window.fa4uStatus(" + JSONObject.quote(job) + ") : '{\"state\":\"missing\"}'") { raw ->
                val status = try {
                    JSONObject(unquote(raw))
                } catch (e: Exception) {
                    JSONObject().put("state", "missing")
                }
                when (status.optString("state")) {
                    "pending" -> if (tries < 1200) pollSignIn(view, job, tries + 1, done) else done(Result.failure(IllegalStateException("timed out")))
                    "missing" -> done(Result.failure(IllegalStateException("Puter did not load")))
                    "done" -> {
                        view.evaluateJavascript("window.fa4uForget && window.fa4uForget(" + JSONObject.quote(job) + ")", null)
                        done(Result.success(Unit))
                    }
                    else -> {
                        view.evaluateJavascript("window.fa4uForget && window.fa4uForget(" + JSONObject.quote(job) + ")", null)
                        done(Result.failure(IllegalStateException(status.optString("error", "Puter failed"))))
                    }
                }
            }
        }, 300)
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
        web?.let { (it.parent as? ViewGroup)?.removeView(it) }
        web?.destroy()
        web = null
    }

    private companion object {
        const val CHUNK = 400_000
    }
}
