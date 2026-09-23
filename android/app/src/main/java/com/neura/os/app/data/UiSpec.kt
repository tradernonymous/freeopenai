package com.neura.os.app.data

import org.json.JSONArray
import org.json.JSONObject

// Generative UI (docs/android-master-plan.md V8, rebrand plan §4.4): a reply
// may carry a fenced ```ui block of JSON -- a small subset of Google's A2UI
// idea -- that the app draws with its own components: choices to tap, a
// short form, a table, a card. Nothing in it ever runs: it is data, checked
// here against fixed kinds and limits. A tap or a submit becomes an ordinary
// message the person sends. Anything that does not parse returns null and
// stays visible as code, exactly like a ```chart block.

sealed interface UiSpec {
    /** Tap one option; it is sent as your reply. */
    data class Choices(val prompt: String, val options: List<String>) : UiSpec

    /** A few fields and one submit button; the answers are sent as one reply. */
    data class Form(val title: String, val fields: List<UiField>, val submit: String) : UiSpec

    data class Table(val columns: List<String>, val rows: List<List<String>>) : UiSpec

    /** A summary card, with up to four suggested replies. */
    data class Card(val title: String, val body: String, val actions: List<String>) : UiSpec

    /** A chart, the same spec a ```chart block takes (data/ChartSpec.kt). */
    data class Chart(val chart: ChartSpec) : UiSpec
}

enum class FieldKind { TEXT, NUMBER, DATE, TIME, SELECT }

data class UiField(val id: String, val label: String, val kind: FieldKind, val options: List<String> = emptyList(), val required: Boolean = false)

const val UI_MAX_OPTIONS = 8
const val UI_MAX_FIELDS = 8
const val UI_MAX_COLUMNS = 6
const val UI_MAX_ROWS = 50
const val UI_MAX_ACTIONS = 4
private const val UI_TEXT_MAX = 400

/** What the system prompt tells a model a ui block looks like. */
const val UI_FORMAT_HINT =
    "Interactive answers: when the person must pick or fill something in, you may add one fenced block tagged ui holding JSON, one of " +
        "{\"type\":\"choices\",\"prompt\":\"...\",\"options\":[\"...\"]}, " +
        "{\"type\":\"form\",\"title\":\"...\",\"fields\":[{\"id\":\"...\",\"label\":\"...\",\"kind\":\"text|number|date|time|select\",\"options\":[...],\"required\":true}],\"submit\":\"...\"}, " +
        "{\"type\":\"table\",\"columns\":[...],\"rows\":[[...]]}, {\"type\":\"card\",\"title\":\"...\",\"body\":\"...\",\"actions\":[\"...\"]} " +
        "or {\"type\":\"chart\",\"chart\":{a chart spec as above}}; " +
        "the app draws it and sends the person's choice back as their next message."

private fun String.clip(): String = trim().replace(Regex("\\s+"), " ").take(UI_TEXT_MAX)

private fun JSONArray?.strings(max: Int): List<String>? {
    if (this == null) return null
    if (length() > max) return null
    return (0 until length()).map { index ->
        val value = opt(index)
        if (value !is String && value !is Number && value !is Boolean) return null
        value.toString().clip()
    }.filter { it.isNotEmpty() }
}

private val FIELD_ID = Regex("^[A-Za-z][A-Za-z0-9_]{0,31}$")

