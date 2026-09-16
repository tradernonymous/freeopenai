package com.freeai4u.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

// Pure protocol helpers (unit-tested on the JVM) plus one thin HTTP client.
// Everything the server sends is treated as untrusted: JSON is parsed
// defensively, HTML is never rendered (assistant text goes into Compose Text,
// never a WebView), and no secret is ever stored -- the server URL is a
// routing address, not a credential.

data class ProviderInfo(val id: String, val label: String, val configured: Boolean)
data class ModelInfo(val id: String, val free: Boolean)
data class ChatMessage(val role: String, val content: String)

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

/** Mirrors the server's own convention: unpriced models ride a free-tier
 * allowance, so missing pricing reads as free rather than unknown. */
fun isFreePricing(pricing: JSONObject?): Boolean {
    if (pricing == null) return true
    fun zero(key: String): Boolean {
        if (!pricing.has(key) || pricing.isNull(key)) return true
        return when (val v = pricing.get(key)) {
            is Number -> v.toDouble() == 0.0
            is String -> v.toDoubleOrNull() == 0.0
            else -> false
        }
    }
    return zero("prompt") && zero("completion")
}

sealed interface SseEvent {
    data class Delta(val text: String) : SseEvent
    data class Failure(val message: String) : SseEvent
    object Done : SseEvent
    object Skip : SseEvent
}

/** One SSE line from /api/llm/chat into an event. Anything unrecognised is
 * skipped, never crashed on: providers evolve their frames faster than apps. */
fun parseSseLine(line: String): SseEvent {
    if (!line.startsWith("data:")) return SseEvent.Skip
    // The spec strips exactly one leading space; chat deltas may legitimately
    // start with more, and those belong to the message, not the protocol.
    var value = line.substring(5)
    if (value.startsWith(" ")) value = value.substring(1)
    if (value == "[DONE]") return SseEvent.Done
    if (value.isEmpty()) return SseEvent.Skip
    val obj: JSONObject
    try {
        obj = JSONObject(value)
    } catch (e: Exception) {
        return SseEvent.Skip
    }
    if (obj.has("notice")) {
        val notice = obj.optString("notice", "")
        if (notice.isNotEmpty()) return SseEvent.Failure(notice)
    }
    if (obj.has("error")) {
        val err = obj.opt("error")
        val message = when (err) {
            is String -> err
            is JSONObject -> err.optString("message", "The server refused the request.")
            else -> "The server refused the request."
        }
        if (message.isNotEmpty()) return SseEvent.Failure(message)
    }
    val choices = obj.optJSONArray("choices") ?: return SseEvent.Skip
    if (choices.length() == 0) return SseEvent.Skip
    val first = choices.optJSONObject(0) ?: return SseEvent.Skip
    val delta = first.optJSONObject("delta")
    if (delta != null && delta.has("content")) {
        return SseEvent.Delta(delta.optString("content", ""))
    }
    val message = first.optJSONObject("message")
    if (message != null && message.has("content")) {
        return SseEvent.Delta(message.optString("content", ""))
    }
    return SseEvent.Skip
}

class ApiException(message: String) : Exception(message)

interface ChatListener {
    fun onDelta(text: String)
    fun onDone(fullText: String)
    fun onError(message: String)
}

/** Thin client for this repo's own server routes only. No cookies are stored,
 * no credentials exist to keep: if the deployment enforces login, calls fail
 * with a message that says so instead of pretending to work. */
class ChatApi(private val baseUrl: String) {

    private fun get(path: String): String {
        var conn: HttpURLConnection? = null
        try {
            conn = URL(baseUrl + path).openConnection() as HttpURLConnection
            conn.connectTimeout = 15000
            conn.readTimeout = 60000
            conn.setRequestProperty("Accept", "application/json")
            val code = conn.responseCode
            if (code == 401 || code == 302) {
                throw ApiException("This server needs a login first -- open it in a browser, sign in, then retry.")
            }
            if (code !in 200..299) {
                throw ApiException("Server answered HTTP " + code + ".")
            }
            return conn.inputStream.bufferedReader().use(BufferedReader::readText)
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            throw ApiException("Could not reach the server: " + (e.message ?: e.javaClass.simpleName))
        } finally {
            conn?.disconnect()
        }
    }

