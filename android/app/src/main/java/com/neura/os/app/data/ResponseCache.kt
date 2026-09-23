package com.neura.os.app.data

import org.json.JSONArray
import org.json.JSONObject

// The offline story (master plan section 2.2 and Phase 3): an answer seen
// before stands in when the connection is gone. Opt-in, sealed on disk like
// the chats, and only ever a fallback -- it never replaces a live answer, and
// the message it produces is marked cached and queued for a fresh one.
// Pure: AppViewModel owns reading and writing it (Repository).

/** One answer: which exact questions produced it, and from which model. */
data class CachedAnswer(val key: String, val content: String, val model: String, val at: Long)

/** How many answers are kept; the oldest fall off. */
const val RESPONSE_CACHE_MAX = 50

private fun normaliseQuestion(text: String): String =
    text.trim().lowercase().replace(Regex("\\s+"), " ").trimEnd('?', '.', '!', ' ')

/** Null when there is nothing to key on. Built from the model, the mode and
 * every user message in order -- not only the last one, because a follow-up
 * like "and in French?" means nothing without what it follows. The replies
 * are left out: they differ run to run while the question stays the same. */
fun responseCacheKey(model: String, mode: String, messages: List<ChatMessage>): String? {
    val questions = messages.filter { it.role == "user" }.map { normaliseQuestion(it.content) }.filter { it.isNotEmpty() }
    if (questions.isEmpty()) return null
    return model.trim() + "\u0001" + mode.trim() + "\u0001" + questions.joinToString("\u0002")
}

data class ResponseCache(val entries: List<CachedAnswer> = emptyList()) {
    fun lookup(key: String): CachedAnswer? = entries.firstOrNull { it.key == key }

    /** Newest first; a repeat of a key replaces the old answer. */
    fun stored(key: String, content: String, model: String, at: Long): ResponseCache {
        if (content.isBlank()) return this
        val rest = entries.filter { it.key != key }
        return copy(entries = (listOf(CachedAnswer(key, content, model, at)) + rest).take(RESPONSE_CACHE_MAX))
    }
}

fun ResponseCache.toJson(): String {
    val list = JSONArray()
    entries.forEach { list.put(JSONObject().put("key", it.key).put("content", it.content).put("model", it.model).put("at", it.at)) }
    return JSONObject().put("v", 1).put("entries", list).toString()
}

fun responseCacheFromJson(text: String?): ResponseCache {
    if (text.isNullOrBlank()) return ResponseCache()
    return try {
        val list = JSONObject(text).optJSONArray("entries") ?: JSONArray()
        ResponseCache(
            (0 until list.length()).mapNotNull { index ->
                list.optJSONObject(index)?.let {
                    val key = it.optString("key", "")
                    val content = it.optString("content", "")
                    if (key.isEmpty() || content.isBlank()) null else CachedAnswer(key, content, it.optString("model", ""), it.optLong("at", 0L))
                }
            }.take(RESPONSE_CACHE_MAX),
        )
    } catch (e: Exception) {
        ResponseCache()
    }
}
