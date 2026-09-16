package com.freeai4u.app

import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

// Pure protocol helpers (unit-tested on the JVM) plus one thin HTTP client
// for the two calls that happen before the page loads: sign in, and check
// the session. Everything the server sends is treated as untrusted: JSON is
// parsed defensively and the only credential ever held is the fo_auth
// session this deployment issued.

sealed interface BaseUrlResult {
    data class Ok(val url: String) : BaseUrlResult
    data class Problem(val message: String) : BaseUrlResult
}

private fun isLocalHost(host: String): Boolean {
    if (host == "localhost" || host == "127.0.0.1" || host == "::1") return true
    if (host.startsWith("10.") || host.startsWith("192.168.")) return true
    if (host.startsWith("172.")) {
        val second = host.split('.').getOrNull(1)?.toIntOrNull()
        if (second != null && second in 16..31) return true
    }
    return false
}

/** Normalises a typed server address. Plain hostnames gain https://; http://
 * only ever crosses the room (loopback / RFC1918), never the internet. */
fun normalizeBaseUrl(raw: String): BaseUrlResult {
    val text = raw.trim().trimEnd('/')
    if (text.isEmpty()) return BaseUrlResult.Problem("Enter the server address first.")
    val lower = text.lowercase()
    if (lower.startsWith("https://")) return BaseUrlResult.Ok(text)
    if (lower.startsWith("http://")) {
        val host = lower.removePrefix("http://").substringBefore(':').substringBefore('/')
        if (host.isEmpty()) return BaseUrlResult.Problem("That address has no host.")
        if (isLocalHost(host)) return BaseUrlResult.Ok(text)
        return BaseUrlResult.Problem("Only https:// leaves this phone. http:// is refused outside your own network.")
    }
    return BaseUrlResult.Ok("https://" + text)
}

/** scheme://host[:port], lower-cased: what every navigation inside the shell
 * is compared against. */
fun originOf(url: String): String {
    val parsed = URL(url)
    val port = if (parsed.port == -1 || parsed.port == parsed.defaultPort) "" else ":" + parsed.port
    return parsed.protocol.lowercase() + "://" + parsed.host.lowercase() + port
}

/** True when a URL is on the app's own origin. */
fun sameOrigin(origin: String, url: String?): Boolean {
    if (url == null || origin.isEmpty()) return false
    return try {
        originOf(url) == origin
    } catch (e: Exception) {
        false
    }
}

private fun httpsHost(url: String): String? {
    return try {
        val parsed = URL(url)
        if (parsed.protocol.lowercase() != "https") null else parsed.host.lowercase()
    } catch (e: Exception) {
        null
    }
}

/** Where a main-frame navigation may go without leaving the WebView: the
 * app's own origin, plus GitHub's sign-in, which the page's "connect GitHub"
 * flow round-trips through and straight back. Everything else -- a link in a
 * reply, a provider's site -- opens in the phone's browser, where it belongs. */
fun staysInShell(origin: String, url: String): Boolean {
    if (sameOrigin(origin, url)) return true
    return httpsHost(url) == "github.com"
}

/** Where a popup the page opens may load: Puter's sign-in, which the page's
 * keyless provider needs and which answers the page through window.opener.
 * A popup anywhere else is handed to the browser instead. */
fun popupAllowed(origin: String, url: String?): Boolean {
    if (url == null) return false
    if (sameOrigin(origin, url)) return true
    val host = httpsHost(url) ?: return false
    return host == "puter.com" || host.endsWith(".puter.com")
}

private val WEBVIEW_BLOCKED_SIGN_IN_HOSTS = setOf(
    "accounts.google.com",
    "appleid.apple.com",
    "login.live.com",
    "login.microsoftonline.com",
    "www.facebook.com",
    "m.facebook.com",
)

/** "Continue with Google / Apple / Microsoft" pages. Those providers refuse to
 * sign in inside an app's embedded browser (Google answers
 * disallowed_useragent), and a round trip through the phone's browser cannot
 * hand the result back to the popup that asked. So the app says so plainly
 * instead of opening a flow that can only dead-end. Disguising the WebView as
 * a browser to get past that check is exactly what those providers ban. */
fun blockedInWebView(url: String?): Boolean {
    if (url == null) return false
    val host = httpsHost(url) ?: return false
    return host in WEBVIEW_BLOCKED_SIGN_IN_HOSTS
}

/** Which launch step follows from what the phone holds. Pure, so it is the
 * part of the sign-in flow that is tested rather than described. */
enum class Launch { ASK_SERVER, ASK_PASSWORD, CHECK_SESSION, SIGN_IN }

