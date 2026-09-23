package com.neura.os.app.data

import org.json.JSONArray
import org.json.JSONObject

// Remote builds: the phone writes a plan (Plan mode), the server carries it out
// in its sandbox, and every file change or command waits for an approval sent
// from here. The contract is the server's /api/build/sessions routes; this file
// is only parsing and state folding, so it runs in plain JVM tests.
//
// Reconnects follow deepseek-harness-mobile's pattern: events carry a sequence
// number, the stream resumes from the last one seen (Last-Event-ID), and folding
// an event twice is harmless.

data class BuildStep(val id: String, val title: String, val status: String, val note: String)

data class BuildPending(
    val requestId: String,
    val kind: String,
    val tool: String,
    val summary: String,
    val preview: String,
    val question: String,
)

data class BuildSession(
    val id: String,
    val status: String,
    val steps: List<BuildStep>,
    val provider: String,
    val model: String,
    val repo: String,
    val startedAt: Long,
    val summary: String,
    val error: String,
    val pending: BuildPending?,
    val lastSeq: Long,
) {
    val finished: Boolean get() = status in BUILD_FINISHED
    val waiting: Boolean get() = status in BUILD_WAITING
    val doneSteps: Int get() = steps.count { it.status == "done" }
}

data class BuildList(
    val enabled: Boolean,
    val reason: String,
    val runEnabled: Boolean,
    val runReason: String,
    val sessions: List<BuildSession>,
)

sealed interface BuildEvent {
    val seq: Long

    data class Status(override val seq: Long, val status: String) : BuildEvent
    data class StepChange(override val seq: Long, val id: String, val phase: String, val title: String, val text: String) : BuildEvent
    data class Output(override val seq: Long, val title: String, val text: String) : BuildEvent
    data class Diff(override val seq: Long, val path: String, val patch: String, val bytes: Long, val created: Boolean) : BuildEvent
    data class Approval(override val seq: Long, val requestId: String, val tool: String, val summary: String, val preview: String) : BuildEvent
    data class Question(override val seq: Long, val requestId: String, val question: String) : BuildEvent
    data class Answer(override val seq: Long, val decision: String, val text: String) : BuildEvent
    data class Message(override val seq: Long, val text: String) : BuildEvent
    data class Done(override val seq: Long, val summary: String) : BuildEvent
    data class Failed(override val seq: Long, val status: String, val error: String) : BuildEvent
    data class Gap(override val seq: Long) : BuildEvent
}

val BUILD_FINISHED = setOf("done", "failed", "cancelled", "expired")
val BUILD_WAITING = setOf("awaiting_approval", "awaiting_input")

private val PLAN_NUMBERED = Regex("^\\s*(?:step\\s*)?\\d{1,3}[.):]\\s+\\S", RegexOption.IGNORE_CASE)
private val PLAN_BULLET = Regex("^\\s*[-*+]\\s+(?:\\[[ xX]?]\\s*)?\\S")

/** A reply worth offering to build: two numbered steps, or three bullets. */
fun looksLikePlan(text: String): Boolean {
    val lines = text.lines()
    return lines.count { PLAN_NUMBERED.containsMatchIn(it) } >= 2 || lines.count { PLAN_BULLET.containsMatchIn(it) } >= 3
}

fun buildStatusLabel(status: String): String = when (status) {
    "queued" -> "Queued"
    "running" -> "Running"
    "awaiting_approval" -> "Needs approval"
    "awaiting_input" -> "Needs an answer"
    "done" -> "Done"
    "failed" -> "Failed"
    "cancelled" -> "Cancelled"
    "expired" -> "Expired"
    else -> status
}

private fun pendingFrom(obj: JSONObject?): BuildPending? {
    if (obj == null) return null
    val requestId = obj.optString("requestId", "")
    if (requestId.isEmpty()) return null
    return BuildPending(
        requestId = requestId,
        kind = obj.optString("kind", "approval"),
        tool = obj.optString("tool", ""),
        summary = obj.optString("summary", ""),
        preview = obj.optString("preview", ""),
        question = obj.optString("question", ""),
    )
}

private fun sessionFrom(obj: JSONObject): BuildSession? {
    val id = obj.optString("id", "")
    if (id.isEmpty()) return null
    val stepsJson = obj.optJSONArray("steps") ?: JSONArray()
    val steps = (0 until stepsJson.length()).mapNotNull { index ->
        stepsJson.optJSONObject(index)?.let {
            BuildStep(it.optString("id", ""), it.optString("title", ""), it.optString("status", "pending"), it.optString("note", ""))
        }
    }
    return BuildSession(
        id = id,
        status = obj.optString("status", "queued"),
        steps = steps,
        provider = obj.optString("provider", ""),
        model = obj.optString("model", ""),
        repo = obj.optString("repo", ""),
        startedAt = obj.optLong("startedAt", 0L),
        summary = obj.optString("summary", ""),
        error = obj.optString("error", ""),
        pending = if (obj.isNull("pending")) null else pendingFrom(obj.optJSONObject("pending")),
        lastSeq = obj.optLong("lastSeq", 0L),
    )
}

/** GET/POST /api/build/sessions[/:id]: one session view. */
fun parseBuildSession(text: String): BuildSession? = try {
    sessionFrom(JSONObject(text))
} catch (e: Exception) {
    null
}

