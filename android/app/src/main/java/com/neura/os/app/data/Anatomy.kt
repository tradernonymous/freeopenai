package com.neura.os.app.data

// The anatomy of an AI message (docs/android-master-plan.md V5, rebrand plan
// §4.1): the pure parts -- how long it thought, which sources it cited, and
// how full the model's context is -- so each is tested; ui/Messages.kt draws.

/** "Thinking…" while it thinks; "Thought for 12 s" once it answered; plain
 * "Thought" when no time was recorded (a reply saved before this existed). */
fun thoughtLabel(thoughtMs: Long, live: Boolean): String = when {
    live -> "Thinking…"
    thoughtMs <= 0L -> "Thought"
    thoughtMs < 1_000L -> "Thought for a moment"
    thoughtMs < 60_000L -> "Thought for ${thoughtMs / 1_000} s"
    else -> "Thought for ${thoughtMs / 60_000} min ${(thoughtMs % 60_000) / 1_000} s"
}

/** A web page a reply cited. [label] is the site, for a chip. */
data class Source(val url: String, val label: String)

/** At most this many chips under one reply. */
const val SOURCES_MAX = 6

private val MARKDOWN_LINK = Regex("\\[[^\\]\\n]{1,200}]\\((https://[^)\\s]{1,2000})\\)")
private val BARE_URL = Regex("(?<![(\\w/])https://[^\\s)\\]>\"'`]{1,2000}")

private fun hostOf(url: String): String? {
    val rest = url.removePrefix("https://")
    val host = rest.substringBefore('/').substringBefore('?').substringBefore('#').substringBefore(':').lowercase()
    if (host.isEmpty() || !host.contains('.') || host.contains('@')) return null
    return host.removePrefix("www.")
}

/** The https links in [text], in the order they appear, one per page (a
 * trailing period or comma is not part of it), capped at [SOURCES_MAX].
 * Only https: an http link is not offered as a chip to tap. */
fun sourcesFrom(text: String): List<Source> {
    val found = LinkedHashMap<String, Source>()
    val matches = (MARKDOWN_LINK.findAll(text).map { it.range.first to it.groupValues[1] } +
        BARE_URL.findAll(text).map { it.range.first to it.value })
        .sortedBy { it.first }
    for ((_, raw) in matches) {
        val url = raw.trimEnd('.', ',', ';', ':', '!', '?')
        val host = hostOf(url) ?: continue
        val key = url.substringBefore('#').trimEnd('/')
        if (key !in found) found[key] = Source(url, host)
        if (found.size >= SOURCES_MAX) break
    }
    return found.values.toList()
}

/** A rough token count for what a chat sends: about four characters a
 * token for text, plus a little per message. Good enough for a meter, and
 * labelled as an estimate wherever it is shown. */
fun estimateTokens(messages: List<ChatMessage>): Int =
    messages.sumOf { (it.content.length + it.reasoning.length) / 4 + 4 }

/** "≈ 3.2k of 128k tokens" -- or without the window when the model's is not
 * known. The fraction is for a meter: 0..1, or null without a window. */
fun contextLabel(tokens: Int, window: Int): Pair<String, Float?> {
    fun short(n: Int): String = when {
        n >= 1_000_000 -> "%.1fM".format(n / 1_000_000.0).replace(".0M", "M")
        n >= 1_000 -> "%.1fk".format(n / 1_000.0).replace(".0k", "k")
        else -> n.toString()
    }
    return if (window > 0) {
        "≈ ${short(tokens)} of ${short(window)} tokens" to (tokens.toFloat() / window).coerceIn(0f, 1f)
    } else {
        "≈ ${short(tokens)} tokens" to null
    }
}

/** Past this, a reply reads better in the canvas than in a bubble (V8). */
const val CANVAS_MIN_CHARS = 1_200
const val CANVAS_MIN_CODE_LINES = 25

/** Long prose, or a code block long enough to scroll, earns "Open in
 * canvas"; a short answer does not. */
fun canvasWorthy(text: String): Boolean {
    if (text.length >= CANVAS_MIN_CHARS) return true
    return Regex("```[^\\n]*\\n([\\s\\S]*?)```").findAll(text).any { block ->
        block.groupValues[1].count { it == '\n' } + 1 >= CANVAS_MIN_CODE_LINES
    }
}

/** Versions of one answer the canvas can step through: the current one and
 * up to four it replaced (Regenerate). */
const val MAX_REPLY_VERSIONS = 5

private fun ChatMessage.finishedAnswer(): Boolean = role == "assistant" && !error && content.isNotBlank()

/** What the canvas steps through: this chat's finished answers, oldest
 * first -- no failures, no blank tool-call turns. Each entry is that
 * answer's versions, oldest first and the current one last; an answer has
 * earlier versions when it is the last one to its question and that question
 * was asked again (they ride on the question, see [keepEarlierReply]). */
fun canvasEntries(messages: List<ChatMessage>): List<List<String>> {
    // One pass from the end marks the last finished answer of each question.
    val lastOfTurn = BooleanArray(messages.size)
    var seen = false
    for (index in messages.indices.reversed()) {
        val message = messages[index]
        if (message.role == "user") seen = false
        else if (message.finishedAnswer() && !seen) { lastOfTurn[index] = true; seen = true }
    }
    val entries = mutableListOf<List<String>>()
    var question: ChatMessage? = null
    messages.forEachIndexed { index, message ->
        if (message.role == "user") question = message
        if (!message.finishedAnswer()) return@forEachIndexed
        val earlier = if (lastOfTurn[index]) question?.earlierReplies.orEmpty() else emptyList()
        entries += earlier + message.content
    }
    return entries
}

/** Regenerate: the chat up to and including the question at [lastUser],
 * with the answer being replaced added to that question's earlier versions
 * (newest kept, at most [MAX_REPLY_VERSIONS] - 1). A failed or empty answer
 * is not worth keeping. Earlier versions are never sent to a model. */
fun keepEarlierReply(messages: List<ChatMessage>, lastUser: Int): List<ChatMessage> {
    val question = messages.getOrNull(lastUser) ?: return messages
    val replaced = messages.drop(lastUser + 1).lastOrNull { it.finishedAnswer() }?.content
    val kept = messages.subList(0, lastUser + 1)
    if (replaced == null) return kept
    val earlier = (question.earlierReplies + replaced).takeLast(MAX_REPLY_VERSIONS - 1)
    return kept.dropLast(1) + question.copy(earlierReplies = earlier)
}
