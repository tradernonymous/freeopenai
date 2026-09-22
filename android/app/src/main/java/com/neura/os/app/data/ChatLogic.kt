package com.neura.os.app.data

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// The server protocol the native screens speak, as pure functions: request
// bodies, the SSE stream the chat route relays, and the JSON the provider,
// model and image routes answer with. The same routes serve the web page, so
// these mirror what index.html reads.

data class ProviderInfo(val id: String, val label: String, val configured: Boolean, val kind: String)

data class ModelInfo(val id: String, val name: String, val contextLength: Int)

sealed interface ChatEvent {
    data class Delta(val content: String, val reasoning: String) : ChatEvent
    /** [connectivity] is true only for a failure before any reply byte came
     * back because the connection itself failed -- worth an automatic retry
     * once the network returns -- never for a server-side error. */
    data class Failure(val message: String, val connectivity: Boolean = false) : ChatEvent
    /** Some text arrived, then the stream failed; the text is kept. */
    data class Partial(val notice: String) : ChatEvent
    /** A fragment of a tool call; fragments with the same index join up. */
    data class ToolDelta(val index: Int, val id: String, val name: String, val arguments: String) : ChatEvent
    /** Several fragments in one chunk, which is how a gateway that does not stream sends parallel calls. */
    data class ToolDeltas(val deltas: List<ToolDelta>) : ChatEvent
    data object Done : ChatEvent
}

/** Only chat providers that are configured can be picked. */
fun parseProviders(body: String): List<ProviderInfo> = try {
    val array = JSONArray(body)
    (0 until array.length()).mapNotNull { index ->
        val obj = array.optJSONObject(index) ?: return@mapNotNull null
        val id = obj.optString("id", "")
        if (id.isEmpty()) null else ProviderInfo(id, obj.optString("label", id), obj.optBoolean("configured", false), obj.optString("kind", "chat"))
    }
} catch (e: Exception) {
    emptyList()
}

fun chatProviders(all: List<ProviderInfo>): List<ProviderInfo> = all.filter { it.configured && it.kind == "chat" }

/** The provider id for Puter, which the app reaches itself rather than through
 * the server. Kept here so the id is written once. */
const val PUTER_PROVIDER = "puter"

/** GET /api/llm/puter/models -> {models:[{id,name,description}]}. */
fun parsePuterModels(body: String): List<ModelInfo> = try {
    val array = JSONObject(body).optJSONArray("models") ?: JSONArray()
    (0 until array.length()).mapNotNull { index ->
        val obj = array.optJSONObject(index) ?: return@mapNotNull null
        val id = obj.optString("id", "")
        if (id.isEmpty()) null else ModelInfo(id, obj.optString("name", id), 0)
    }
} catch (e: Exception) {
    emptyList()
}

fun parseModels(body: String): List<ModelInfo> = try {
    val array = JSONArray(body)
    (0 until array.length()).mapNotNull { index ->
        val obj = array.optJSONObject(index)
        val id = obj?.optString("id", "") ?: array.optString(index, "")
        if (id.isNullOrEmpty()) null else ModelInfo(
            id,
            obj?.optString("name", "")?.ifEmpty { id } ?: id,
            obj?.optInt("contextLength", 0) ?: 0,
        )
    }
} catch (e: Exception) {
    emptyList()
}

/** One `data:` payload of the relayed stream. Returns null for keep-alives and
 * anything that carries nothing to show. */
