package com.neura.os.app.data

import org.json.JSONArray
import org.json.JSONObject

// Device automation history: what the user ran from the Automate tab, so the
// screen shows real runs instead of nothing. Pure data -- the execution itself
// is the ordinary agent loop (phone_action buttons the user taps), never a
// second, unsupervised path.

/** One automation the user ran, newest first in the list that holds it. */
data class AutomationEntry(val prompt: String, val ranAt: Long)

/** How many runs the history keeps. Older entries fall off the end. */
const val AUTOMATION_HISTORY_MAX = 10

/** Records a run: a prompt seen before moves to the front with the new time;
 * a new one is prepended. The list never grows past [AUTOMATION_HISTORY_MAX]. */
fun recordAutomation(entries: List<AutomationEntry>, prompt: String, now: Long): List<AutomationEntry> {
    val trimmed = prompt.trim()
    if (trimmed.isEmpty()) return entries
    val rest = entries.filter { it.prompt != trimmed }
    return (listOf(AutomationEntry(trimmed, now)) + rest).take(AUTOMATION_HISTORY_MAX)
}

fun automationsToJson(entries: List<AutomationEntry>): String {
    val list = JSONArray()
    entries.forEach { list.put(JSONObject().put("prompt", it.prompt).put("ranAt", it.ranAt)) }
    return JSONObject().put("v", 1).put("entries", list).toString()
}

fun automationsFromJson(text: String?): List<AutomationEntry> {
    if (text.isNullOrBlank()) return emptyList()
    return try {
        val list = JSONObject(text).optJSONArray("entries") ?: JSONArray()
        (0 until list.length()).mapNotNull { index ->
            list.optJSONObject(index)?.let {
                val prompt = it.optString("prompt", "").trim()
                if (prompt.isEmpty()) null else AutomationEntry(prompt, it.optLong("ranAt", 0L))
            }
        }.take(AUTOMATION_HISTORY_MAX)
    } catch (e: Exception) {
        emptyList()
    }
}
