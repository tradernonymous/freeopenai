package com.freeai4u.app.data

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// Chat / Plan / Build for the native app, as pure functions: the mode
// instructions, which tools each mode offers, and how the local tools (tasks,
// files, phone actions) change a conversation. The network tools (web search,
// page reading, image generation) run in the view model; everything that can
// be decided without a phone or a server lives here and is unit-tested.

const val MAX_TOOL_ROUNDS = 8
// Declared before the tool schemas below, which read them while the file's
// top-level values initialise in order.
val TASK_STATUSES = listOf("todo", "doing", "done", "blocked")
val ACTION_KINDS = listOf("alarm", "timer", "event", "map", "dial", "email", "open_url", "share", "copy")
private const val MAX_FILE_CHARS = 60_000
private const val MAX_FILES = 40

fun modeLabel(mode: String): String = when (mode) {
    "plan" -> "Plan"
    "build" -> "Build"
    else -> "Chat"
}

fun modeInstructions(mode: String): String = when (mode) {
    "plan" -> listOf(
        "MODE: PLAN. The user wants a plan, not changes.",
        "Investigate first: search the web and read pages for anything you are not sure of.",
        "Then answer with: a one-line goal, what you found, a numbered step-by-step plan, risks, and open questions.",
        "Record every step with task_add so Build mode can carry it out. Keep task titles short.",
        "End by suggesting the user switch to Build to execute.",
    ).joinToString("\n")
    "build" -> listOf(
        "MODE: BUILD. You execute agreed work with tools.",
        "- Start from the task list: call task_list, add missing steps, and move each task to doing/done as you go.",
        "- Write drafts, code and documents to the chat's files with file_write; read them back with file_read.",
        "- Use phone_action only for what the user asked (alarm, timer, calendar event, map, call, email, link, share). The user confirms each one with a tap; never claim it already happened.",
        "- Use generate_image when a picture is wanted.",
        "- Verify before saying done; finish every task or say why it is still open.",
        "- End with a short summary: what changed, what is left.",
    ).joinToString("\n")
    else -> listOf(
        "MODE: CHAT. Answer directly and concisely.",
        "Search the web when the answer depends on recent or external facts, and cite sources as [title](url).",
        "You can propose a phone action (alarm, event, map, link) with phone_action when the user asks for one; they confirm with a tap.",
    ).joinToString("\n")
}

/** The whole system prompt: persona, custom instructions, mode, and today. */
fun systemPrompt(personaPrompt: String, instructions: String, mode: String, now: Long = System.currentTimeMillis()): String {
    val today = SimpleDateFormat("EEEE d MMMM yyyy, HH:mm z", Locale.US).format(Date(now))
    return listOfNotNull(
        personaPrompt.trim().ifEmpty { null },
        instructions.trim().ifEmpty { null }?.let { "About the user and how to answer:\n$it" },
        modeInstructions(mode),
        "Current date and time: $today. You are running in the FreeAI4U Android app.",
    ).joinToString("\n\n")
}

private fun tool(name: String, description: String, properties: JSONObject, required: List<String>): JSONObject =
    JSONObject().put("type", "function").put(
        "function",
        JSONObject().put("name", name).put("description", description)
            .put("parameters", JSONObject().put("type", "object").put("properties", properties).put("required", JSONArray(required))),
    )

private fun prop(type: String, description: String): JSONObject = JSONObject().put("type", type).put("description", description)