fun parseSseData(data: String): ChatEvent? {
    val text = data.trim()
    if (text.isEmpty()) return null
    if (text == "[DONE]") return ChatEvent.Done
    return try {
        val obj = JSONObject(text)
        if (obj.has("error")) {
            val error = obj.opt("error")
            val message = when (error) {
                is JSONObject -> error.optString("message", error.toString())
                else -> error?.toString() ?: "The provider failed."
            }
            return ChatEvent.Failure(message)
        }
        if (obj.optBoolean("partial", false)) return ChatEvent.Partial(obj.optString("notice", "The reply stopped early."))
        val choices = obj.optJSONArray("choices") ?: return null
        val first = choices.optJSONObject(0) ?: return null
        val delta = first.optJSONObject("delta") ?: first.optJSONObject("message") ?: return null
        val calls = delta.optJSONArray("tool_calls")
        if (calls != null && calls.length() > 0) {
            val deltas = (0 until calls.length()).mapNotNull { at ->
                val call = calls.optJSONObject(at) ?: return@mapNotNull null
                val function = call.optJSONObject("function")
                ChatEvent.ToolDelta(
                    call.optInt("index", at),
                    if (call.isNull("id")) "" else call.optString("id", ""),
                    if (function == null || function.isNull("name")) "" else function.optString("name", ""),
                    if (function == null || function.isNull("arguments")) "" else function.optString("arguments", ""),
                )
            }
            return when (deltas.size) {
                0 -> null
                1 -> deltas[0]
                else -> ChatEvent.ToolDeltas(deltas)
            }
        }
        val content = delta.optString("content", "").let { if (delta.isNull("content")) "" else it }
        val reasoning = listOf("reasoning_content", "reasoning")
            .map { key -> if (delta.isNull(key)) "" else delta.optString(key, "") }
            .firstOrNull { it.isNotEmpty() } ?: ""
        if (content.isEmpty() && reasoning.isEmpty()) null else ChatEvent.Delta(content, reasoning)
    } catch (e: Exception) {
        null
    }
}

/** Reads a relayed chat stream line by line, dispatching each parsed event,
 * until the server's own terminator ([ChatEvent.Done] from `[DONE]`, or a
 * [ChatEvent.Failure]) arrives. Pulled out of NativeApi.streamChat as a pure
 * function -- java.io.BufferedReader is a plain JVM type, so this is testable
 * from a StringReader with no HttpURLConnection, no SecureStore, no Android
 * framework at all, unlike the class around it.
 *
 * If the reader runs out of lines with neither terminator ever seen -- a
 * flaky connection or a proxy's idle-kill closing the socket mid-reply --
 * that is reported as a connectivity [ChatEvent.Failure], never silently as
 * [ChatEvent.Done]: the caller (AppViewModel) already knows what to do with
 * a connectivity failure -- retry it if nothing arrived yet, or keep
 * whatever text did arrive with an honest "connection lost" notice appended
 * -- and treating an unexplained early stream close as a normal finish is
 * exactly how a real answer previously arrived at the user looking merely
 * cut short, with nothing to say why. */
fun consumeSseChatStream(reader: java.io.BufferedReader, onEvent: (ChatEvent) -> Unit) {
    var ended = false
    while (true) {
        val line = reader.readLine() ?: break
        if (!line.startsWith("data:")) continue
        val event = parseSseData(line.removePrefix("data:")) ?: continue
        onEvent(event)
        if (event == ChatEvent.Done || event is ChatEvent.Failure) {
            ended = true
            break
        }
    }
    if (!ended) onEvent(ChatEvent.Failure("Connection lost before the reply finished.", connectivity = true))
}

/** How many past messages ride along with each turn. Free models have small
 * context windows, and a long chat would otherwise fail on its own weight. */
const val MAX_HISTORY_MESSAGES = 30

/** Roughly how many tokens a piece of text costs -- four characters to a
 * token, the same estimate the web app uses for the same purpose
 * (chatlib.js's estimateTokens): close enough to decide what fits, not a
 * real tokenizer. */
fun estimateTokens(text: String): Int = if (text.isEmpty()) 0 else (text.length + 3) / 4

/** How much the *weight* of the kept history may add up to, on top of the
 * count cap above -- matching the web app's HISTORY_TOKEN_BUDGET. The count
 * cap alone bounds how many turns ride along, not how heavy they are: thirty
 * short turns and thirty turns each carrying a pasted file are very
 * different requests. Sent uncapped, the heavier one can leave a provider's
 * context window with little room left for the *reply*, which is why a long
 * Android chat could see answers stop early with nothing in the response
 * itself explaining why -- the web app already guards against exactly this. */
const val HISTORY_TOKEN_BUDGET = 24000

