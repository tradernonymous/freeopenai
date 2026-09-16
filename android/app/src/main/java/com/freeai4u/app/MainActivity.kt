package com.freeai4u.app

import android.app.Dialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

// The deployed web app, in a hardened WebView, behind a native sign-in that
// keeps the phone logged in. The page is the product -- every feature the
// site has on a phone is here because it *is* the site -- and the shell's
// job is the part a browser tab cannot do: sign in once and stay signed in,
// keep navigation on the configured server, pick files, save downloads, and
// never let a screenshot or a backup carry any of it off the phone.
class MainActivity : ComponentActivity() {
    private enum class Mode { SIGN_IN, OFFLINE, BUSY }

    private lateinit var store: SecureStore
    private lateinit var web: WebView
    private lateinit var card: View
    private lateinit var message: TextView
    private lateinit var serverField: EditText
    private lateinit var usernameField: EditText
    private lateinit var passwordField: EditText
    private lateinit var errorText: TextView
    private lateinit var primary: Button
    private lateinit var secondary: Button
    private lateinit var progress: ProgressBar
    private lateinit var note: TextView

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var mode = Mode.BUSY
    private var baseUrl = ""
    private var origin = ""
    private var pageLoaded = false
    private var mainFrameFailed = false
    private var reloginAttempts = 0
    @Volatile private var lastSessionCheck = 0L
    @Volatile private var signedOutByPage = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val pickFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Screenshots, screen recordings and the recents thumbnail all come
        // out blank: what is not capturable cannot leak through a gallery
        // sync or a shoulder-surfed screenshot.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        val root = findViewById<View>(R.id.root)
        // Status bar, gesture bar and the keyboard all become padding on the
        // root, so the page shrinks above the keyboard instead of under it.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        store = SecureStore(this)
        bindViews()
        setUpWebView()
        onBackPressedDispatcher.addCallback(this) {
            if (web.visibility == View.VISIBLE && web.canGoBack()) {
                web.goBack()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }
        launch()
    }

    override fun onResume() {
        super.onResume()
        // A phone that comes back after hours re-checks the session quietly,
        // which also renews it server-side before it can lapse mid-chat.
        if (pageLoaded && System.currentTimeMillis() - lastSessionCheck > SESSION_RECHECK_MS) {
            checkSession(quiet = true)
        }
    }

    override fun onDestroy() {
        web.destroy()
        io.shutdownNow()
        super.onDestroy()
    }