fun launchStep(server: String?, username: String?, password: String?, session: String?): Launch {
    if (server.isNullOrBlank()) return Launch.ASK_SERVER
    if (!session.isNullOrEmpty()) return Launch.CHECK_SESSION
    if (!username.isNullOrBlank() && !password.isNullOrEmpty()) return Launch.SIGN_IN
    return Launch.ASK_PASSWORD
}

/** A data: URL split into its media type and bytes, or null when it is not
 * one. Base64 is decoded with the MIME decoder, which tolerates the line
 * breaks some encoders leave in. */
fun decodeDataUrl(url: String): Pair<String, ByteArray>? {
    if (!url.startsWith("data:")) return null
    val comma = url.indexOf(',')
    if (comma < 0) return null
    val meta = url.substring(5, comma)
    val payload = url.substring(comma + 1)
    val mime = meta.substringBefore(';').ifEmpty { "application/octet-stream" }
    val bytes = try {
        if (meta.contains(";base64")) {
            java.util.Base64.getMimeDecoder().decode(payload)
        } else {
            java.net.URLDecoder.decode(payload, "UTF-8").toByteArray(Charsets.UTF_8)
        }
    } catch (e: Exception) {
        return null
    }
    return mime to bytes
}

data class SessionState(val gated: Boolean, val user: String?)

class ApiException(message: String, val authRequired: Boolean = false) : Exception(message)

/** The fo_auth session value out of a Set-Cookie header, or null. The value
 * travels to the first semicolon untouched: it is opaque to us by design. */
fun parseSessionCookie(setCookie: String?, name: String = "fo_auth"): String? {
    if (setCookie == null) return null
    for (part in setCookie.split(',')) {
        val segments = part.split(';')
        if (segments.isEmpty()) continue
        val pair = segments[0].trim()
        val cut = pair.indexOf('=')
        if (cut <= 0) continue
        if (pair.substring(0, cut).trim() == name) {
            val value = pair.substring(cut + 1).trim()
            if (value.isNotEmpty()) return value
        }
    }
    return null
}

/** Thin client for this repo's own server routes only. The only credential it
 * ever holds is the fo_auth session cookie this deployment issued after a
 * username/password login. */
class ChatApi(
    private val baseUrl: String,
    private val opener: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }
) {
    var sessionCookie: String? = null

    /** Set when the server reissued the session on the last call: the value
     * to keep from now on. */
    var renewedCookie: String? = null
        private set

    private fun authed(conn: HttpURLConnection) {
        val cookie = sessionCookie
        if (!cookie.isNullOrEmpty()) conn.setRequestProperty("Cookie", "fo_auth=" + cookie)
    }

    /** Username/password login against /api/login. Returns the session value
     * to store; throws ApiException carrying the server's own refusal. */
    fun login(username: String, password: String): String {
        var conn: HttpURLConnection? = null
        try {
            conn = opener(URL(baseUrl + "/api/login"))
            conn.connectTimeout = 15000
            conn.readTimeout = 30000
            conn.instanceFollowRedirects = false
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")
            val payload = JSONObject()
            payload.put("username", username)
            payload.put("password", password)
            conn.outputStream.bufferedWriter().use { it.write(payload.toString()) }
            val code = conn.responseCode
            if (code == 429) {
                // A throttle, not a wrong password: the stored one stays.
                throw ApiException("Too many attempts -- try again in a few minutes.")
            }
            if (code != 200) {
                val message = try {
                    val body = conn.errorStream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
                    val obj = JSONObject(body)
                    obj.optString("error", "Invalid username or password.")
                } catch (e: Exception) {
                    "Invalid username or password."
                }
                throw ApiException(if (message.isNotEmpty()) message else "Invalid username or password.", code == 401)
            }
            val setCookie = conn.getHeaderField("Set-Cookie")
            return parseSessionCookie(setCookie)
                ?: throw ApiException("Signed in, but no session came back. Try again.")
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            throw ApiException("Could not reach the server: " + (e.message ?: e.javaClass.simpleName))
        } finally {
            conn?.disconnect()
        }
    }

    /** Best-effort server-side logout; the caller clears the stored cookie
     * regardless of the outcome. */
    fun logout() {
        var conn: HttpURLConnection? = null
        try {
            conn = opener(URL(baseUrl + "/api/logout"))
            conn.connectTimeout = 10000
            conn.readTimeout = 10000
            conn.requestMethod = "POST"
            authed(conn)
            conn.responseCode
        } catch (e: Exception) {
            // Clearing the local cookie is what signs out; the server call is
            // a courtesy that must never fail the action.
        } finally {
            conn?.disconnect()
        }
    }

    /** GET /api/session: whether the stored session still stands, and who it
     * is. A renewed cookie, when the server sends one, lands in renewedCookie.
     * 401 (or a redirect to the login page) surfaces as authRequired. */
    fun session(): SessionState {
        var conn: HttpURLConnection? = null
        renewedCookie = null
        try {
            conn = opener(URL(baseUrl + "/api/session"))
            conn.connectTimeout = 15000
            conn.readTimeout = 30000
            conn.instanceFollowRedirects = false
            conn.requestMethod = "GET"
            conn.setRequestProperty("Accept", "application/json")
            authed(conn)
            val code = conn.responseCode
            if (code == 401 || code == 302) {
                throw ApiException("This server needs a login first.", true)
            }
            if (code !in 200..299) {
                throw ApiException("Server answered HTTP " + code + ".")
            }
            val body = conn.inputStream.bufferedReader().use(BufferedReader::readText)
            val obj = JSONObject(body)
            renewedCookie = parseSessionCookie(conn.getHeaderField("Set-Cookie"))
            val user = obj.optString("user", "")
            return SessionState(obj.optBoolean("gate", false), if (user.isEmpty()) null else user)
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            throw ApiException("Could not reach the server: " + (e.message ?: e.javaClass.simpleName))
        } finally {
            conn?.disconnect()
        }
    }
}