/** Keeps the newest messages whose combined estimated weight fits [budget].
 * The newest message always rides regardless of its own size -- a request
 * that arrives without it is answering a different question than the one
 * just asked -- and trimming works backward from there the same way
 * chatlib.js's budgetChatHistory does, so the two clients apply the same
 * policy to the same conversation. */
fun budgetChatHistory(messages: List<ChatMessage>, budget: Int = HISTORY_TOKEN_BUDGET): List<ChatMessage> {
    if (messages.isEmpty()) return messages
    val kept = ArrayDeque<ChatMessage>()
    var spent = 0
    for (i in messages.indices.reversed()) {
        val cost = estimateTokens(messages[i].content)
        if (kept.isNotEmpty() && spent + cost > budget) break
        kept.addFirst(messages[i])
        spent += cost
    }
    return kept.toList()
}

/** How many of the most recent photo turns are sent as pictures. */
const val MAX_PHOTO_TURNS_IN_HISTORY = 2

/** Joins streamed tool-call fragments into whole calls, in index order. */
class ToolCallCollector {
    private val ids = sortedMapOf<Int, String>()
    private val names = sortedMapOf<Int, StringBuilder>()
    private val args = sortedMapOf<Int, StringBuilder>()

    fun add(delta: ChatEvent.ToolDelta) {
        if (delta.id.isNotEmpty()) ids[delta.index] = delta.id
        names.getOrPut(delta.index) { StringBuilder() }.append(delta.name)
        args.getOrPut(delta.index) { StringBuilder() }.append(delta.arguments)
    }

    fun calls(): List<ToolCall> = names.keys.mapNotNull { index ->
        val name = names[index].toString()
        if (name.isEmpty()) null
        else ToolCall(ids[index] ?: "call_$index", name, args[index]?.toString()?.ifBlank { "{}" } ?: "{}")
    }
}

/** The body for POST /api/llm/chat?provider=... : the system prompt first,
 * then the recent history minus failed replies, streamed. Tool calls and their
 * results travel in the OpenAI shape; history is cut so a tool result never
 * arrives without the call it answers. */
