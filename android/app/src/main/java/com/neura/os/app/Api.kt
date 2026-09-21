package com.neura.os.app

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

/** Retried a bounded number of times: a phone on wifi/4G drops packets, and
 * "could not reach" from a flaky link is worth one more try with a short
 * backoff. Server-decided failures -- an [ApiException], e.g. a wrong
 * password or a throttle -- are never retried, only transport failures are. */
const val DEFAULT_NETWORK_ATTEMPTS = 3

/** Linear pacing for the [catchCount]th transport failure (1-based): 250ms,
 * then 500, 750. A pure function so the policy is unit-tested on the JVM. */
fun networkBackoffMs(catchCount: Int, baseMs: Long = 250L): Long =
    catchCount.coerceAtLeast(1) * baseMs

/** Runs [block], retrying only transport-level failures ([ApiException]
 * passes straight through), up to [attempts] total tries. Every retry sleeps
 * [backoffMs] paced linearly by [networkBackoffMs]; when the budget is spent
 * the failure is reported as an unreachable server. */
internal fun <T> retryNetwork(attempts: Int, backoffMs: Long = 250L, block: () -> T): T {
    require(attempts >= 1) { "attempts must be >= 1" }
    var catchCount = 0
    while (true) {
        try {
            return block()
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            catchCount++
            if (catchCount >= attempts) {
                throw ApiException("Could not reach the server: " + (e.message ?: e.javaClass.simpleName))
            }
            try {
                Thread.sleep(networkBackoffMs(catchCount, backoffMs))
            } catch (interrupted: InterruptedException) {
                Thread.currentThread().interrupt()
                throw ApiException("Could not reach the server: " + (e.message ?: e.javaClass.simpleName))
            }
        }
    }
}

/** Thin client for this repo's own server routes only. The only credential it
 * ever holds is the fo_auth session cookie this deployment issued after a
 * username/password login. */
