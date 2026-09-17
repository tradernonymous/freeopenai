package com.freeai4u.app.data

import com.freeai4u.app.ApiException
import com.freeai4u.app.ChatApi
import com.freeai4u.app.SecureStore
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

/** Keeps a working session for native calls: the stored one, or a fresh
 * sign-in from the Keystore-sealed password when it lapsed. */
class SessionManager(
    private val store: SecureStore,
    private val clientFor: (String) -> ChatApi = { ChatApi(it) },
) {
    val server: String get() = store.server ?: ""

    @Synchronized
    fun cookie(): String {
        store.session?.let { return it }
        return relogin()
    }

    @Synchronized
    fun relogin(): String {
        val user = store.username
        val pass = store.password
        if (server.isEmpty() || user == null || pass == null) throw ApiException("Sign in again.", true)
        val cookie = clientFor(server).login(user, pass)
        store.session = cookie
        return cookie
    }

    @Synchronized
    fun dropSession() {
        store.clearSession()
    }
}

/** The routes the native screens use. Every call carries the session cookie
 * and retries once through a fresh sign-in when the server says 401. */
class NativeApi(
    private val session: SessionManager,
    private val opener: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    private fun <T> withSession(block: (String) -> T): T {
        return try {
            block(session.cookie())
        } catch (e: ApiException) {
            if (!e.authRequired) throw e
            session.dropSession()
            block(session.relogin())
        }
    }

    private fun open(path: String, cookie: String, method: String, readTimeoutMs: Int): HttpURLConnection {
        val conn = opener(URL(session.server + path))
        conn.connectTimeout = 15000
        conn.readTimeout = readTimeoutMs
        conn.instanceFollowRedirects = false
        conn.requestMethod = method
        conn.setRequestProperty("Cookie", "fo_auth=$cookie")
        conn.setRequestProperty("Accept", "application/json")
        return conn
    }

    private fun readBody(conn: HttpURLConnection, ok: Boolean): String {
        val stream = if (ok) conn.inputStream else conn.errorStream
        return stream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
    }

    private fun getJson(path: String): String = withSession { cookie ->
        val conn = open(path, cookie, "GET", 30000)
        try {
            val code = conn.responseCode
            if (code == 401 || code == 302) throw ApiException("Session expired.", true)
            val body = readBody(conn, code in 200..299)
            if (code !in 200..299) throw ApiException(errorMessage(body, code))
            body
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            throw ApiException("Could not reach the server: " + (e.message ?: e.javaClass.simpleName))
        } finally {
            conn.disconnect()
        }
    }

    /** The public health route: version, commit, uptime. */
    fun health(): String = getJson("/api/health")

    /** Web research through the server (no key needed): formatted for a model. */
    fun webSearch(query: String): String =
        formatSearchResults(getJson("/api/llm/websearch?q=" + java.net.URLEncoder.encode(query.take(300), "UTF-8")))

    fun webFetch(url: String): String {
        if (!url.startsWith("http://") && !url.startsWith("https://")) throw ApiException("Only http(s) pages can be read.")
        return formatFetchedPage(getJson("/api/llm/fetch?url=" + java.net.URLEncoder.encode(url, "UTF-8")))
    }

    fun providers(): List<ProviderInfo> = chatProviders(parseProviders(getJson("/api/llm/providers")))

    fun models(provider: String): List<ModelInfo> =
        parseModels(getJson("/api/llm/models?provider=" + java.net.URLEncoder.encode(provider, "UTF-8")))

    /** Streams one reply. [onEvent] runs on the calling thread for every
     * event; [cancel] receives the connection so a Stop button can close it. */
    fun streamChat(
        provider: String,
        body: String,
        cancel: AtomicReference<HttpURLConnection?>,
        onEvent: (ChatEvent) -> Unit,
    ) = withSession { cookie ->
        val conn = open("/api/llm/chat?provider=" + java.net.URLEncoder.encode(provider, "UTF-8"), cookie, "POST", 180000)
        cancel.set(conn)
        try {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "text/event-stream")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code == 401 || code == 302) throw ApiException("Session expired.", true)
            val contentType = conn.contentType ?: ""
            if (!contentType.startsWith("text/event-stream")) {
                val text = readBody(conn, code in 200..299)
                onEvent(ChatEvent.Failure(errorMessage(text, code)))
                return@withSession
            }
            val reader = (if (code in 200..299) conn.inputStream else conn.errorStream ?: conn.inputStream).bufferedReader()
            reader.use {
                var ended = false
                while (true) {
                    val line = it.readLine() ?: break
                    if (!line.startsWith("data:")) continue
                    val event = parseSseData(line.removePrefix("data:")) ?: continue
                    onEvent(event)
                    if (event == ChatEvent.Done || event is ChatEvent.Failure) {
                        ended = true
                        break
                    }
                }
                if (!ended) onEvent(ChatEvent.Done)
            }
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            if (cancel.get() == null) onEvent(ChatEvent.Done) // stopped by the user
            else onEvent(ChatEvent.Failure("Connection lost: " + (e.message ?: e.javaClass.simpleName)))
        } finally {
            cancel.set(null)
            conn.disconnect()
        }
    }

    /** Draws one picture through the server's image route. Returns the
     * provider that drew, the media type and the bytes. */
    fun generateImage(prompt: String): Triple<String, String, ByteArray> = withSession { cookie ->
        val conn = open("/api/llm/images/generations", cookie, "POST", 180000)
        try {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            val payload = org.json.JSONObject().put("prompt", prompt).toString()
            conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code == 401 || code == 302) throw ApiException("Session expired.", true)
            val text = readBody(conn, code in 200..299)
            if (code !in 200..299) throw ApiException(errorMessage(text, code))
            val (provider, images) = parseImageResult(text)
            val first = images.firstOrNull() ?: throw ApiException("The image service answered with no picture.")
            val bytes = when {
                first.base64 != null -> java.util.Base64.getMimeDecoder().decode(first.base64)
                first.url != null -> download(first.url)
                else -> throw ApiException("The image service answered with no picture.")
            }
            Triple(provider, first.mime, bytes)
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            throw ApiException("Image failed: " + (e.message ?: e.javaClass.simpleName))
        } finally {
            conn.disconnect()
        }
    }

    private fun download(url: String): ByteArray {
        if (!url.startsWith("https://")) throw ApiException("The image link is not https.")
        val conn = opener(URL(url))
        try {
            conn.connectTimeout = 15000
            conn.readTimeout = 60000
            if (conn.responseCode !in 200..299) throw ApiException("Could not download the picture (HTTP ${conn.responseCode}).")
            return conn.inputStream.use { stream ->
                val out = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(16384)
                var total = 0
                while (true) {
                    val read = stream.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > 20 * 1024 * 1024) throw ApiException("The picture is too large.")
                    out.write(buffer, 0, read)
                }
                out.toByteArray()
            }
        } finally {
            conn.disconnect()
        }
    }
}