    private fun bindViews() {
        web = findViewById(R.id.web)
        card = findViewById(R.id.card)
        message = findViewById(R.id.message)
        serverField = findViewById(R.id.server)
        usernameField = findViewById(R.id.username)
        passwordField = findViewById(R.id.password)
        errorText = findViewById(R.id.error)
        primary = findViewById(R.id.primary)
        secondary = findViewById(R.id.secondary)
        progress = findViewById(R.id.progress)
        note = findViewById(R.id.note)
        primary.setOnClickListener { onPrimary() }
        secondary.setOnClickListener { showCard(Mode.SIGN_IN, null) }
        passwordField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                onPrimary()
                true
            } else {
                false
            }
        }
    }

    private fun userAgentSuffix(): String = "FreeAI4U/" + BuildConfig.VERSION_NAME

    private fun setUpWebView() {
        WebShell.harden(web, userAgentSuffix(), popup = false)
        web.webViewClient = ShellClient()
        web.webChromeClient = ShellChrome()
        web.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            when {
                url.startsWith("data:") -> {
                    val decoded = decodeDataUrl(url)
                    if (decoded == null) toast(getString(R.string.save_failed)) else save(name, decoded.first, decoded.second)
                }
                url.startsWith("blob:") -> blobToDataUrl(url) { dataUrl ->
                    val decoded = dataUrl?.let { decodeDataUrl(it) }
                    if (decoded == null) {
                        toast(getString(R.string.save_failed))
                    } else {
                        val mime = if (mimeType.isNullOrEmpty() || mimeType == "application/octet-stream") decoded.first else mimeType
                        save(name, mime, decoded.second)
                    }
                }
                sameOrigin(origin, url) -> downloadViaManager(url, name, mimeType)
                else -> openExternally(Uri.parse(url))
            }
        }
    }

    // --- The native card ---------------------------------------------------

    private fun showCard(newMode: Mode, text: String?) {
        mode = newMode
        card.visibility = View.VISIBLE
        val signIn = newMode == Mode.SIGN_IN
        val fields = if (signIn) View.VISIBLE else View.GONE
        serverField.visibility = fields
        usernameField.visibility = fields
        passwordField.visibility = fields
        note.visibility = fields
        errorText.text = text ?: ""
        errorText.visibility = if (text != null && newMode != Mode.BUSY) View.VISIBLE else View.GONE
        progress.visibility = if (newMode == Mode.BUSY) View.VISIBLE else View.GONE
        primary.visibility = if (newMode == Mode.BUSY) View.GONE else View.VISIBLE
        primary.text = getString(if (signIn) R.string.sign_in else R.string.retry)
        secondary.visibility = if (newMode == Mode.OFFLINE) View.VISIBLE else View.GONE
        message.text = when (newMode) {
            Mode.SIGN_IN -> "Sign in with one of this server's app accounts. The phone stays signed in from then on."
            Mode.OFFLINE -> "Could not reach the server."
            Mode.BUSY -> text ?: getString(R.string.connecting)
        }
        if (signIn) {
            if (serverField.text.isEmpty()) serverField.setText(store.server ?: BuildConfig.DEFAULT_SERVER)
            if (usernameField.text.isEmpty()) usernameField.setText(store.username ?: BuildConfig.DEFAULT_USERNAME)
            val focus = if (serverField.text.isEmpty()) serverField else if (usernameField.text.isEmpty()) usernameField else passwordField
            focus.requestFocus()
        }
    }

    private fun showPage() {
        card.visibility = View.GONE
        web.visibility = View.VISIBLE
    }

    private fun showError(text: String) {
        errorText.text = text
        errorText.visibility = View.VISIBLE
    }

    private fun onPrimary() {
        if (mode == Mode.OFFLINE) {
            launch()
            return
        }
        if (mode != Mode.SIGN_IN) return
        when (val checked = normalizeBaseUrl(serverField.text.toString())) {
            is BaseUrlResult.Problem -> showError(checked.message)
            is BaseUrlResult.Ok -> {
                val user = usernameField.text.toString().trim()
                val pass = passwordField.text.toString()
                if (user.isEmpty() || pass.isEmpty()) {
                    showError("Enter the username and the password.")
                    return
                }
                if (checked.url != store.server) {
                    // A different server: nothing from the old one carries over.
                    store.clearSession()
                    WebShell.setSessionCookie(baseUrl, null)
                    pageLoaded = false
                }
                store.server = checked.url
                baseUrl = checked.url
                origin = originOf(baseUrl)
                passwordField.setText("")
                signIn(user, pass, reloadAfter = true)
            }
        }
    }

    // --- Sign-in flow ------------------------------------------------------

    private fun launch() {
        baseUrl = store.server ?: ""
        origin = try {
            if (baseUrl.isEmpty()) "" else originOf(baseUrl)
        } catch (e: Exception) {
            ""
        }
        if (origin.isEmpty()) {
            store.server = null
            showCard(Mode.SIGN_IN, null)
            return
        }
        when (launchStep(store.server, store.username, store.password, store.session)) {
            Launch.ASK_SERVER, Launch.ASK_PASSWORD -> showCard(Mode.SIGN_IN, null)
            Launch.CHECK_SESSION -> checkSession(quiet = false)
            Launch.SIGN_IN -> signIn(store.username ?: "", store.password ?: "", reloadAfter = false)
        }
    }

    private fun checkSession(quiet: Boolean) {
        if (!quiet) showCard(Mode.BUSY, null)
        val client = ChatApi(baseUrl)
        client.sessionCookie = store.session
        io.execute {
            try {
                client.session()
                client.renewedCookie?.let { store.session = it }
                lastSessionCheck = System.currentTimeMillis()
                main.post {
                    WebShell.setSessionCookie(baseUrl, store.session)
                    if (!quiet || !pageLoaded) openPage(reload = false)
                }
            } catch (e: ApiException) {
                main.post {
                    if (e.authRequired) {
                        store.clearSession()
                        val user = store.username
                        val pass = store.password
                        if (user != null && pass != null) {
                            signIn(user, pass, reloadAfter = pageLoaded)
                        } else {
                            showCard(Mode.SIGN_IN, "Session expired -- sign in again.")
                        }
                    } else if (!quiet) {
                        showCard(Mode.OFFLINE, e.message)
                    }
                }
            }
        }
    }

    private fun signIn(user: String, pass: String, reloadAfter: Boolean) {
        showCard(Mode.BUSY, getString(R.string.signing_in))
        val client = ChatApi(baseUrl)
        io.execute {
            try {
                val cookie = client.login(user, pass)
                store.username = user
                store.password = pass
                store.session = cookie
                lastSessionCheck = System.currentTimeMillis()
                main.post {
                    WebShell.setSessionCookie(baseUrl, cookie)
                    openPage(reload = reloadAfter)
                }
            } catch (e: ApiException) {
                main.post {
                    if (e.authRequired) {
                        // The stored password is wrong now; forget it rather
                        // than retry it against the login rate limit.
                        store.clearSecrets()
                        showCard(Mode.SIGN_IN, e.message)
                    } else {
                        showCard(Mode.OFFLINE, e.message)
                    }
                }
            }
        }
    }

    private fun openPage(reload: Boolean) {
        if (pageLoaded && !reload) {
            showPage()
            return
        }
        showCard(Mode.BUSY, "Loading…")
        mainFrameFailed = false
        web.loadUrl(baseUrl + "/")
    }

    /** The page ran into the login gate -- a redirect to /login.html or a 401
     * on the page itself. Either the user signed out inside the page, in
     * which case the phone forgets the password too, or the session lapsed
     * and the stored password signs in again. A server that keeps refusing
     * a fresh session stops the loop after two tries and asks. */
    private fun onSessionLost() {
        if (signedOutByPage) {
            signedOutByPage = false
            store.clearSecrets()
            WebShell.setSessionCookie(baseUrl, null)
            pageLoaded = false
            web.loadUrl("about:blank")
            passwordField.setText("")
            showCard(Mode.SIGN_IN, null)
            return
        }
        reloginAttempts++
        store.clearSession()
        if (reloginAttempts > 2) {
            reloginAttempts = 0
            showCard(Mode.SIGN_IN, "The server keeps asking for a login. Check the username and password.")
            return
        }
        val user = store.username
        val pass = store.password
        if (user != null && pass != null) {
            signIn(user, pass, reloadAfter = true)
        } else {
            showCard(Mode.SIGN_IN, "Session expired -- sign in again.")
        }
    }

    // --- WebView clients ---------------------------------------------------

    private inner class ShellClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (sameOrigin(origin, url)) {
                if (request.url.path == "/login.html") {
                    if (request.isForMainFrame) onSessionLost()
                    return true
                }
                return false
            }
            if (staysInShell(origin, url)) return false
            openExternally(request.url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (url != null && sameOrigin(origin, url)) mainFrameFailed = false
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (url == null || !sameOrigin(origin, url) || mainFrameFailed) return
            if (Uri.parse(url).path == "/login.html") return
            pageLoaded = true
            reloginAttempts = 0
            showPage()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame || !sameOrigin(origin, request.url.toString())) return
            mainFrameFailed = true
            pageLoaded = false
            showCard(Mode.OFFLINE, error.description?.toString())
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (request.isForMainFrame && errorResponse.statusCode == 401 && sameOrigin(origin, request.url.toString())) {
                onSessionLost()
            }
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            // Seen from a background thread; a flag is all that is set here.
            if (request.method == "POST" && request.url.path == "/api/logout" && sameOrigin(origin, request.url.toString())) {
                signedOutByPage = true
            }
            return null
        }
    }

    private inner class ShellChrome : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = filePathCallback
            return try {
                pickFile.launch(fileChooserParams.createIntent())
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }

        /** A popup the page opens (Puter's sign-in) gets its own locked-down
         * WebView in a full-screen dialog, wired back through the transport
         * so window.opener works. It may load Puter and the app's origin;
         * anything else it tries goes to the browser. */
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (!isUserGesture) return false
            val popup = WebView(this@MainActivity)
            WebShell.harden(popup, userAgentSuffix(), popup = true)
            val dialog = Dialog(this@MainActivity, android.R.style.Theme_Material_NoActionBar)
            dialog.window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
            dialog.setContentView(popup, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            popup.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    if (popupAllowed(origin, url)) return false
                    openExternally(request.url)
                    return true
                }
            }
            popup.webChromeClient = object : WebChromeClient() {
                override fun onCloseWindow(window: WebView) {
                    dialog.dismiss()
                }
            }
            dialog.setOnDismissListener { popup.destroy() }
            dialog.show()
            (resultMsg.obj as WebView.WebViewTransport).webView = popup
            resultMsg.sendToTarget()
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            // Camera, microphone, MIDI: the page asks for none of them, and
            // the manifest holds no permission to grant.
            request.deny()
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }
    }

    // --- Downloads ---------------------------------------------------------

    /** The page hands a download over as a blob: URL, which nothing outside
     * the page can read. So the page is asked to read it: a script fetches
     * the blob and parks it, as a data URL, on a window property that is
     * polled until it fills. No JavaScript bridge is added for this --
     * evaluateJavascript is one-way, and the page keeps no handle into the
     * app. */
    private fun blobToDataUrl(blobUrl: String, onResult: (String?) -> Unit) {
        val quoted = JSONObject.quote(blobUrl)
        web.evaluateJavascript(
            "(function(){var u=" + quoted + ";var s=window.__fa4uBlob=window.__fa4uBlob||{};s[u]='pending';" +
                "fetch(u).then(function(r){return r.blob()}).then(function(b){var f=new FileReader();" +
                "f.onload=function(){s[u]=f.result};f.onerror=function(){s[u]='error'};f.readAsDataURL(b)})" +
                ".catch(function(){s[u]='error'})})();",
            null
        )
        val poll = "(function(){var s=window.__fa4uBlob;if(!s)return 'error';var u=" + quoted +
            ";var v=s[u];if(v&&v!=='pending'){delete s[u];}return v||'error';})()"
        var tries = 0
        val tick = object : Runnable {
            override fun run() {
                web.evaluateJavascript(poll) { raw ->
                    val value = unquote(raw)
                    when {
                        value == null || value == "error" -> onResult(null)
                        value == "pending" -> if (++tries < 100) main.postDelayed(this, 150) else onResult(null)
                        else -> onResult(value)
                    }
                }
            }
        }
        main.postDelayed(tick, 150)
    }

    private fun unquote(raw: String?): String? {
        if (raw == null || raw == "null") return null
        return try {
            JSONArray("[" + raw + "]").getString(0)
        } catch (e: Exception) {
            null
        }
    }

    private fun save(name: String, mime: String, bytes: ByteArray) {
        io.execute {
            val ok = WebShell.saveToDownloads(this, name, mime, bytes)
            main.post { toast(if (ok) getString(R.string.saved_to, name) else getString(R.string.save_failed)) }
        }
    }

    private fun downloadViaManager(url: String, name: String, mimeType: String?) {
        try {
            val request = DownloadManager.Request(Uri.parse(url))
            request.addRequestHeader("Cookie", WebShell.SESSION_COOKIE + "=" + (store.session ?: ""))
            if (!mimeType.isNullOrEmpty()) request.setMimeType(mimeType)
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "FreeAI4U/" + name)
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            toast(getString(R.string.saved_to, name))
        } catch (e: Exception) {
            toast(getString(R.string.save_failed))
        }
    }

    // --- Helpers -----------------------------------------------------------

    private fun openExternally(uri: Uri) {
        val scheme = uri.scheme?.lowercase() ?: return
        if (scheme != "https" && scheme != "http" && scheme != "mailto") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (e: ActivityNotFoundException) {
            toast("No app on this phone can open that link.")
        }
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }

    private companion object {
        const val SESSION_RECHECK_MS = 6 * 60 * 60 * 1000L
    }
}
