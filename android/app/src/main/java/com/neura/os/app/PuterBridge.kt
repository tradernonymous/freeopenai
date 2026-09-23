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
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import com.neura.os.app.data.PUTER_SIGN_IN_POLL_MS
import com.neura.os.app.data.PUTER_SIGN_IN_TIMEOUT_MS
import com.neura.os.app.data.PUTER_WAIT_URL
import com.neura.os.app.data.puterSignInUrl
import com.neura.os.app.data.puterTokenFrom
import com.neura.os.app.data.puterWaitBody
import com.neura.os.app.data.setPuterTokenScript
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** The user's own Puter account, reached from the app. A hidden WebView loads
 * /puter-bridge.html from the app's own server and runs puter.ai.txt2img and
 * puter.ai.chat there. Kotlin reads the result by polling with
 * evaluateJavascript, in slices: no JavaScript bridge is added, so the page
 * gets no handle into the app. The page is reloaded for every job because
 * Puter reads its sign-in only when it loads. Signing in itself is the one
 * exception to "hidden": signIn() shows the page full-screen for its Continue
 * tap (see showForSignIn), and that tap opens Puter's own popup in a visible
 * dialog (see openSignInPopup below), which is the only way this WebView's
 * storage ever gets a signed-in session in the first place. */
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
    // Bumped on every load() call; lets a load's own timeout tell a stale
    // attempt apart from the current one, the same way currentSignInJob does
    // for pollSignIn. See load()'s own comment for why this exists.
    private var loadGeneration = 0
    // Back while the sign-in prompt is on screen cancels it instead of
    // navigating the app underneath; removed when the job ends.
    private var signInBack: OnBackPressedCallback? = null

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
        val generation = ++loadGeneration
        // A bounded wait for onPageFinished, in addition to it. Every failure
        // path below (attach failure, a signed-in-check timeout later) had a
        // message; a page that starts loading and never finishes -- most
        // plausibly a hung fetch of https://js.puter.com/v2/ itself -- did
        // not, because nothing downstream of a successful load() ever got a
        // chance to run: pollSignIn's own 2.5-minute timeout only starts
        // once this callback has already fired once. Left the button
        // animating forever with no way out, which is the exact class of bug
        // 7faa151 set out to end but did not reach, since that commit's
        // fixes are all inside code load() has not gotten to yet at this
        // point. The generation check is what lets this no-op once the real
        // onPageFinished (or a later load() call) has already resolved it.
        main.postDelayed({
            if (generation != loadGeneration) return@postDelayed
            val callback = onLoaded ?: return@postDelayed
            onLoaded = null
            val message = "Puter's page did not finish loading" + (lastConsoleIssue?.let { " ($it)" } ?: "")
            // The page may be far enough along to answer even though
            // onPageFinished never fired -- a hung subresource (js.puter.com
            // itself being the likeliest) stops the load event without
            // stopping the inline scripts that already ran, and neuraDiagnose
            // is in the head precisely so it is one of them.
            failWithDiagnosis(web, message) { callback(Result.failure(IllegalStateException(it))) }
        }, LOAD_TIMEOUT_MS)

        val existing = web
        if (existing != null) {
            onLoaded = then
            existing.loadUrl(baseUrl() + "/puter-bridge.html")
            return
        }
        val created = WebView(context)
        // false: this page itself is not a popup, so it may open the one
        // popup neuraSignIn asks for -- the reverse of the flag a popup
        // window gets in openSignInPopup below, which must not open one of
        // its own.
        WebShell.harden(created, "NeuraOS/" + BuildConfig.VERSION_NAME, popup = false)
        created.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean =
                !sameOrigin(originOf(baseUrl()), request.url.toString())

            override fun onPageFinished(v: WebView, url: String?) {
                // No generation check here: this WebViewClient is created
                // once and reused across every later load() call that
                // reuses `web` (the common case, since chat/draw/signIn all
                // share one WebView once it exists), so a generation number
                // captured at creation time would be stale on every reload
                // after the first. onLoaded itself already says whether
                // there is a call in flight to resolve; the timeout above is
                // the one place a captured generation is actually needed,
                // to stop a late timer from stealing a newer call's
                // callback -- a real navigation event has no equivalent
                // staleness risk.
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
        // show() before sendToTarget(), not after. setContentView puts the
        // popup in the dialog's view tree, but a dialog that has not been
        // shown has no window, so the WebView is not attached to one yet --
        // and Chromium's documented contract for this callback is that the
        // new WebView is in a hierarchy *before* the transport is sent.
        // Handing it the transport first meant the popup's first navigation
        // could be delivered to a detached view, which renders nothing: a
        // full-screen dialog with a blank page in it, which is close enough
        // to "no sign-in window appeared" to be reported as exactly that.
        dialog.show()
        (resultMsg.obj as WebView.WebViewTransport).webView = popup
        resultMsg.sendToTarget()
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
            done("sign in to the app first: the Puter page comes from your NeuraOS server")
            return
        }
        load { result ->
            val view = web
            if (result.isFailure) {
                done(result.exceptionOrNull()?.message ?: "could not open the Puter page")
            } else if (view == null) {
                done("the Puter page could not be created on this phone")
            } else {
                val job = "c" + System.nanoTime()
                view.evaluateJavascript("window.neuraChat && window.neuraChat(" + JSONObject.quote(job) + "," + JSONObject.quote(body) + ");", null)
                followChat(view, job, 0, 0, onDelta, done)
            }
        }
    }

    /** Reads whatever the job has written since [read] and asks again until it
     * ends. A job that never grows is given 5 minutes, the same ceiling the
     * drawing path uses. */
    private fun followChat(view: WebView, job: String, read: Int, tries: Int, onDelta: (String) -> Unit, done: (String?) -> Unit) {
        main.postDelayed({
            view.evaluateJavascript("window.neuraStatus ? window.neuraStatus(" + JSONObject.quote(job) + ") : '{\"state\":\"missing\"}'") { raw ->
                val status = try {
                    JSONObject(unquote(raw))
                } catch (e: Exception) {
                    JSONObject().put("state", "missing")
                }
                val state = status.optString("state")
                val length = status.optInt("length")
                if (state == "missing") {
                    failWithDiagnosis(view, "Puter did not load") { done(it) }
                    return@evaluateJavascript
                }
                if (length > read) {
                    view.evaluateJavascript("window.neuraChunk(" + JSONObject.quote(job) + "," + read + "," + (length - read) + ")") { piece ->
                        val text = unquote(piece)
                        if (text.isNotEmpty()) onDelta(text)
                        val now = read + text.length
                        if (state == "pending") followChat(view, job, now, 0, onDelta, done)
                        else {
                            view.evaluateJavascript("window.neuraForget && window.neuraForget(" + JSONObject.quote(job) + ")", null)
                            done(if (state == "done") null else status.optString("error", "Puter stopped without saying why"))
                        }
                    }
                    return@evaluateJavascript
                }
                when {
                    state == "pending" && tries < 600 -> followChat(view, job, read, tries + 1, onDelta, done)
                    state == "pending" -> done("Puter sent nothing new for 3 minutes, so the reply was stopped")
                    else -> {
                        view.evaluateJavascript("window.neuraForget && window.neuraForget(" + JSONObject.quote(job) + ")", null)
                        done(if (state == "done") null else status.optString("error", "Puter stopped without saying why"))
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
            done(Result.failure(IllegalStateException("sign in to the app first: the Puter page comes from your NeuraOS server")))
            return
        }
        load { result ->
            val view = web
            if (result.isFailure) {
                done(Result.failure(result.exceptionOrNull() ?: IllegalStateException("could not open the Puter page")))
            } else if (view == null) {
                done(Result.failure(IllegalStateException("the Puter page could not be created on this phone")))
            } else {
                val options = JSONObject()
                if (model.isNotEmpty()) options.put("model", model)
                if (ratio != null) options.put("ratio", JSONObject().put("w", ratio.first).put("h", ratio.second))
                if (source != null) options.put("source", source)
                val job = "j" + System.nanoTime()
                view.evaluateJavascript("window.neuraDraw && window.neuraDraw(" + JSONObject.quote(job) + "," + JSONObject.quote(prompt.take(2000)) + "," + options + ");", null)
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
                done(Result.failure(IllegalStateException("the Puter page could not be created on this phone")))
            } else {
                val job = "s" + System.nanoTime()
                currentSignInJob = job
                lastConsoleIssue = null
                showForSignIn(view)
                view.evaluateJavascript("window.neuraSignIn && window.neuraSignIn(" + JSONObject.quote(job) + ");", null)
                pollSignIn(view, job, 0) { outcome ->
                    hideAfterSignIn(view)
                    done(outcome)
                }
            }
        }
    }

    // Bumped by every browser sign-in, so a second tap retires the first
    // one's wait instead of racing it; the job is what cancelling stops.
    private var browserSignIn = 0
    private var browserSignInJob: Job? = null

    /** Signs in to Puter in the phone's real browser (data/PuterSignIn.kt):
     * [open] shows Puter's sign-in page in a Custom Tab, where Google, Apple
     * and Microsoft all work, and a coroutine in [scope] (the activity's)
     * waits on Puter's /login/wait for that session's token, exactly as
     * Puter's SDK does on a page with no popup. The token goes straight into
     * the hidden bridge page's SDK (setAuthToken) and is never logged or
     * stored anywhere else. A second tap retires the first wait; the activity
     * going away ends it and says so through [done]. Call on the main thread. */
    fun signInWithBrowser(scope: CoroutineScope, open: (String) -> Unit, done: (Result<Unit>) -> Unit) {
        if (baseUrl().isEmpty()) {
            done(Result.failure(IllegalStateException("not signed in to the app yet")))
            return
        }
        val attempt = ++browserSignIn
        browserSignInJob?.cancel()
        val session = UUID.randomUUID().toString()
        open(puterSignInUrl(session))
        browserSignInJob = scope.launch {
            var lastProblem: String? = null
            try {
                val found = withTimeoutOrNull(PUTER_SIGN_IN_TIMEOUT_MS) {
                    var token: String? = null
                    while (token == null) {
                        token = withContext(Dispatchers.IO) {
                            try {
                                askForToken(session)
                            } catch (e: Exception) {
                                lastProblem = e.javaClass.simpleName
                                null
                            }
                        }
                        if (token == null) delay(PUTER_SIGN_IN_POLL_MS)
                    }
                    token
                }
                if (found == null) {
                    done(Result.failure(IllegalStateException(
                        "no sign-in arrived from Puter within 5 minutes" + (lastProblem?.let { " (last network problem: $it)" } ?: "") +
                            ". Tap Sign in again and finish in the browser tab that opens.",
                    )))
                } else {
                    giveTokenToPage(found, done)
                }
            } catch (e: CancellationException) {
                // A newer tap took over (that one reports), or the app's
                // window closed mid-wait: say so, so the button is not stuck.
                if (attempt == browserSignIn) done(Result.failure(IllegalStateException("the sign-in was interrupted. Tap Sign in again.")))
                throw e
            }
        }
    }

    /** One POST to /login/wait: the token, or null while there is none yet. */
    private fun askForToken(session: String): String? {
        val conn = URL(PUTER_WAIT_URL).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15_000
            // Puter may hold the request open until the sign-in finishes.
            conn.readTimeout = 60_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(puterWaitBody(session).toByteArray(Charsets.UTF_8)) }
            if (conn.responseCode in 200..299) puterTokenFrom(conn.inputStream.bufferedReader().use { it.readText().take(16_384) }) else null
        } finally {
            conn.disconnect()
        }
    }

    /** Loads the bridge page, gives its SDK the token, and checks it took. */
    private fun giveTokenToPage(token: String, done: (Result<Unit>) -> Unit) {
        load { result ->
            val view = web
            if (result.isFailure || view == null) {
                done(Result.failure(result.exceptionOrNull() ?: IllegalStateException("the Puter page could not be created on this phone")))
                return@load
            }
            view.evaluateJavascript(setPuterTokenScript(token)) { raw ->
                when (unquote(raw)) {
                    "ok" -> confirmSignedIn(view, 0, done)
                    "nosdk" -> failWithDiagnosis(view, "Puter's script did not load, so the sign-in could not be kept") {
                        done(Result.failure(IllegalStateException(it)))
                    }
                    else -> failWithDiagnosis(view, "Puter refused the sign-in" + (lastConsoleIssue?.let { " ($it)" } ?: "")) {
                        done(Result.failure(IllegalStateException(it)))
                    }
                }
            }
        }
    }

    /** setAuthToken fetches the account in the background; give it ~5 s. */
    private fun confirmSignedIn(view: WebView, tries: Int, done: (Result<Unit>) -> Unit) {
        main.postDelayed({
            view.evaluateJavascript(
                "(function(){ try { return !!(window.neuraSignedIn || (window.puter && puter.auth && puter.auth.isSignedIn && puter.auth.isSignedIn())); } catch (e) { return false; } })()"
            ) { raw ->
                when {
                    raw == "true" -> done(Result.success(Unit))
                    tries < 10 -> confirmSignedIn(view, tries + 1, done)
                    else -> failWithDiagnosis(view, "Puter sent a sign-in, but the page still says nobody is signed in") {
                        done(Result.failure(IllegalStateException(it)))
                    }
                }
            }
        }, 500)
    }

    /** Puter opens its sign-in window only from a real tap on its own page
     * (hasUserActivation() in Puter's Auth module); a call arriving through
     * evaluateJavascript is not one, and without it Puter shows its consent
     * prompt inside this page -- which, at 1x1 and invisible, nobody could
     * see, so sign-in sat on "signing in" forever. So for exactly as long as
     * a sign-in is open the page is full-screen and tappable, showing its own
     * Continue button; hideAfterSignIn puts it back. */
    private fun showForSignIn(view: WebView) {
        view.layoutParams = view.layoutParams.apply {
            width = ViewGroup.LayoutParams.MATCH_PARENT
            height = ViewGroup.LayoutParams.MATCH_PARENT
        }
        view.visibility = View.VISIBLE
        view.bringToFront()
        view.requestFocus()
        val activity = context as? ComponentActivity ?: return
        signInBack?.remove()
        val callback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                view.evaluateJavascript("window.neuraCancelSignIn && window.neuraCancelSignIn()", null)
            }
        }
        signInBack = callback
        activity.onBackPressedDispatcher.addCallback(callback)
    }

    private fun hideAfterSignIn(view: WebView) {
        signInBack?.remove()
        signInBack = null
        view.visibility = View.INVISIBLE
        view.layoutParams = view.layoutParams.apply {
            width = 1
            height = 1
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
                "(function(){ try { return !!(window.neuraSignedIn || (window.puter && puter.auth && puter.auth.isSignedIn && puter.auth.isSignedIn())); } catch (e) { return false; } })()"
            ) { raw ->
                if (currentSignInJob != job) return@evaluateJavascript
                if (raw == "true") {
                    view.evaluateJavascript(
                        "window.neuraJobs && (window.neuraJobs[" + JSONObject.quote(job) + "] = { state: 'done', length: 0, data: '' });",
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
            view.evaluateJavascript("window.neuraStatus ? window.neuraStatus(" + JSONObject.quote(job) + ") : '{\"state\":\"missing\"}'") { raw ->
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
                    // 700 * 300ms = 3.5 minutes: the page's own 110s clock
                    // starts only at the Continue tap, so this leaves room
                    // for that tap plus a real sign-in (password, maybe 2FA)
                    // and lets the page report *why* first. The prompt has
                    // Cancel and Back, so a long budget strands nobody.
                    "pending" -> if (tries < 700) pollSignIn(view, job, tries + 1, done) else {
                        currentSignInJob = null
                        failWithDiagnosis(view, withConsole("the Puter sign-in was still open after 3.5 minutes, so it was stopped")) {
                            done(Result.failure(IllegalStateException(it)))
                        }
                    }
                    "missing" -> {
                        currentSignInJob = null
                        failWithDiagnosis(view, withConsole("Puter did not load")) {
                            done(Result.failure(IllegalStateException(it)))
                        }
                    }
                    "done" -> {
                        currentSignInJob = null
                        view.evaluateJavascript("window.neuraForget && window.neuraForget(" + JSONObject.quote(job) + ")", null)
                        done(Result.success(Unit))
                    }
                    else -> {
                        currentSignInJob = null
                        view.evaluateJavascript("window.neuraForget && window.neuraForget(" + JSONObject.quote(job) + ")", null)
                        failWithDiagnosis(view, withConsole(status.optString("error", "Puter stopped without saying why"))) {
                            done(Result.failure(IllegalStateException(it)))
                        }
                    }
                }
            }
        }, 300)
    }

    /** Appends the bridge page's own account of itself to a failure message
     * before reporting it. neuraDiagnose is defined in the page's head, ahead
     * of Puter's SDK and of everything that could throw, so it answers even
     * when nothing else on the page does -- which is the whole point: every
     * failure below this line otherwise reads as one of "timed out", "Puter
     * did not load" or "Puter failed", and those three words have now cost
     * three round trips without once saying whether the SDK arrived, whether
     * a window was ever asked for, or whether storage works. Asynchronous,
     * so the caller hands in what to do with the finished message. */
    private fun failWithDiagnosis(view: WebView?, message: String, report: (String) -> Unit) {
        if (view == null) {
            report(message)
            return
        }
        view.evaluateJavascript("window.neuraDiagnose ? window.neuraDiagnose() : ''") { raw ->
            val detail = unquote(raw)
            report(if (detail.isEmpty()) message else "$message $detail")
        }
    }

    private fun unquote(raw: String?): String = try {
        JSONArray("[" + (raw ?: "null") + "]").optString(0, "")
    } catch (e: Exception) {
        ""
    }

    private fun poll(view: WebView, job: String, tries: Int, done: (Result<Pair<String, ByteArray>>) -> Unit) {
        main.postDelayed({
            view.evaluateJavascript("window.neuraStatus ? window.neuraStatus(" + JSONObject.quote(job) + ") : '{\"state\":\"missing\"}'") { raw ->
                val status = try {
                    JSONObject(unquote(raw))
                } catch (e: Exception) {
                    JSONObject().put("state", "missing")
                }
                when (status.optString("state")) {
                    "pending" -> if (tries < 300) poll(view, job, tries + 1, done) else done(Result.failure(IllegalStateException("Puter took longer than 2.5 minutes to draw, so it was stopped")))
                    "done" -> readChunks(view, job, status.optInt("length"), StringBuilder(), done)
                    "missing" -> failWithDiagnosis(view, "Puter did not load") {
                        done(Result.failure(IllegalStateException(it)))
                    }
                    else -> done(Result.failure(IllegalStateException(status.optString("error", "Puter stopped without saying why"))))
                }
            }
        }, 500)
    }

    private fun readChunks(view: WebView, job: String, length: Int, out: StringBuilder, done: (Result<Pair<String, ByteArray>>) -> Unit) {
        if (out.length >= length) {
            view.evaluateJavascript("window.neuraForget && window.neuraForget(" + JSONObject.quote(job) + ")", null)
            val decoded = decodeDataUrl(out.toString())
            if (decoded == null) done(Result.failure(IllegalStateException("Puter answered, but not with a picture this app can read")))
            else done(Result.success(decoded))
            return
        }
        view.evaluateJavascript("window.neuraChunk(" + JSONObject.quote(job) + "," + out.length + "," + CHUNK + ")") { raw ->
            val piece = unquote(raw)
            if (piece.isEmpty()) {
                done(Result.failure(IllegalStateException("the picture from Puter could not be read back in full")))
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
        // Generous for a same-network page load (the WebView is loading from
        // this app's own server, plus one external script tag), short enough
        // that a genuinely hung load surfaces a message rather than leaving
        // the caller's button animating with no way out.
        const val LOAD_TIMEOUT_MS = 20_000L
    }
}