    fun providers(): List<ProviderInfo> {
        val arr = JSONArray(get("/api/llm/providers"))
        val out = ArrayList<ProviderInfo>()
        for (i in 0 until arr.length()) {
            val row = arr.optJSONObject(i) ?: continue
            val kind = row.optString("kind", "chat")
            if (kind != "chat") continue
            // Unconfigured rows would only fail on first use; the picker shows
            // what can actually answer.
            if (!row.optBoolean("configured", false)) continue
            out.add(ProviderInfo(row.optString("id", ""), row.optString("label", ""), true))
        }
        return out.filter { it.id.isNotEmpty() }
    }

    fun models(providerId: String): List<ModelInfo> {
        val encoded = URLEncoder.encode(providerId, "UTF-8")
        val arr = JSONArray(get("/api/llm/models?provider=" + encoded))
        val out = ArrayList<ModelInfo>()
        for (i in 0 until arr.length()) {
            val row = arr.optJSONObject(i) ?: continue
            val id = row.optString("id", "")
            if (id.isEmpty()) continue
            out.add(ModelInfo(id, isFreePricing(row.optJSONObject("pricing"))))
        }
        return out
    }

    /** Streams one assistant reply. Runs on the calling thread -- call it off
     * the main thread. Deltas arrive in order; Done carries the full text. */
    fun streamChat(providerId: String, model: String, history: List<ChatMessage>, listener: ChatListener) {
        var conn: HttpURLConnection? = null
        try {
            conn = URL(baseUrl + "/api/llm/chat?provider=" + URLEncoder.encode(providerId, "UTF-8")).openConnection() as HttpURLConnection
            conn.connectTimeout = 15000
            conn.readTimeout = 180000
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "text/event-stream")
            val payload = JSONObject()
            payload.put("model", model)
            val messages = JSONArray()
            for (m in history) {
                val row = JSONObject()
                row.put("role", m.role)
                row.put("content", m.content)
                messages.put(row)
            }
            payload.put("messages", messages)
            payload.put("stream", true)
            conn.outputStream.bufferedWriter().use { it.write(payload.toString()) }
            val code = conn.responseCode
            if (code == 401 || code == 302) {
                listener.onError("This server needs a login first -- open it in a browser, sign in, then retry.")
                return
            }
            if (code !in 200..299) {
                val body = try {
                    conn.errorStream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
                } catch (e: Exception) {
                    ""
                }
                listener.onError(errorTextFromBody(body, code))
                return
            }
            val full = StringBuilder()
            var terminal = false
            val reader = conn.inputStream.bufferedReader()
            while (!terminal) {
                val line = reader.readLine() ?: break
                when (val event = parseSseLine(line)) {
                    is SseEvent.Delta -> {
                        full.append(event.text)
                        listener.onDelta(event.text)
                    }
                    is SseEvent.Failure -> {
                        listener.onError(event.message)
                        terminal = true
                    }
                    is SseEvent.Done -> {
                        listener.onDone(full.toString())
                        terminal = true
                    }
                    is SseEvent.Skip -> {}
                }
            }
            // A stream that ends without DONE still delivered what it delivered.
            if (!terminal) listener.onDone(full.toString())
        } catch (e: Exception) {
            listener.onError("Could not reach the server: " + (e.message ?: e.javaClass.simpleName))
        } finally {
            conn?.disconnect()
        }
    }

    private fun errorTextFromBody(body: String, code: Int): String {
        if (body.isNotEmpty()) {
            try {
                val obj = JSONObject(body)
                if (obj.has("error")) {
                    val err = obj.get("error")
                    if (err is String && err.isNotEmpty()) return err
                    if (err is JSONObject) {
                        val message = err.optString("message", "")
                        if (message.isNotEmpty()) return message
                    }
                }
            } catch (e: Exception) {
                // Not JSON -- fall through to the status.
            }
        }
        return "Server answered HTTP " + code + "."
    }
}