/** GET /api/build/sessions: the server's switches and this account's builds. */
fun parseBuildList(text: String): BuildList = try {
    val obj = JSONObject(text)
    val rows = obj.optJSONArray("sessions") ?: JSONArray()
    BuildList(
        enabled = obj.optBoolean("enabled", false),
        reason = obj.optString("reason", ""),
        runEnabled = obj.optBoolean("runEnabled", false),
        runReason = obj.optString("runReason", ""),
        sessions = (0 until rows.length()).mapNotNull { rows.optJSONObject(it)?.let(::sessionFrom) },
    )
} catch (e: Exception) {
    BuildList(false, "The server sent an unreadable build list.", false, "", emptyList())
}

/** One SSE frame's data, named by its `event:` line. Unknown kinds are skipped. */
fun buildEventFrom(type: String, data: String): BuildEvent? = try {
    val o = JSONObject(data)
    val seq = o.optLong("seq", 0L)
    when (type) {
        "status" -> BuildEvent.Status(seq, o.optString("status", ""))
        "step" -> if (o.optString("phase") == "output") {
            BuildEvent.Output(seq, o.optString("title", ""), o.optString("text", ""))
        } else {
            BuildEvent.StepChange(seq, o.optString("id", ""), o.optString("phase", ""), o.optString("title", ""), o.optString("text", ""))
        }
        "diff" -> BuildEvent.Diff(seq, o.optString("path", ""), o.optString("patch", ""), o.optLong("bytes", 0L), o.optBoolean("created", false))
        "approval" -> BuildEvent.Approval(seq, o.optString("requestId", ""), o.optString("tool", ""), o.optString("summary", ""), o.optString("preview", ""))
        "question" -> BuildEvent.Question(seq, o.optString("requestId", ""), o.optString("question", ""))
        "answer" -> BuildEvent.Answer(seq, o.optString("decision", ""), o.optString("text", ""))
        "message" -> BuildEvent.Message(seq, o.optString("text", ""))
        "done" -> BuildEvent.Done(seq, o.optString("summary", ""))
        "failed" -> BuildEvent.Failed(seq, o.optString("status", "failed"), o.optString("error", ""))
        "gap" -> BuildEvent.Gap(seq)
        else -> null
    }
} catch (e: Exception) {
    null
}

/** Folds one event into the session on screen. Replaying an event is safe. */
fun applyBuildEvent(session: BuildSession, event: BuildEvent): BuildSession {
    val seq = maxOf(session.lastSeq, event.seq)
    return when (event) {
        is BuildEvent.Status -> session.copy(
            status = event.status,
            pending = if (event.status in BUILD_WAITING) session.pending else null,
            lastSeq = seq,
        )
        is BuildEvent.StepChange -> session.copy(
            steps = session.steps.map {
                if (it.id != event.id) it
                else it.copy(status = if (event.phase == "started") "in_progress" else event.phase, note = event.text)
            },
            lastSeq = seq,
        )
        is BuildEvent.Approval -> session.copy(
            pending = BuildPending(event.requestId, "approval", event.tool, event.summary, event.preview, ""),
            lastSeq = seq,
        )
        is BuildEvent.Question -> session.copy(
            pending = BuildPending(event.requestId, "question", "", "", "", event.question),
            lastSeq = seq,
        )
        is BuildEvent.Answer -> session.copy(pending = null, lastSeq = seq)
        is BuildEvent.Done -> session.copy(status = "done", summary = event.summary, pending = null, lastSeq = seq)
        is BuildEvent.Failed -> session.copy(status = event.status.ifEmpty { "failed" }, error = event.error, pending = null, lastSeq = seq)
        else -> session.copy(lastSeq = seq)
    }
}

/** POST /input body: an approval names its decision; an answer is just text. */
fun buildInputBody(requestId: String, decision: String?, text: String): String {
    val body = JSONObject().put("requestId", requestId)
    if (decision != null) body.put("decision", decision)
    if (text.isNotBlank()) body.put("text", text.trim())
    return body.toString()
}

/** Collects SSE lines into (event type, data) frames, dispatched on a blank line. */
class SseFrames {
    private var type = "message"
    private val data = StringBuilder()
    var lastId: Long = 0L
        private set

    fun feed(line: String): Pair<String, String>? {
        if (line.isEmpty()) {
            if (data.isEmpty()) {
                type = "message"
                return null
            }
            val frame = type to data.toString()
            type = "message"
            data.setLength(0)
            return frame
        }
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
        when (field) {
            "event" -> type = value
            "data" -> {
                if (data.isNotEmpty()) data.append('\n')
                data.append(value)
            }
            "id" -> value.toLongOrNull()?.let { lastId = it }
        }
        return null
    }
}

private val BUILD_HEX_ID = Regex("^[a-f0-9]{16,64}$")

/** A build id and a request id as the server makes them (agent-sessions.js:
 * hex). Checked before an Approve tapped on a notification reaches the
 * network (master plan v2, V7), since both arrive through an intent. */
fun isApprovalTarget(buildId: String?, requestId: String?): Boolean =
    buildId != null && requestId != null && BUILD_HEX_ID.matches(buildId) && BUILD_HEX_ID.matches(requestId)
