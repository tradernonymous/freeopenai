package com.neura.os.app.data

import org.json.JSONArray
import org.json.JSONObject

/** A chat owed a reply that could not be fetched because the connection
 * itself failed -- not because the server answered with an error. The turn
 * the user actually typed is already in [Conversation.messages] the moment
 * they sent it; what "unsent" means here is that no reply attempt has
 * succeeded yet, and [chatId] is the key because retrying one is always
 * "regenerate the last reply for this chat" (AppViewModel.regenerate), never
 * a second copy of the message -- the app only ever has one turn in flight
 * per chat at a time, so a chat id already is that turn's identity. */
data class OutboxEntry(
    val chatId: String,
    val attempts: Int = 0,
    val lastAttemptAt: Long = 0L,
)

/** Pure state: no I/O, no timers, no clock reads. AppViewModel owns
 * persistence (mirroring Repository's chats/library files) and the
 * ACCESS_NETWORK_STATE callback that decides when to call [due]. */
data class Outbox(val entries: List<OutboxEntry> = emptyList()) {
    /** Re-queuing a chat that is already queued is a no-op -- the network
     * callback and a manual retry racing must not double the entry. */
    fun enqueued(chatId: String): Outbox =
        if (entries.any { it.chatId == chatId }) this else copy(entries = entries + OutboxEntry(chatId))

    fun acked(chatId: String): Outbox = copy(entries = entries.filter { it.chatId != chatId })

    fun attempted(chatId: String, at: Long): Outbox = copy(
        entries = entries.map { if (it.chatId == chatId) it.copy(attempts = it.attempts + 1, lastAttemptAt = at) else it },
    )

    /** Entries whose backoff has elapsed -- what a drain pass should retry. */
    fun due(now: Long): List<OutboxEntry> = entries.filter { now >= it.lastAttemptAt + backoff(it.attempts) }

    companion object {
        /** Doubling backoff from 1s, capped at 30s, so a flapping connection
         * cannot hammer the server the instant it reappears. An entry with no
         * prior attempts is always due immediately. */
        fun backoff(attempts: Int): Long = if (attempts <= 0) 0L else minOf(1000L shl (attempts - 1), 30_000L)
    }
}

/** What a queued chat shows above its composer, or null when it is not
 * queued. The queue always worked; it was invisible, so a turn that failed on
 * a dropped connection read as lost rather than pending (master plan Phase 3). */
fun outboxNotice(outbox: Outbox, chatId: String, now: Long): String? {
    val entry = outbox.entries.firstOrNull { it.chatId == chatId } ?: return null
    if (entry.attempts <= 0) return "No connection when this was sent. The reply will be fetched when you're back online."
    val tries = if (entry.attempts == 1) "Tried once." else "Tried ${entry.attempts} times."
    val waitMs = entry.lastAttemptAt + Outbox.backoff(entry.attempts) - now
    return if (waitMs > 0) {
        "$tries Next try in ${(waitMs + 999) / 1000} s, or as soon as you're back online."
    } else {
        "$tries Trying again as soon as you're back online."
    }
}

fun OutboxEntry.toJson(): JSONObject = JSONObject()
    .put("chatId", chatId)
    .put("attempts", attempts)
    .put("lastAttemptAt", lastAttemptAt)

fun outboxEntryFromJson(obj: JSONObject): OutboxEntry? {
    val chatId = obj.optString("chatId", "")
    if (chatId.isEmpty()) return null
    return OutboxEntry(
        chatId = chatId,
        attempts = obj.optInt("attempts", 0),
        lastAttemptAt = obj.optLong("lastAttemptAt", 0L),
    )
}

fun Outbox.toJson(): JSONArray = JSONArray().also { array -> entries.forEach { array.put(it.toJson()) } }

fun outboxFromJson(text: String?): Outbox {
    if (text.isNullOrBlank()) return Outbox()
    return try {
        val array = JSONArray(text)
        Outbox((0 until array.length()).mapNotNull { array.optJSONObject(it)?.let(::outboxEntryFromJson) })
    } catch (e: Exception) {
        Outbox()
    }
}