fun buildChatBody(
    model: String,
    systemPrompt: String,
    history: List<ChatMessage>,
    maxHistory: Int = MAX_HISTORY_MESSAGES,
    tools: JSONArray? = null,
    historyBudget: Int = HISTORY_TOKEN_BUDGET,
): String {
    val messages = JSONArray()
    if (systemPrompt.isNotBlank()) messages.put(JSONObject().put("role", "system").put("content", systemPrompt))
    var kept = history.filter { message ->
        !message.error && when (message.role) {
            "user" -> message.content.isNotBlank() || message.images.isNotEmpty()
            "assistant" -> message.content.isNotBlank() || message.toolCalls.isNotEmpty()
            "tool" -> message.toolCallId.isNotEmpty()
            else -> false
        }
    }.takeLast(maxHistory)
    kept = budgetChatHistory(kept, historyBudget)
    // The count cap and the budget trim can each leave a tool result at the
    // front with the assistant call it answers now cut away.
    while (kept.isNotEmpty() && kept.first().role == "tool") kept = kept.drop(1)
    // Photos are the heavy part of a history: a few turns of them pass the
    // server's body limit and every later turn fails on weight. Only the most
    // recent ones ride along in full; older turns keep their text.
    val withPhotos = kept.withIndex().filter { it.value.images.isNotEmpty() }.map { it.index }.takeLast(MAX_PHOTO_TURNS_IN_HISTORY).toSet()
    kept.forEachIndexed { index, message ->
        when {
            message.role == "user" && message.images.isNotEmpty() && index !in withPhotos ->
                messages.put(JSONObject().put("role", "user").put("content", message.content.ifBlank { "(a photo was sent here)" }))
            message.role == "user" && message.images.isNotEmpty() -> {
                // OpenAI vision shape: text part first, then one part per photo.
                val parts = JSONArray().put(JSONObject().put("type", "text").put("text", message.content))
                message.images.forEach { url ->
                    parts.put(JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", url)))
                }
                messages.put(JSONObject().put("role", "user").put("content", parts))
            }
            message.role == "assistant" && message.toolCalls.isNotEmpty() -> {
                val calls = JSONArray()
                message.toolCalls.forEach { call ->
                    calls.put(JSONObject().put("id", call.id).put("type", "function")
                        .put("function", JSONObject().put("name", call.name).put("arguments", call.arguments)))
                }
                messages.put(JSONObject().put("role", "assistant").put("content", message.content).put("tool_calls", calls))
            }
            message.role == "tool" -> messages.put(
                JSONObject().put("role", "tool").put("tool_call_id", message.toolCallId).put("name", message.toolName).put("content", message.content)
            )
            else -> messages.put(JSONObject().put("role", message.role).put("content", message.content))
        }
    }
    val body = JSONObject().put("model", model).put("messages", messages).put("stream", true)
    if (tools != null && tools.length() > 0) body.put("tools", tools)
    return body.toString()
}

/** A refusal that means "this model cannot take tools", so the turn is worth
 * one retry without them rather than a failure. */
fun looksLikeToolsUnsupported(message: String): Boolean {
    val text = message.lowercase()
    return (text.contains("tool") || text.contains("function")) &&
        listOf("not support", "unsupported", "does not support", "not available", "invalid", "not enabled", "unknown field", "extra").any { text.contains(it) }
}

data class ImagePayload(val base64: String?, val url: String?, val mime: String)

/** The image route's answer, normalized to data[].b64_json or url. */
fun parseImageResult(body: String): Pair<String, List<ImagePayload>> = try {
    val obj = JSONObject(body)
    val rows = obj.optJSONArray("data") ?: JSONArray()
    val list = (0 until rows.length()).mapNotNull { index ->
        val row = rows.optJSONObject(index) ?: return@mapNotNull null
        val b64 = row.optString("b64_json", "").ifEmpty { null }
        val url = row.optString("url", "").ifEmpty { null }
        if (b64 == null && url == null) null else ImagePayload(b64, url, row.optString("media_type", "image/png"))
    }
    obj.optString("provider", "") to list
} catch (e: Exception) {
    "" to emptyList()
}

/** The error text a route answered with, or a fallback. */
fun errorMessage(body: String?, status: Int): String {
    val fromBody = try {
        val obj = JSONObject(body ?: "")
        when (val error = obj.opt("error")) {
            is JSONObject -> error.optString("message", "")
            null -> ""
            else -> error.toString()
        }
    } catch (e: Exception) {
        ""
    }
    return fromBody.ifEmpty { "Server answered HTTP $status." }
}

/** What the server reports about its own patience: how long it waits on a
 * provider, and how many times it retries a rate-limited call. */
data class Limits(val timeoutsMs: Map<String, Int>, val maxAttempts: Int, val baseDelayMs: Int) {
    /** A short spoken-in-UI summary, e.g. "chat 55s · retry 3×". */
    fun summary(): String {
        val chat = timeoutsMs["chat"] ?: 0
        return "chat " + secs(chat) + " · retry " + maxAttempts + "×"
    }

    fun detail(): String {
        val parts = listOf("models", "chat", "image", "headers", "stall").mapNotNull { key ->
            timeoutsMs[key]?.let { key + " " + secs(it) }
        }
        return parts.joinToString(" · ") + " · " + baseDelayMs + "ms base"
    }

    private fun secs(ms: Int): String {
        if (ms <= 0) return "—"
        val seconds = ms / 1000f
        return if (seconds == seconds.toInt().toFloat()) seconds.toInt().toString() + "s" else seconds.toString() + "s"
    }
}

/** Reads `/api/llm/limits`, falling back to null on anything unexpected. */
fun parseLimits(body: String): Limits? = try {
    val obj = JSONObject(body)
    val timeouts = obj.optJSONObject("timeouts") ?: JSONObject()
    val map = mutableMapOf<String, Int>()
    val keys = timeouts.keys()
    while (keys.hasNext()) {
        val key = keys.next()
        map[key] = timeouts.optInt(key, 0)
    }
    val retries = obj.optJSONObject("retries") ?: JSONObject()
    if (map.isEmpty() && retries.length() == 0) null
    else Limits(map, retries.optInt("maxAttempts", 0), retries.optInt("baseDelayMs", 0))
} catch (e: Exception) {
    null
}

/** A chat's title from its first message: one line, at most 48 characters. */
fun deriveTitle(text: String): String {
    val line = text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: return "New chat"
    val clean = line.replace(Regex("\\s+"), " ")
    return if (clean.length <= 48) clean else clean.take(47).trimEnd() + "…"
}

/** Prompts matching what follows a leading "/" in the composer. */
fun matchPrompts(input: String, prompts: List<PromptTemplate>): List<PromptTemplate> {
    if (!input.startsWith("/")) return emptyList()
    val query = input.drop(1).trim().lowercase()
    if (query.contains('\n')) return emptyList()
    return prompts.filter { query.isEmpty() || it.title.lowercase().contains(query) || it.text.lowercase().contains(query) }.take(8)
}

/** Chats matching a search, pinned first, newest first. */
fun filterConversations(all: List<Conversation>, query: String): List<Conversation> {
    val needle = query.trim().lowercase()
    return all.filter { conversation ->
        needle.isEmpty() || conversation.title.lowercase().contains(needle) ||
            conversation.messages.any { it.content.lowercase().contains(needle) }
    }.sortedWith(compareByDescending<Conversation> { it.pinned }.thenByDescending { it.updatedAt })
}

/** One row in the Library screen's cross-cutting search -- a persona, a
 * prompt or a skill, whichever [kind] names -- so one search box can reach
 * into all three instead of making the user pick a hub first. */
data class LibraryEntry(val kind: String, val id: String, val title: String, val subtitle: String)

/** Library entries matching a search, a title that starts with it ranked
 * ahead of one that merely contains it. Empty query returns everything,
 * unranked (the caller's own order stands). */
fun rankLibrary(entries: List<LibraryEntry>, query: String): List<LibraryEntry> {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return entries
    return entries
        .filter { it.title.lowercase().contains(needle) || it.subtitle.lowercase().contains(needle) }
        .sortedByDescending { it.title.lowercase().startsWith(needle) }
}

/** A conversation as Markdown, for sharing and saving. Failed replies are
 * left out: they are the app talking, not the exchange. */
fun conversationMarkdown(conversation: Conversation, personaName: String, now: Long = System.currentTimeMillis()): String {
    val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date(now))
    val out = StringBuilder()
    out.append("# ").append(conversation.title.ifBlank { "Chat" }).append("\n\n")
    out.append("_").append(personaName).append(" · ").append(conversation.model.ifBlank { "model" })
        .append(" · exported ").append(stamp).append("_\n\n")
    conversation.messages.filter { !it.error && it.content.isNotBlank() }.forEach { message ->
        out.append(if (message.role == "user") "## You" else "## Assistant").append("\n\n")
        out.append(message.content.trim()).append("\n\n")
    }
    return out.toString().trimEnd() + "\n"
}

