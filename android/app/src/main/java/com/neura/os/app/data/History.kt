package com.neura.os.app.data

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Chat history in date sections: Pinned, Today, Yesterday, 7 days, 30 days,
 * then month names. Newest first within each section. */
fun groupByDate(
    chats: List<Conversation>,
    now: Long = System.currentTimeMillis(),
    zone: TimeZone = TimeZone.getDefault(),
): List<Pair<String, List<Conversation>>> {
    val calendar = Calendar.getInstance(zone)
    calendar.timeInMillis = now
    calendar.set(Calendar.HOUR_OF_DAY, 0)
    calendar.set(Calendar.MINUTE, 0)
    calendar.set(Calendar.SECOND, 0)
    calendar.set(Calendar.MILLISECOND, 0)
    val today = calendar.timeInMillis
    val day = 24 * 60 * 60 * 1000L
    val month = SimpleDateFormat("MMMM yyyy", Locale.US).apply { timeZone = zone }
    val sections = linkedMapOf<String, MutableList<Conversation>>()
    val pinned = mutableListOf<Conversation>()
    chats.sortedByDescending { it.updatedAt }.forEach { chat ->
        if (chat.pinned) {
            pinned.add(chat)
            return@forEach
        }
        val label = when {
            chat.updatedAt >= today -> "Today"
            chat.updatedAt >= today - day -> "Yesterday"
            chat.updatedAt >= today - 7 * day -> "7 days"
            chat.updatedAt >= today - 30 * day -> "30 days"
            else -> month.format(Date(chat.updatedAt))
        }
        sections.getOrPut(label) { mutableListOf() }.add(chat)
    }
    return (if (pinned.isEmpty()) emptyList() else listOf("Pinned" to pinned.toList())) + sections.map { it.key to it.value.toList() }
}
