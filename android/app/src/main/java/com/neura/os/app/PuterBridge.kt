package com.neura.os.app
import com.neura.os.BuildConfig
import com.neura.os.R

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
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
    private var onLoaded: ((Result<Unit>) -> Unit)? = null
    // Puter's own signIn() promise is documented to resolve through
    // window.opener reaching back into this page from the popup -- a channel
    // Android's separate popup WebView instance is not guaranteed to keep
    // working (see openSignInPopup and resolveSignInFromCurrentState below).
    // Tracking the in-flight job id is what lets a popup close force that
    // job done from the Kotlin side instead of only trusting the promise.
    private var currentSignInJob: String? = null
    // The last console.error/warn the bridge or popup page logged, so a
    // failure message can show what actually went wrong instead of a bare
    // "Puter failed" or "timed out". Reset per job in signIn().
    private var lastConsoleIssue: String? = null

    private fun logConsole(message: ConsoleMessage): Boolean {
        if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR ||
            message.messageLevel() == ConsoleMessage.MessageLevel.WARNING
        ) {
            lastConsoleIssue = message.message().take(200)
            Log.w("PuterBridge", "console: " + message.message())
        }
        return false
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun load(then: (Result<Unit>) -> Unit) {
        val existing = web
        if (existing != null) {
            onLoaded = then
            existing.loadUrl(baseUrl() + "/puter-bridge.html")
            return
        }
        val created = WebView(context)
        // false: this page itself is not a popup, so it may open the one
        // popup fa4uSignIn asks for -- the reverse of the flag a popup
        // window gets in openSignInPopup below, which must not open one of
        // its own.
        WebShell.harden(created, "NeuraOS/" + BuildConfig.VERSION_NAME, popup = false)
        created.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean =
                !sameOrigin(originOf(baseUrl()), request.url.toString())

            override fun onPageFinished(v: WebView, url: String?) {
                val callback = onLoaded ?: return
                onLoaded = null
                // Give puter.js a moment to restore the saved sign-in.
                main.postDelayed({ callback(Result.success(Unit)) }, 600)
            }
        }
        created.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(v: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean =
                openSignInPopup(resultMsg)
            override fun onConsoleMessage(message: ConsoleMessage): Boolean = logConsole(message)
        }
        // A WebView that is never part of any window can run JavaScript fine
        // (chat and draw always have), but Chromium's window-creation path --
        // what has to fire for puter.auth.signIn()'s popup to exist at all --
        // needs the WebView attached to an active window. This used to be a
        // silent optional chain: if the activity's content view was not the
        // shape expected, attaching failed with no signal anywhere, and a
        // later signIn() tap looked exactly like a dead button -- nothing
        // ever happened, because Chromium had nowhere to put the popup it
        // was asked to create. Failing loud here turns that into a message
        // the sign-in button can actually show. 1x1 and invisible: present
        // in the tree, never seen.
        val container = (context as? android.app.Activity)?.window?.decorView
            ?.findViewById<ViewGroup>(android.R.id.content)
        if (container == null) {
            then(Result.failure(IllegalStateException("Could not attach the Puter page to this screen.")))
            return
        }
        container.addView(created, 1, 1)
        created.visibility = View.INVISIBLE
        web = created
        onLoaded = then
        created.loadUrl(baseUrl() + "/puter-bridge.html")
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
        val activity = context as? Activity ?: run {
            Toast.makeText(context, "Could not open Puter sign-in on this screen.", Toast.LENGTH_LONG).show()
            return false
        }
        val popup = WebView(context)
        popup.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        WebShell.harden(popup, "NeuraOS/" + BuildConfig.VERSION_NAME, popup = true)
        val dialog = Dialog(activity)
        dialog.setContentView(popup)
        // A WebView has no size of its own; without this the dialog wraps it
        // to nothing and the sign-in form the user needs to type into never
        // appears -- the same failure this whole fix exists to end.
        dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        dialog.setOnDismissListener {
            popup.destroy()
            // Fires for every way this dialog closes -- Puter's own
            // window.close() below, or the user dismissing it by hand -- so
            // this is the one place to check, whichever path was taken.
            resolveSignInFromCurrentState()
        }
        popup.webChromeClient = object : WebChromeClient() {
            override fun onCloseWindow(window: WebView) {
                dialog.dismiss()
            }
            override fun onConsoleMessage(message: ConsoleMessage): Boolean = logConsole(message)
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
        Toast.makeText(context, "Opening Puter sign-in…", Toast.LENGTH_SHORT).show()
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
        load { result ->
            val view = web
            if (result.isFailure) {
                done(result.exceptionOrNull()?.message ?: "could not open the Puter page")
            } else if (view == null) {
                done("no WebView")
            } else {
                val job = "c" + System.nanoTime()
                view.evaluateJavascript("window.fa4uChat && window.fa4uChat(" + JSONObject.quote(job) + "," + JSONObject.quote(body) + ");", null)
                followChat(view, job, 0, 0, onDelta, done)
            }
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
        load { result ->
            val view = web
            if (result.isFailure) {
                done(Result.failure(result.exceptionOrNull() ?: IllegalStateException("could not open the Puter page")))
            } else if (view == null) {
                done(Result.failure(IllegalStateException("no WebView")))
            } else {
                val options = JSONObject()
                if (model.isNotEmpty()) options.put("model", model)
                if (ratio != null) options.put("ratio", JSONObject().put("w", ratio.first).put("h", ratio.second))
                if (source != null) options.put("source", source)
                val job = "j" + System.nanoTime()
                view.evaluateJavascript("window.fa4uDraw && window.fa4uDraw(" + JSONObject.quote(job) + "," + JSONObject.quote(prompt.take(2000)) + "," + options + ");", null)
                poll(view, job, 0, done)
            }
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
        load { result ->
            val view = web
            if (result.isFailure) {
                done(Result.failure(result.exceptionOrNull() ?: IllegalStateException("could not open the Puter page")))
            } else if (view == null) {
                done(Result.failure(IllegalStateException("no WebView")))
            } else {
                val job = "s" + System.nanoTime()
                currentSignInJob = job
                lastConsoleIssue = null
                view.evaluateJavascript("window.fa4uSignIn && window.fa4uSignIn(" + JSONObject.quote(job) + ");", null)
                pollSignIn(view, job, 0, done)
            }
        }
    }

    /** Puter's own signIn() promise resolves through window.opener reaching
     * back into this page from the popup -- see the field comment on
     * [currentSignInJob]. Called whenever the popup dialog closes, by
     * whichever path closed it: if the bridge page's own
     * puter.auth.isSignedIn() now says yes, the job is forced to "done"
     * directly rather than left to time out because the promise that was
     * supposed to report that never arrived. A no-op once the job has
     * already resolved (currentSignInJob is cleared in pollSignIn's terminal
     * cases), so a popup closed for an unrelated reason touches nothing. */
    private fun resolveSignInFromCurrentState(tries: Int = 0) {
        val job = currentSignInJob ?: return
        val view = web ?: return
        // Puter's own postMessage handling may still be settling when the
        // dialog closes (window.close() and the message that is supposed to
        // precede it are not guaranteed to be processed in that order); a
        // handful of checks over ~2.5s gives that a real chance to land
        // before this gives up. pollSignIn's own 300ms tick can also resolve
        // the job on its own at any point, in which case currentSignInJob is
        // already cleared and every step here no-ops.
        main.postDelayed({
            if (currentSignInJob != job) return@postDelayed
            view.evaluateJavascript(
                "(function(){ try { return !!(window.fa4uSignedIn || (window.puter && puter.auth && puter.auth.isSignedIn && puter.auth.isSignedIn())); } catch (e) { return false; } })()"
            ) { raw ->
                if (currentSignInJob != job) return@evaluateJavascript
                if (raw == "true") {
                    view.evaluateJavascript(
                        "window.fa4uJobs && (window.fa4uJobs[" + JSONObject.quote(job) + "] = { state: 'done', length: 0, data: '' });",
                        null
                    )
                } else if (tries < 5) {
                    resolveSignInFromCurrentState(tries + 1)
                }
            }
        }, 500)
    }

    private fun pollSignIn(view: WebView, job: String, tries: Int, done: (Result<Unit>) -> Unit) {
        main.postDelayed({
            view.evaluateJavascript("window.fa4uStatus ? window.fa4uStatus(" + JSONObject.quote(job) + ") : '{\"state\":\"missing\"}'") { raw ->
                val status = try {
                    JSONObject(unquote(raw))
                } catch (e: Exception) {
                    JSONObject().put("state", "missing")
                }
                fun withConsole(message: String): String {
                    val issue = lastConsoleIssue
                    return if (issue.isNullOrEmpty()) message else "$message ($issue)"
                }
                when (status.optString("state")) {
                    // 500 * 300ms = 2.5 minutes: long enough for a real sign-in
                    // (password, maybe 2FA), short enough that a genuinely
                    // stuck popup surfaces a "timed out" notice instead of
                    // leaving the button animating for six minutes with no
                    // feedback at all.
                    "pending" -> if (tries < 500) pollSignIn(view, job, tries + 1, done) else {
                        currentSignInJob = null
                        done(Result.failure(IllegalStateException(withConsole("timed out"))))
                    }
                    "missing" -> {
                        currentSignInJob = null
                        done(Result.failure(IllegalStateException(withConsole("Puter did not load"))))
                    }
                    "done" -> {
                        currentSignInJob = null
                        view.evaluateJavascript("window.fa4uForget && window.fa4uForget(" + JSONObject.quote(job) + ")", null)
                        done(Result.success(Unit))
                    }
                    else -> {
                        currentSignInJob = null
                        view.evaluateJavascript("window.fa4uForget && window.fa4uForget(" + JSONObject.quote(job) + ")", null)
                        done(Result.failure(IllegalStateException(withConsole(status.optString("error", "Puter failed")))))
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
