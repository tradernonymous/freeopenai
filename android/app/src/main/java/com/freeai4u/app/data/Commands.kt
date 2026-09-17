package com.freeai4u.app.data

import org.json.JSONArray
import org.json.JSONObject

// Slash commands and skills, ported from the web app's chatlib.js. The set is
// the same one the web documents, minus build: this app plans, it does not
// execute. Matching is deliberately strict -- a line that merely starts with a
// slash (a path, a date) stays a message rather than becoming a command the
// user never typed.

data class SlashCommand(val name: String, val usage: String, val desc: String)

val CHAT_COMMANDS = listOf(
    SlashCommand("help", "/help", "List these commands"),
    SlashCommand("skill", "/skill <name>  ·  /skill off <name>", "Use an installed skill for the rest of this chat"),
    SlashCommand("skills", "/skills", "Show what this chat is using"),
    SlashCommand("mode", "/mode chat | plan", "Switch mode"),
    SlashCommand("clear", "/clear", "Start a new chat — this one stays in the sidebar"),
    SlashCommand("compact", "/compact on | off | status", "Reduce sent history for this session without changing the visible chat"),
    SlashCommand("doctor", "/doctor", "Check providers, skills and mode health"),
)

/** What a line typed into the composer means. */
sealed interface SlashMatch {
    /** A known command with its raw argument tail. */
    data class Known(val name: String, val args: String) : SlashMatch
    /** A single installed skill named by shorthand: `/caveman`. */
    data class Skill(val name: String) : SlashMatch
    /** Several skills pinned at once: `/review /verify`. */
    data class Chain(val names: List<String>) : SlashMatch
}

const val MAX_SKILL_CHAIN = 3

/** History length used while /compact is on: enough for context, far less to send. */
const val COMPACT_HISTORY_MESSAGES = 10

private val COMMAND_RE = Regex("^/([a-z][a-z0-9-]*)\\s*([\\s\\S]*)$", RegexOption.IGNORE_CASE)
private val TOKEN_RE = Regex("^/([a-z][a-z0-9-]*)$", RegexOption.IGNORE_CASE)

/** What [text] means given the installed [skillNames]: a command, a skill, a
 * chain, or null for plain text that should be sent to the model as usual. */
fun resolveSlash(text: String, skillNames: List<String>): SlashMatch? {
    val match = COMMAND_RE.find(text.trim()) ?: return null
    val name = match.groupValues[1].lowercase()
    val args = match.groupValues[2].trim()
    if (CHAT_COMMANDS.any { it.name == name }) return SlashMatch.Known(name, args)
    val known = skillNames.map { it.lowercase() }
    if (name !in known) return null
    val names = mutableListOf(name)
    for (token in args.split(Regex("\\s+")).filter { it.isNotEmpty() }) {
        val tokenMatch = TOKEN_RE.find(token) ?: break
        val candidate = tokenMatch.groupValues[1].lowercase()
        if (candidate !in known || names.size >= MAX_SKILL_CHAIN) break
        names.add(candidate)
    }
    return if (names.size < 2) SlashMatch.Skill(name) else SlashMatch.Chain(names)
}

/** Name/description rows for the composer's "/" autocomplete: commands first,
 * then installed skills, capped so the list stays readable. */
fun slashSuggestions(text: String, skillNames: List<String>): List<Pair<String, String>> {
    val line = text.trimStart()
    if (!line.startsWith("/")) return emptyList()
    val typed = line.removePrefix("/").lowercase()
    if (typed.contains(' ')) return emptyList()
    val commands = CHAT_COMMANDS.filter { it.name.startsWith(typed) }.map { it.name to "${it.usage} — ${it.desc}" }
    val skills = skillNames
        .filter { it.lowercase().startsWith(typed) && CHAT_COMMANDS.none { command -> command.name == it.lowercase() } }
        .map { it to "Skill — pin it for this chat" }
    return (commands + skills).take(8)
}

fun renderCommandsHelp(): String = buildString {
    append("**Commands**\n\n")
    CHAT_COMMANDS.forEach { append("`").append(it.usage).append("` — ").append(it.desc).append('\n') }
    append("\nOr type `/` and a skill name — `/ponytail`, `/caveman` — to use it for the rest of this chat.")
}

/** One installed skill. [body] is empty in the catalogue and the SKILL.md in
 * the content route. */
data class Skill(
    val source: String,
    val name: String,
    val description: String,
    val allowedTools: List<String> = emptyList(),
    val userOnly: Boolean = false,
    val body: String = "",
)

/** GET /api/skills: the catalogue, without bodies. */
fun parseSkills(text: String): List<Skill> = try {
    val array = JSONArray(text)
    (0 until array.length()).mapNotNull { index -> array.optJSONObject(index)?.let { skillFromJson(it) } }.filter { it.name.isNotEmpty() }
} catch (e: Exception) {
    emptyList()
}

/** GET /api/skills/content?name=: one skill, body included. */
fun parseSkill(text: String): Skill? = try {
    skillFromJson(JSONObject(text)).takeIf { it.name.isNotEmpty() }
} catch (e: Exception) {
    null
}

private fun skillFromJson(obj: JSONObject): Skill = Skill(
    source = obj.optString("source", ""),
    name = obj.optString("name", ""),
    description = obj.optString("description", ""),
    allowedTools = obj.optJSONArray("allowedTools")?.let { array ->
        (0 until array.length()).map { array.optString(it, "") }.filter { it.isNotEmpty() }
    } ?: emptyList(),
    userOnly = obj.optBoolean("userOnly", false),
    body = obj.optString("body", ""),
)