private val WEB_SEARCH = tool("web_search", "Search the web for current or external facts. Returns titles, URLs and snippets; cite them.", JSONObject().put("query", prop("string", "Specific search query.")), listOf("query"))
private val WEB_FETCH = tool("web_fetch", "Read one web page as plain text (up to ~8000 characters).", JSONObject().put("url", prop("string", "Full http(s) URL.")), listOf("url"))
private val TASK_LIST = tool("task_list", "List this chat's plan tasks with id and status.", JSONObject(), emptyList())
private val TASK_ADD = tool("task_add", "Add one plan task (work not yet done).", JSONObject().put("title", prop("string", "Short task title.")).put("detail", prop("string", "Optional detail.")), listOf("title"))
private val TASK_UPDATE = tool(
    "task_update", "Set a task's status.",
    JSONObject().put("id", prop("string", "Task id, e.g. t2.")).put("status", JSONObject().put("type", "string").put("enum", JSONArray(TASK_STATUSES))),
    listOf("id", "status"),
)
private val FILE_LIST = tool("file_list", "List this chat's files.", JSONObject(), emptyList())
private val FILE_READ = tool("file_read", "Read one of this chat's files.", JSONObject().put("path", prop("string", "File path, e.g. notes.md.")), listOf("path"))
private val FILE_WRITE = tool("file_write", "Create or replace one of this chat's files.", JSONObject().put("path", prop("string", "File path, e.g. plan.md.")).put("content", prop("string", "Full file text.")), listOf("path", "content"))
private val GENERATE_IMAGE = tool("generate_image", "Draw a picture from a detailed prompt; it is shown in the chat.", JSONObject().put("prompt", prop("string", "Detailed image prompt: subject, style, lighting.")), listOf("prompt"))
private val PHONE_ACTION = tool(
    "phone_action",
    "Propose an action on the user's phone. It appears as a button the user taps; nothing happens without that tap.",
    JSONObject()
        .put("kind", JSONObject().put("type", "string").put("enum", JSONArray(ACTION_KINDS)))
        .put("title", prop("string", "Label, alarm name, event title or email subject."))
        .put("text", prop("string", "Text to share or copy, or email body."))
        .put("url", prop("string", "Link for open_url."))
        .put("query", prop("string", "Place for map."))
        .put("number", prop("string", "Phone number for dial."))
        .put("email", prop("string", "Recipient for email."))
        .put("hour", prop("integer", "0-23 for alarm."))
        .put("minute", prop("integer", "0-59 for alarm."))
        .put("seconds", prop("integer", "Length for timer."))
        .put("start", prop("string", "Event start, ISO 8601 local, e.g. 2026-09-20T15:00."))
        .put("end", prop("string", "Event end, ISO 8601 local."))
        .put("location", prop("string", "Event location.")),
    listOf("kind"),
)

/** Which tools a mode offers. Chat researches and draws; Plan also records tasks;
 * Build also writes files. Phone actions are offered everywhere
 * because each one waits for the user's tap. */
fun toolsForMode(mode: String): JSONArray {
    val list = when (mode) {
        "plan" -> listOf(WEB_SEARCH, WEB_FETCH, TASK_LIST, TASK_ADD, TASK_UPDATE, FILE_LIST, FILE_READ, PHONE_ACTION)
        "build" -> listOf(WEB_SEARCH, WEB_FETCH, TASK_LIST, TASK_ADD, TASK_UPDATE, FILE_LIST, FILE_READ, FILE_WRITE, GENERATE_IMAGE, PHONE_ACTION)
        else -> listOf(WEB_SEARCH, WEB_FETCH, GENERATE_IMAGE, PHONE_ACTION)
    }
    return JSONArray().also { array -> list.forEach { array.put(JSONObject(it.toString())) } }
}

fun toolAllowed(mode: String, name: String): Boolean {
    val tools = toolsForMode(mode)
    return (0 until tools.length()).any { tools.getJSONObject(it).getJSONObject("function").getString("name") == name }
}

fun parseArguments(raw: String): JSONObject = try {
    JSONObject(raw.ifBlank { "{}" })
} catch (e: Exception) {
    JSONObject()
}

/** What a local tool did: the text the model reads back, and the chat after. */
data class LocalResult(val output: String, val conversation: Conversation)

/** Runs task_* and file_* tools against the conversation. Returns null for a
 * tool this function does not own (network tools, images, phone actions). */