class ChatApi(
    private val baseUrl: String,
    private val opener: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val attempts: Int = DEFAULT_NETWORK_ATTEMPTS,
    private val backoffMs: Long = 250L,
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
    fun login(username: String, password: String): String = retryNetwork(attempts, backoffMs) { loginOnce(username, password) }

    private fun loginOnce(username: String, password: String): String {
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
    fun session(): SessionState = retryNetwork(attempts, backoffMs) { sessionOnce() }

    private fun sessionOnce(): SessionState {
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

/** What CI publishes next to the APK in the apk-latest release.
 *
 * [sha256] is the hex SHA-256 of the published APK when CI emits it
 * (version.json gains a "sha256" field). Older manifests have none: null
 * means "unverified", never "valid". The in-app flow only ever opens the
 * URL in the browser -- Android's own package installer re-verifies the
 * signing certificate on install -- so the digest is defence-in-depth for
 * any future in-app downloader, not a gate the dialog enforces today.
 */
data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val url: String,
    val notes: String,
    val sha256: String? = null,
    /** Exact APK size in bytes when CI emits it, else null (unverified). */
    val size: Long? = null,
)

/** Hardening limits for the update manifest (findings: OOM / junk input). */
const val UPDATE_MANIFEST_MAX_BYTES = 64_000
const val UPDATE_NOTES_MAX_CHARS = 2_000
const val UPDATE_VERSION_NAME_MAX_CHARS = 32
const val UPDATE_VERSION_CODE_MAX = 10_000_000
/** A real release APK is tens of MB: anything outside this range in the
 * manifest is junk (or a truncation signal at download time). */
const val UPDATE_APK_MIN_BYTES = 1_000_000L
const val UPDATE_APK_MAX_BYTES = 500_000_000L
private const val UPDATE_REDIRECT_LIMIT = 5

/** Hosts an update-manifest fetch may touch. version.json lives at
 * github.com/.../releases/download/..., which answers with a redirect to an
 * objects.githubusercontent.com (or release-assets) host. Anything else is
 * refused, so a tampered UPDATE_URL cannot send the phone elsewhere. */
private val UPDATE_MANIFEST_HOSTS = setOf(
    "github.com",
    "www.github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
)

private fun updateManifestHostAllowed(host: String?): Boolean {
    if (host.isNullOrEmpty()) return false
    val lower = host.lowercase()
    if (lower in UPDATE_MANIFEST_HOSTS) return true
    // Regional / future object-store fronts stay under this suffix.
    return lower.endsWith(".githubusercontent.com")
}

/** True when [url] is an https URL on an update-manifest host. */
fun isUpdateManifestUrl(url: String): Boolean {
    return try {
        val parsed = URL(url)
        if (parsed.protocol.lowercase() != "https") return false
        updateManifestHostAllowed(parsed.host.lowercase())
    } catch (e: Exception) {
        false
    }
}

/** True when [url] is an https GitHub release-download link: the only shape
 * the update dialog ever opens. Requires the /releases/download/ path so a
 * tampered manifest cannot point the phone at an arbitrary github.com page
 * (issue, gist, phishing repo file). */
fun isUpdateDownloadUrl(url: String): Boolean {
    return try {
        val parsed = URL(url)
        if (parsed.protocol.lowercase() != "https") return false
        if (parsed.host.lowercase() != "github.com") return false
        parsed.path.contains("/releases/download/")
    } catch (e: Exception) {
        false
    }
}

/** Lower-case hex SHA-256 ([0-9a-f]{64}), or null when it is not one. */
fun normalizeSha256Hex(raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    val clean = raw.trim().lowercase()
    if (clean.length != 64) return null
    if (!clean.all { it in '0'..'9' || it in 'a'..'f' }) return null
    return clean
}

/** Hex SHA-256 of [bytes]. */
fun sha256Hex(bytes: ByteArray): String {
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
    val chars = CharArray(digest.size * 2)
    val hex = "0123456789abcdef"
    for (i in digest.indices) {
        val v = digest[i].toInt() and 0xff
        chars[i * 2] = hex[v ushr 4]
        chars[i * 2 + 1] = hex[v and 0x0f]
    }
    return String(chars)
}

/** Constant-time digest comparison (findings: APK signature verification). */
fun verifyBytesSha256(bytes: ByteArray, expectedHex: String?): Boolean {
    val expected = normalizeSha256Hex(expectedHex) ?: return false
    val actual = sha256Hex(bytes)
    if (actual.length != expected.length) return false
    var diff = 0
    for (i in actual.indices) diff = diff or (actual[i].code xor expected[i].code)
    return diff == 0
}

/** True when [bytes] match every integrity signal the manifest carries for
 * [info]: exact size (catches the truncated downloads users reported) and
 * SHA-256 (catches corruption / tampering). Signals the manifest does not
 * carry are skipped, never failed: an old version.json without sha256/size
 * still verifies as "nothing known bad". */
fun verifyApkBytes(bytes: ByteArray, info: UpdateInfo): Boolean {
    val expectedSize = info.size
    if (expectedSize != null && bytes.size.toLong() != expectedSize) return false
    val expectedSha = info.sha256
    if (expectedSha != null && !verifyBytesSha256(bytes, expectedSha)) return false
    return true
}

/** Streaming twin of [verifyApkBytes] for the downloaded file: the APK is
 * tens of MB, so it is hashed in 256 KB chunks instead of being held whole
 * in memory (findings: memory/resource management). Size is checked first
 * (cheap) so a truncated file never pays for a hash. */
fun verifyApkFile(file: java.io.File, info: UpdateInfo): Boolean {
    return try {
        val expectedSize = info.size
        if (expectedSize != null && file.length() != expectedSize) return false
        val expectedSha = normalizeSha256Hex(info.sha256) ?: return true
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(262_144)
            while (true) {
                val read = input.read(buf)
                if (read < 0) break
                digest.update(buf, 0, read)
            }
        }
        val actual = digest.digest()
        val chars = CharArray(actual.size * 2)
        val hex = "0123456789abcdef"
        for (i in actual.indices) {
            val v = actual[i].toInt() and 0xff
            chars[i * 2] = hex[v ushr 4]
            chars[i * 2 + 1] = hex[v and 0x0f]
        }
        val actualHex = String(chars)
        var diff = 0
        for (i in actualHex.indices) diff = diff or (actualHex[i].code xor expectedSha[i].code)
        diff == 0
    } catch (e: Exception) {
        false
    }
}

/** Tiny thread-safe in-memory cache for the update manifest (findings:
 * caching / network optimisation). Automatic cold-start checks reuse a
 * fresh result instead of hitting the network every launch; manual
 * "Check for updates" always bypasses it. Pure JVM so unit tests cover it. */
object UpdateCache {
    /** How long an automatic check trusts the cached outcome. */
    const val TTL_MS = 15 * 60 * 1000L
    private var cachedAt: Long = 0L
    private var cached: UpdateCheckResult? = null

    @Synchronized
    fun get(now: Long = System.currentTimeMillis()): UpdateCheckResult? {
        val result = cached ?: return null
        if (now - cachedAt > TTL_MS) {
            cached = null
            return null
        }
        return result
    }

    @Synchronized
    fun put(result: UpdateCheckResult, now: Long = System.currentTimeMillis()) {
        // Failures are not cached: a tunnel's captive portal must not poison
        // the next fifteen minutes of checks.
        if (result is UpdateCheckResult.Failed) return
        cached = result
        cachedAt = now
    }

    @Synchronized
    fun clear() {
        cached = null
        cachedAt = 0L
    }
}

/** Parses version.json. Fail-closed: junk, off-host links, absurd versions,
 * or a malformed sha256 all yield null. The download link must be an https
 * GitHub /releases/download/ URL: the app only ever opens it in the
 * browser, but a tampered file must not be able to send the phone anywhere
 * else. */
fun parseUpdateInfo(body: String?): UpdateInfo? {
    if (body.isNullOrBlank()) return null
    if (body.length > UPDATE_MANIFEST_MAX_BYTES + 1024) return null
    return try {
        val obj = JSONObject(body)
        val code = obj.optInt("versionCode", -1)
        if (code <= 0 || code > UPDATE_VERSION_CODE_MAX) return null
        val url = obj.optString("url", "")
        if (!isUpdateDownloadUrl(url)) return null
        val rawName = obj.optString("versionName", code.toString())
        // Strip control chars a tampered manifest could hide in the dialog.
        val cleanName = rawName.filter { !it.isISOControl() }.trim()
            .take(UPDATE_VERSION_NAME_MAX_CHARS).ifEmpty { code.toString() }
        val rawNotes = obj.optString("notes", "")
        val cleanNotes = rawNotes.filter { !it.isISOControl() || it == '\n' }
            .trim().take(UPDATE_NOTES_MAX_CHARS)
        val sha = normalizeSha256Hex(obj.optString("sha256", "").ifEmpty { null })
        // A present-but-malformed digest fails closed: the manifest is junk.
        if (obj.has("sha256") && obj.optString("sha256", "").isNotEmpty() && sha == null) return null
        // Exact APK size when CI emits it: must sit inside a plausible range.
        // Present-but-absurd fails closed, like the digest above.
        var size: Long? = null
        if (obj.has("size")) {
            val rawSize = obj.optLong("size", -1L)
            if (rawSize < UPDATE_APK_MIN_BYTES || rawSize > UPDATE_APK_MAX_BYTES) return null
            size = rawSize
        }
        UpdateInfo(code, cleanName, url, cleanNotes, sha, size)
    } catch (e: Exception) {
        null
    }
}

fun updateAvailable(info: UpdateInfo?, currentVersionCode: Int): Boolean =
    info != null && info.versionCode > currentVersionCode

/** Why an update check produced no manifest. Surfaced to the UI so a manual
 * "Check for updates" can say something actionable instead of one generic
 * "try again later" (findings: user-friendly error messages). */
enum class UpdateCheckFailure {
    BAD_URL,
    OFFLINE_OR_NETWORK,
    HTTP_ERROR,
    EMPTY_OR_TOO_LARGE,
    MALFORMED,
}

sealed interface UpdateCheckResult {
    data class Available(val info: UpdateInfo) : UpdateCheckResult
    data object Current : UpdateCheckResult
    data class Failed(val reason: UpdateCheckFailure) : UpdateCheckResult
}

/** Resolve one redirect hop for the manifest fetch. Returns the absolute
 * target URL, or null when the hop must not be followed (no Location
 * header, unparsable, off the allowlist, or a downgrade off https).
 * Pure for unit tests. */
fun resolveUpdateRedirect(currentUrl: String, location: String?): String? {
    if (location.isNullOrBlank()) return null
    return try {
        val next = URL(URL(currentUrl), location)
        if (next.protocol.lowercase() != "https") return null
        if (!updateManifestHostAllowed(next.host.lowercase())) return null
        next.toString()
    } catch (e: Exception) {
        null
    }
}

/** Read at most [limit] bytes, returning null when the stream is longer
 * (findings: OOM guard -- the old code read the whole body, then truncated).
 * Always closes the stream. */
fun readCappedBytes(stream: java.io.InputStream, limit: Int): ByteArray? {
    stream.use { input ->
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var total = 0
        while (true) {
            val read = input.read(buf)
            if (read < 0) break
            total += read
            if (total > limit) return null
            out.write(buf, 0, read)
        }
        return out.toByteArray()
    }
}

/** GET the update manifest with a detailed outcome. Null-on-failure callers
 * should prefer [fetchUpdateInfo]; this is what the settings screen uses to
 * tell "no connection" apart from "server said 404" apart from "junk file".
 *
 * Security: redirects are followed manually (max [UPDATE_REDIRECT_LIMIT])
 * and only across [UPDATE_MANIFEST_HOSTS]; automatic redirect following is
 * OFF so a compromised mirror cannot bounce the phone to an evil host.
 * TLS itself is the system's (see network_security_config: HTTPS only,
 * system anchors only; no cert pinning by deliberate decision -- short-lived
 * CA certs rotate faster than a sideloaded build updates, and a stale pin
 * bricks the app with no recovery path). */
fun fetchUpdateInfoResult(
    url: String,
    currentVersionCode: Int = -1,
    opener: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }
): UpdateCheckResult {
    if (!isUpdateManifestUrl(url)) return UpdateCheckResult.Failed(UpdateCheckFailure.BAD_URL)
    var next: String? = url
    var hops = 0
    var conn: HttpURLConnection? = null
    try {
        while (next != null) {
            try {
                conn?.disconnect()
            } catch (e: Exception) {
                // Best effort; opening the next hop is what matters.
            }
            conn = try {
                opener(URL(next))
            } catch (e: Exception) {
                return UpdateCheckResult.Failed(UpdateCheckFailure.OFFLINE_OR_NETWORK)
            }
            conn.connectTimeout = 10000
            conn.readTimeout = 15000
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("Cache-Control", "no-cache")
            val code = try {
                conn.responseCode
            } catch (e: java.net.SocketTimeoutException) {
                return UpdateCheckResult.Failed(UpdateCheckFailure.OFFLINE_OR_NETWORK)
            } catch (e: java.io.IOException) {
                return UpdateCheckResult.Failed(UpdateCheckFailure.OFFLINE_OR_NETWORK)
            } catch (e: Exception) {
                return UpdateCheckResult.Failed(UpdateCheckFailure.OFFLINE_OR_NETWORK)
            }
            if (code in 301..308) {
                if (hops >= UPDATE_REDIRECT_LIMIT) return UpdateCheckResult.Failed(UpdateCheckFailure.MALFORMED)
                val target = resolveUpdateRedirect(next, conn.getHeaderField("Location"))
                    ?: return UpdateCheckResult.Failed(UpdateCheckFailure.MALFORMED)
                next = target
                hops++
                continue
            }
            if (code !in 200..299) {
                return if (code == 304 && currentVersionCode >= 0) UpdateCheckResult.Current
                else UpdateCheckResult.Failed(UpdateCheckFailure.HTTP_ERROR)
            }
            val bytes = try {
                readCappedBytes(conn.inputStream, UPDATE_MANIFEST_MAX_BYTES)
            } catch (e: java.net.SocketTimeoutException) {
                return UpdateCheckResult.Failed(UpdateCheckFailure.OFFLINE_OR_NETWORK)
            } catch (e: java.io.IOException) {
                return UpdateCheckResult.Failed(UpdateCheckFailure.OFFLINE_OR_NETWORK)
            } catch (e: Exception) {
                return UpdateCheckResult.Failed(UpdateCheckFailure.OFFLINE_OR_NETWORK)
            } ?: return UpdateCheckResult.Failed(UpdateCheckFailure.EMPTY_OR_TOO_LARGE)
            if (bytes.isEmpty()) return UpdateCheckResult.Failed(UpdateCheckFailure.EMPTY_OR_TOO_LARGE)
            val info = parseUpdateInfo(String(bytes, Charsets.UTF_8))
                ?: return UpdateCheckResult.Failed(UpdateCheckFailure.MALFORMED)
            if (currentVersionCode >= 0 && !updateAvailable(info, currentVersionCode)) {
                return UpdateCheckResult.Current
            }
            return UpdateCheckResult.Available(info)
        }
        return UpdateCheckResult.Failed(UpdateCheckFailure.MALFORMED)
    } finally {
        try {
            conn?.disconnect()
        } catch (e: Exception) {
            // Disconnect is cleanup; the result is already decided.
        }
    }
}

/** GET the update manifest. Null on any failure: an update check never
 * interrupts the app. */
fun fetchUpdateInfo(
    url: String,
    opener: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }
): UpdateInfo? {
    return when (val result = fetchUpdateInfoResult(url, -1, opener)) {
        is UpdateCheckResult.Available -> result.info
        else -> null
    }
}
