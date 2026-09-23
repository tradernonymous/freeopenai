package com.neura.os.app.data

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

// Scheduled recipes (docs/android-master-plan.md, Phase 5; NEURA-039): a saved
// prompt that comes due at a time of day on chosen weekdays. When it does, the
// phone shows a notification; tapping it opens a new chat with the prompt
// already typed. It asks, it never runs: nothing is sent until the person taps
// Send, the same posture as NEURA-036. This file is the pure part -- the
// times, the labels, the stored form -- so all of it is JVM-tested; the alarm
// and the notification live in RecipeAlarmReceiver.kt.

/** [days] are ISO weekdays: 1 = Monday ... 7 = Sunday. */
data class RecipeSchedule(
    val id: String,
    val prompt: String,
    val hour: Int,
    val minute: Int,
    val days: Set<Int>,
    val enabled: Boolean = true,
)

/** More than this is a to-do list, not a handful of routines. */
const val SCHEDULE_MAX = 10

/** A recipe is a prompt, not a document. */
const val SCHEDULE_PROMPT_MAX = 2000

val EVERY_DAY: Set<Int> = (1..7).toSet()
val WEEKDAYS: Set<Int> = (1..5).toSet()
val WEEKEND: Set<Int> = setOf(6, 7)

private val SCHEDULE_ID = Regex("^[a-z0-9]{8,32}$")

/** Ids travel in intents (an alarm, a notification tap), so they are checked
 * before they are looked up. */
fun isScheduleId(id: String?): Boolean = id != null && SCHEDULE_ID.matches(id)

/** A schedule from what the person typed, or the reason it cannot be one. */
fun validateSchedule(prompt: String, hour: Int, minute: Int, days: Set<Int>): String? = when {
    prompt.isBlank() -> "Type the prompt to schedule."
    prompt.trim().length > SCHEDULE_PROMPT_MAX -> "Keep the prompt under $SCHEDULE_PROMPT_MAX characters."
    hour !in 0..23 || minute !in 0..59 -> "Pick a time of day."
    days.isEmpty() || days.any { it !in 1..7 } -> "Pick at least one day."
    else -> null
}

/** When [schedule] next comes due strictly after [now], in [zone]; null when
 * it is switched off or has no days. A time a clock change skips (02:30 on a
 * spring-forward night) moves to the first minute that exists. */
fun nextFireAt(schedule: RecipeSchedule, now: Long, zone: ZoneId): Long? {
    if (!schedule.enabled || schedule.days.isEmpty()) return null
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    for (offset in 0L..7L) {
        val date = today.plusDays(offset)
        if (date.dayOfWeek.value !in schedule.days) continue
        val at = ZonedDateTime.of(date.atTime(schedule.hour, schedule.minute), zone).toInstant().toEpochMilli()
        if (at > now) return at
    }
    return null
}

private val DAY_NAMES = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

/** "Every day at 08:00", "Weekdays at 18:30", "Mon, Thu at 07:05". */
fun scheduleLabel(schedule: RecipeSchedule): String {
    val days = when (schedule.days) {
        EVERY_DAY -> "Every day"
        WEEKDAYS -> "Weekdays"
        WEEKEND -> "Weekends"
        else -> schedule.days.sorted().filter { it in 1..7 }.joinToString(", ") { DAY_NAMES[it - 1] }
    }
    return days + " at " + "%02d:%02d".format(schedule.hour, schedule.minute)
}

/** Replaces the schedule with the same id, or adds it at the end while there
 * is room; a full list comes back unchanged. */
fun upsertSchedule(list: List<RecipeSchedule>, schedule: RecipeSchedule): List<RecipeSchedule> = when {
    list.any { it.id == schedule.id } -> list.map { if (it.id == schedule.id) schedule else it }
    list.size >= SCHEDULE_MAX -> list
    else -> list + schedule
}

fun schedulesToJson(list: List<RecipeSchedule>): String {
    val items = JSONArray()
    list.forEach { s ->
        items.put(
            JSONObject()
                .put("id", s.id)
                .put("prompt", s.prompt)
                .put("hour", s.hour)
                .put("minute", s.minute)
                .put("days", JSONArray(s.days.sorted()))
                .put("enabled", s.enabled),
        )
    }
    return JSONObject().put("v", 1).put("schedules", items).toString()
}

/** The stored list; anything that would not pass [validateSchedule] or has a
 * bad id is dropped rather than scheduled. */
fun schedulesFromJson(text: String?): List<RecipeSchedule> {
    if (text.isNullOrBlank()) return emptyList()
    return try {
        val items = JSONObject(text).optJSONArray("schedules") ?: JSONArray()
        (0 until items.length()).mapNotNull { index ->
            val item = items.optJSONObject(index) ?: return@mapNotNull null
            val daysJson = item.optJSONArray("days") ?: JSONArray()
            val days = (0 until daysJson.length()).map { daysJson.optInt(it, 0) }.toSet()
            val schedule = RecipeSchedule(
                id = item.optString("id", ""),
                prompt = item.optString("prompt", "").trim(),
                hour = item.optInt("hour", -1),
                minute = item.optInt("minute", -1),
                days = days,
                enabled = item.optBoolean("enabled", true),
            )
            if (isScheduleId(schedule.id) && validateSchedule(schedule.prompt, schedule.hour, schedule.minute, schedule.days) == null) schedule else null
        }.distinctBy { it.id }.take(SCHEDULE_MAX)
    } catch (e: Exception) {
        emptyList()
    }
}