// --- Share sheet and shortcuts ------------------------------------------------

/** Longest shared text passed to the page; the page caps it again. */
const val MAX_SHARED_TEXT_CHARS = 20000

/** The fragment that drafts shared text into the page's composer, or null
 * when there is nothing to share. The text is percent-encoded whole, so it
 * reaches the page as data in a fragment -- never sent to the server, never
 * able to close the fragment or turn into script. */
fun shareFragment(subject: String?, text: String?): String? {
    val parts = listOfNotNull(subject?.trim()?.ifEmpty { null }, text?.trim()?.ifEmpty { null })
    val joined = parts.distinct().joinToString("\n\n").take(MAX_SHARED_TEXT_CHARS)
    if (joined.isEmpty()) return null
    return "share=" + java.net.URLEncoder.encode(joined, "UTF-8").replace("+", "%20")
}

const val NEW_CHAT_FRAGMENT = "new"

// --- App lock -----------------------------------------------------------------

/** Whether the app asks for the fingerprint / screen lock before showing the
 * page. A cold start always asks; coming back from the background asks once
 * the app has been away longer than the grace period. */
fun lockDue(enabled: Boolean, unlocked: Boolean, backgroundedAt: Long, now: Long, graceMs: Long): Boolean {
    if (!enabled) return false
    if (!unlocked) return true
    if (backgroundedAt <= 0L) return false
    return now - backgroundedAt >= graceMs
}

// --- Update check -------------------------------------------------------------

/** What CI publishes next to the APK in the apk-latest release. */
data class UpdateInfo(val versionCode: Int, val versionName: String, val url: String, val notes: String)

/** Parses version.json. The download link must be an https GitHub URL: the
 * app only ever opens it in the browser, but a tampered file must not be
 * able to send the phone anywhere else. */
fun parseUpdateInfo(body: String?): UpdateInfo? {
    if (body.isNullOrBlank()) return null
    return try {
        val obj = JSONObject(body)
        val code = obj.optInt("versionCode", -1)
        val url = obj.optString("url", "")
        if (code <= 0 || httpsHost(url) != "github.com") return null
        UpdateInfo(code, obj.optString("versionName", code.toString()), url, obj.optString("notes", ""))
    } catch (e: Exception) {
        null
    }
}

fun updateAvailable(info: UpdateInfo?, currentVersionCode: Int): Boolean =
    info != null && info.versionCode > currentVersionCode

/** GET the update manifest. Null on any failure: an update check never
 * interrupts the app. */
fun fetchUpdateInfo(
    url: String,
    opener: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }
): UpdateInfo? {
    if (httpsHost(url) != "github.com") return null
    var conn: HttpURLConnection? = null
    return try {
        conn = opener(URL(url))
        conn.connectTimeout = 10000
        conn.readTimeout = 15000
        conn.setRequestProperty("Accept", "application/json")
        if (conn.responseCode !in 200..299) return null
        parseUpdateInfo(conn.inputStream.bufferedReader().use(BufferedReader::readText).take(64000))
    } catch (e: Exception) {
        null
    } finally {
        conn?.disconnect()
    }
}