/** A file name that works on every filesystem the export may land on. */
fun safeFileName(title: String, extension: String): String {
    val base = title.replace(Regex("[^A-Za-z0-9 _-]"), "").trim().replace(Regex("\\s+"), "-").take(40).ifEmpty { "chat" }
    return "$base.$extension"
}

/** Splits a reply into prose and fenced code blocks for rendering. */
data class Segment(val code: Boolean, val language: String, val text: String)

fun splitCodeBlocks(text: String): List<Segment> {
    val segments = mutableListOf<Segment>()
    val lines = text.split("\n")
    val buffer = StringBuilder()
    var inCode = false
    var language = ""
    fun flush(code: Boolean) {
        val chunk = buffer.toString().trimEnd('\n')
        if (chunk.isNotEmpty() || code) segments.add(Segment(code, language, chunk))
        buffer.setLength(0)
    }
    for (line in lines) {
        val trimmed = line.trimStart()
        if (trimmed.startsWith("```")) {
            if (inCode) {
                flush(true)
                inCode = false
                language = ""
            } else {
                flush(false)
                inCode = true
                language = trimmed.removePrefix("```").trim()
            }
            continue
        }
        buffer.append(line).append("\n")
    }
    // An unclosed fence (a reply still streaming) renders as code so far.
    flush(inCode)
    return segments.filter { it.code || it.text.isNotBlank() }
}
