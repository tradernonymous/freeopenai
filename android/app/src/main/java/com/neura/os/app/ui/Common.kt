package com.neura.os.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.neura.os.app.data.DEFAULT_PERSONA_ID
import com.neura.os.app.data.splitCodeBlocks

/** Empty is a dead end unless there is a way out of it: [actionLabel] and
 * [onAction] are optional because a screen whose action is already on
 * screen (Images, with its own draw controls above the empty gallery) has
 * nothing useful to add. */
@Composable
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
    Box(modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = Palette.text)
            Spacer(Modifier.height(8.dp))
            Text(body, style = MaterialTheme.typography.bodyMedium, color = Palette.muted)
            if (actionLabel != null && onAction != null) {
                Spacer(Modifier.height(16.dp))
                Button(onAction) { Text(actionLabel) }
            }
        }
    }
}

/** One list-row shell for Personas, Prompts and Skills: a card, an optional
 * leading glyph, a title/subtitle column, and trailing actions. Slots are
 * composables rather than plain strings so each screen's existing text
 * styling (colors, line limits, a conditional "· built-in" suffix) carries
 * over exactly instead of being approximated by one generic look. The extra
 * horizontal gap around [content] only appeared where a screen already had a
 * [leading] glyph to gap it from -- preserved here, not invented. */
@Composable
fun LibraryRow(leading: (@Composable () -> Unit)? = null, actions: @Composable RowScope.() -> Unit, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Palette.surface), modifier = modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            leading?.invoke()
            Column(if (leading != null) Modifier.weight(1f).padding(horizontal = 12.dp) else Modifier.weight(1f), content = content)
            actions()
        }
    }
}

/** A ready-made prompt: a quick tool, a plan template, or a Home suggestion.
 * One shape for all three (they only ever differed in which fields each
 * screen happened to read) -- [icon] XOR [emoji] is the leading visual,
 * whichever the screen uses; [image] arms image mode instead of sending text. */
data class Prefill(
    val label: String,
    val prompt: String,
    val icon: ImageVector? = null,
    val emoji: String = "",
    val personaId: String = DEFAULT_PERSONA_ID,
    val mode: String = "chat",
    val image: Boolean = false,
)

/** Compiled once at file scope, not per call.
 *
 * These three used to be built inside the function, and inlineMarkdown runs
 * on every visible streamed line, up to ~17 times a second. Kotlin does not
 * cache Regex(String), so that was 120 Pattern compiles a second on the main
 * thread for one turn. */
private val HEADING = Regex("^#{1,6}\\s+")
private val BULLET = Regex("^\\s*[-*+]\\s+")
private val INLINE_TOKEN = Regex("(\\*\\*[^*]+\\*\\*|`[^`]+`|\\*[^*\\s][^*]*\\*)")

/** Light Markdown: **bold**, *italic*, `code`, # headings and bullet lines.
 * Fenced blocks are handled by [MarkdownText]. Everything is rendered as
 * text: nothing in a reply can become a link, a script or an image load. */
fun inlineMarkdown(text: String): AnnotatedString = buildAnnotatedString {
    val lines = text.split("\n")
    lines.forEachIndexed { lineIndex, rawLine ->
        var line = rawLine
        val heading = HEADING.find(line)
        if (heading != null) {
            line = line.substring(heading.value.length)
            withStyle(SpanStyle(fontWeight = FontWeight.Bold, fontSize = 17.sp)) { appendInline(line) }
        } else {
            val bullet = BULLET.find(line)
            if (bullet != null) {
                append("  •  ")
                line = line.substring(bullet.value.length)
            }
            appendInline(line)
        }
        if (lineIndex < lines.lastIndex) append("\n")
    }
}

private fun AnnotatedString.Builder.appendInline(line: String) {
    var cursor = 0
    for (match in INLINE_TOKEN.findAll(line)) {
        append(line.substring(cursor, match.range.first))
        val token = match.value
        when {
            token.startsWith("**") -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(token.removeSurrounding("**")) }
            token.startsWith("`") -> withStyle(SpanStyle(fontFamily = NeuraMono, background = Palette.surfaceHigh, color = Palette.accent)) {
                append(token.removeSurrounding("`"))
            }
            else -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(token.removeSurrounding("*")) }
        }
        cursor = match.range.last + 1
    }
    append(line.substring(cursor))
}

fun relativeTime(then: Long, now: Long = System.currentTimeMillis()): String {
    val minutes = (now - then) / 60000
    return when {
        minutes < 1 -> "now"
        minutes < 60 -> "${minutes}m"
        minutes < 60 * 24 -> "${minutes / 60}h"
        minutes < 60 * 24 * 7 -> "${minutes / (60 * 24)}d"
        else -> java.text.SimpleDateFormat("d MMM", java.util.Locale.getDefault()).format(java.util.Date(then))
    }
}