fun runLocalTool(conversation: Conversation, call: ToolCall): LocalResult? {
    val args = parseArguments(call.arguments)
    if (!toolAllowed(conversation.mode, call.name)) {
        return LocalResult("Error: ${call.name} is not available in ${modeLabel(conversation.mode)} mode.", conversation)
    }
    return when (call.name) {
        "task_list" -> LocalResult(
            if (conversation.tasks.isEmpty()) "No tasks yet."
            else conversation.tasks.joinToString("\n") { "${it.id} [${it.status}] ${it.title}" + if (it.detail.isNotBlank()) " — ${it.detail}" else "" },
            conversation,
        )
        "task_add" -> {
            val title = args.optString("title", "").trim().take(120)
            if (title.isEmpty()) return LocalResult("Error: title is required.", conversation)
            val next = (conversation.tasks.mapNotNull { it.id.removePrefix("t").toIntOrNull() }.maxOrNull() ?: 0) + 1
            val task = TaskItem("t$next", title, "todo", args.optString("detail", "").trim().take(500))
            LocalResult("Added ${task.id}: ${task.title}", conversation.copy(tasks = conversation.tasks + task))
        }
        "task_update" -> {
            val id = args.optString("id", "")
            val status = args.optString("status", "")
            if (status !in TASK_STATUSES) return LocalResult("Error: status must be one of ${TASK_STATUSES.joinToString()}.", conversation)
            if (conversation.tasks.none { it.id == id }) return LocalResult("Error: no task $id. Call task_list.", conversation)
            LocalResult("$id is now $status.", conversation.copy(tasks = conversation.tasks.map { if (it.id == id) it.copy(status = status) else it }))
        }
        "file_list" -> LocalResult(
            if (conversation.files.isEmpty()) "No files yet."
            else conversation.files.entries.joinToString("\n") { "${it.key} (${it.value.length} chars)" },
            conversation,
        )
        "file_read" -> {
            val path = cleanPath(args.optString("path", ""))
            val text = conversation.files[path] ?: return LocalResult("Error: no file $path.", conversation)
            LocalResult(text, conversation)
        }
        "file_write" -> {
            val path = cleanPath(args.optString("path", ""))
            if (path.isEmpty()) return LocalResult("Error: path is required.", conversation)
            val content = args.optString("content", "")
            if (content.length > MAX_FILE_CHARS) return LocalResult("Error: files are limited to $MAX_FILE_CHARS characters.", conversation)
            if (!conversation.files.containsKey(path) && conversation.files.size >= MAX_FILES) return LocalResult("Error: this chat already has $MAX_FILES files.", conversation)
            LocalResult("Wrote $path (${content.length} chars).", conversation.copy(files = conversation.files + (path to content)))
        }
        else -> null
    }
}

/** A relative path with no traversal, backslashes or leading slashes. */
fun cleanPath(raw: String): String = raw.trim().replace('\\', '/').split('/')
    .filter { it.isNotEmpty() && it != "." && it != ".." }
    .joinToString("/")
    .take(120)

/** A phone action the user can run with one tap. */
data class PhoneAction(
    val kind: String,
    val title: String = "",
    val text: String = "",
    val url: String = "",
    val query: String = "",
    val number: String = "",
    val email: String = "",
    val hour: Int = -1,
    val minute: Int = -1,
    val seconds: Int = -1,
    val start: String = "",
    val end: String = "",
    val location: String = "",
) {
    fun toJson(): String = JSONObject()
        .put("kind", kind).put("title", title).put("text", text).put("url", url).put("query", query)
        .put("number", number).put("email", email).put("hour", hour).put("minute", minute).put("seconds", seconds)
        .put("start", start).put("end", end).put("location", location).toString()

    /** A short button label, e.g. "Set alarm 07:30". */
    fun label(): String = when (kind) {
        "alarm" -> "Set alarm %02d:%02d".format(hour, minute) + if (title.isNotBlank()) " · $title" else ""
        "timer" -> "Start timer " + formatSeconds(seconds) + if (title.isNotBlank()) " · $title" else ""
        "event" -> "Add event · " + title.ifBlank { "Untitled" }
        "map" -> "Open map · $query"
        "dial" -> "Call $number"
        "email" -> "Email $email"
        "open_url" -> "Open " + url.removePrefix("https://").take(40)
        "share" -> "Share text"
        "copy" -> "Copy text"
        else -> kind
    }
}

private fun formatSeconds(total: Int): String {
    val minutes = total / 60
    val seconds = total % 60
    return if (minutes > 0) "${minutes}m ${seconds}s" else "${seconds}s"
}

/** Validates a phone_action call. Returns the action or the error the model
 * should read. Links must be https; numbers only digits and + * # - space. */