fun parseUiSpec(json: String): UiSpec? = try {
    val obj = JSONObject(json)
    when (obj.optString("type", "").lowercase()) {
        "choices" -> {
            val options = obj.optJSONArray("options").strings(UI_MAX_OPTIONS)
            if (options.isNullOrEmpty()) null else UiSpec.Choices(obj.optString("prompt", "").clip(), options.distinct())
        }
        "form" -> {
            val raw = obj.optJSONArray("fields")
            if (raw == null || raw.length() == 0 || raw.length() > UI_MAX_FIELDS) {
                null
            } else {
                val fields = (0 until raw.length()).map { index ->
                    val item = raw.optJSONObject(index) ?: return null
                    val id = item.optString("id", "")
                    if (!FIELD_ID.matches(id)) return null
                    val kind = when (item.optString("kind", "text").lowercase()) {
                        "text" -> FieldKind.TEXT
                        "number" -> FieldKind.NUMBER
                        "date" -> FieldKind.DATE
                        "time" -> FieldKind.TIME
                        "select" -> FieldKind.SELECT
                        else -> return null
                    }
                    val options = item.optJSONArray("options").strings(UI_MAX_OPTIONS).orEmpty()
                    if (kind == FieldKind.SELECT && options.isEmpty()) return null
                    UiField(id, item.optString("label", id).clip().ifEmpty { id }, kind, options, item.optBoolean("required", false))
                }
                if (fields.map { it.id }.toSet().size != fields.size) null
                else UiSpec.Form(obj.optString("title", "").clip(), fields, obj.optString("submit", "Send").clip().ifEmpty { "Send" })
            }
        }
        "table" -> {
            val columns = obj.optJSONArray("columns").strings(UI_MAX_COLUMNS)
            val rawRows = obj.optJSONArray("rows")
            if (columns.isNullOrEmpty() || rawRows == null || rawRows.length() == 0 || rawRows.length() > UI_MAX_ROWS) {
                null
            } else {
                val rows = (0 until rawRows.length()).map { index ->
                    val row = rawRows.optJSONArray(index).strings(UI_MAX_COLUMNS) ?: return null
                    if (row.size > columns.size) return null
                    row + List(columns.size - row.size) { "" }
                }
                UiSpec.Table(columns, rows)
            }
        }
        "chart" -> obj.optJSONObject("chart")?.let { parseChartSpec(it.toString()) }?.let { UiSpec.Chart(it) }
        "card" -> {
            val title = obj.optString("title", "").clip()
            val body = obj.optString("body", "").trim().take(UI_TEXT_MAX * 3)
            val actions = obj.optJSONArray("actions").strings(UI_MAX_ACTIONS) ?: emptyList()
            if (title.isEmpty() && body.isEmpty()) null else UiSpec.Card(title, body, actions)
        }
        else -> null
    }
} catch (e: Exception) {
    null
}

/** The message a submitted form sends: one "Label: value" line per filled
 * field, or the reason it cannot be sent yet. */
fun formAnswer(form: UiSpec.Form, values: Map<String, String>): Result<String> {
    val missing = form.fields.filter { it.required && values[it.id].isNullOrBlank() }
    if (missing.isNotEmpty()) return Result.failure(IllegalArgumentException("Fill in: " + missing.joinToString(", ") { it.label }))
    val badNumber = form.fields.firstOrNull { it.kind == FieldKind.NUMBER && !values[it.id].isNullOrBlank() && values[it.id]!!.trim().toDoubleOrNull() == null }
    if (badNumber != null) return Result.failure(IllegalArgumentException(badNumber.label + " needs a number"))
    val lines = form.fields.mapNotNull { field ->
        values[field.id]?.trim()?.takeIf { it.isNotEmpty() }?.let { field.label + ": " + it.take(UI_TEXT_MAX) }
    }
    if (lines.isEmpty()) return Result.failure(IllegalArgumentException("Nothing filled in yet"))
    return Result.success(lines.joinToString("\n"))
}

/** A date picker's choice (midnight UTC, as Material's picker reports it)
 * as the form's text: "2026-09-23". */
fun pickedDate(utcMillis: Long): String =
    java.time.Instant.ofEpochMilli(utcMillis).atZone(java.time.ZoneOffset.UTC).toLocalDate().toString()

/** A time picker's choice as the form's text: "09:05". */
fun pickedTime(hour: Int, minute: Int): String = "%02d:%02d".format(hour.coerceIn(0, 23), minute.coerceIn(0, 59))

/** The picker's starting point for what a field already holds: a typed or
 * earlier date as UTC millis, or null to open on today. */
fun dateMillisOf(text: String): Long? = try {
    java.time.LocalDate.parse(text.trim()).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
} catch (e: Exception) {
    null
}