fun parsePhoneAction(raw: String): Pair<PhoneAction?, String> {
    val args = parseArguments(raw)
    val kind = args.optString("kind", "")
    if (kind !in ACTION_KINDS) return null to "Error: kind must be one of ${ACTION_KINDS.joinToString()}."
    val action = PhoneAction(
        kind = kind,
        title = args.optString("title", "").take(120),
        text = args.optString("text", "").take(4000),
        url = args.optString("url", "").trim(),
        query = args.optString("query", "").take(200),
        number = args.optString("number", "").trim(),
        email = args.optString("email", "").trim().take(200),
        hour = args.optInt("hour", -1),
        minute = args.optInt("minute", 0),
        seconds = args.optInt("seconds", -1),
        start = args.optString("start", "").trim(),
        end = args.optString("end", "").trim(),
        location = args.optString("location", "").take(200),
    )
    val problem = when (kind) {
        "alarm" -> if (action.hour !in 0..23 || action.minute !in 0..59) "hour 0-23 and minute 0-59 are required" else null
        "timer" -> if (action.seconds !in 1..86_400) "seconds 1-86400 is required" else null
        "event" -> if (action.title.isBlank() || parseLocalDateTime(action.start) == null) "title and start (ISO 8601) are required" else null
        "map" -> if (action.query.isBlank()) "query is required" else null
        "dial" -> if (!Regex("^[0-9+*#() -]{3,20}$").matches(action.number)) "a valid number is required" else null
        "email" -> if (!action.email.contains('@')) "a recipient email is required" else null
        "open_url" -> if (!action.url.startsWith("https://") || action.url.length > 2000) "an https:// url is required" else null
        "share", "copy" -> if (action.text.isBlank()) "text is required" else null
        else -> null
    }
    return if (problem != null) null to "Error: $problem." else action to "Shown to the user as a button: \"${action.label()}\". It runs only if they tap it."
}

fun phoneActionFromJson(json: String): PhoneAction? = try {
    val obj = JSONObject(json)
    PhoneAction(
        obj.optString("kind", ""), obj.optString("title", ""), obj.optString("text", ""), obj.optString("url", ""),
        obj.optString("query", ""), obj.optString("number", ""), obj.optString("email", ""), obj.optInt("hour", -1),
        obj.optInt("minute", -1), obj.optInt("seconds", -1), obj.optString("start", ""), obj.optString("end", ""),
        obj.optString("location", ""),
    ).takeIf { it.kind in ACTION_KINDS }
} catch (e: Exception) {
    null
}

/** Epoch millis for "yyyy-MM-ddTHH:mm[:ss]" in the phone's time zone. */
fun parseLocalDateTime(text: String): Long? {
    val patterns = listOf("yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm", "yyyy-MM-dd")
    for (pattern in patterns) {
        try {
            val format = SimpleDateFormat(pattern, Locale.US)
            format.isLenient = false
            val date = format.parse(text.trim().take(19)) ?: continue
            return date.time
        } catch (ignored: Exception) {
        }
    }
    return null
}

/** Formats search results for the model to read. */
fun formatSearchResults(body: String): String = try {
    val results = JSONObject(body).optJSONArray("results") ?: JSONArray()
    if (results.length() == 0) "No results."
    else (0 until results.length()).joinToString("\n\n") { index ->
        val row = results.getJSONObject(index)
        "${index + 1}. ${row.optString("title")}\n${row.optString("url")}\n${row.optString("snippet", row.optString("text", "")).take(400)}"
    }
} catch (e: Exception) {
    "No results."
}

fun formatFetchedPage(body: String): String = try {
    val obj = JSONObject(body)
    "# " + obj.optString("title", "") + "\n" + obj.optString("url", "") + "\n\n" + obj.optString("text", "")
} catch (e: Exception) {
    "Could not read that page."
}

/** One-line description of a tool call for its card in the chat. */
fun toolCallSummary(call: ToolCall): String {
    val args = parseArguments(call.arguments)
    return when (call.name) {
        "web_search" -> "Searched “" + args.optString("query", "") + "”"
        "web_fetch" -> "Read " + args.optString("url", "").removePrefix("https://").take(48)
        "task_list" -> "Checked tasks"
        "task_add" -> "Added task · " + args.optString("title", "")
        "task_update" -> "Task " + args.optString("id", "") + " → " + args.optString("status", "")
        "file_list" -> "Listed files"
        "file_read" -> "Read " + args.optString("path", "")
        "file_write" -> "Wrote " + args.optString("path", "")
        "generate_image" -> "Drew an image"
        "phone_action" -> "Proposed " + args.optString("kind", "action")
        else -> call.name
    }
}
