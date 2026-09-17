package com.freeai4u.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.freeai4u.app.data.splitCodeBlocks

@Composable
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = Palette.text)
            Spacer(Modifier.height(8.dp))
            Text(body, style = MaterialTheme.typography.bodyMedium, color = Palette.muted)
        }
    }
}

/** Light Markdown: **bold**, *italic*, `code`, # headings and bullet lines.
 * Fenced blocks are handled by [MarkdownText]. Everything is rendered as
 * text: nothing in a reply can become a link, a script or an image load. */
fun inlineMarkdown(text: String): AnnotatedString = buildAnnotatedString {
    val lines = text.split("\n")
    lines.forEachIndexed { lineIndex, rawLine ->
        var line = rawLine
        val heading = Regex("^#{1,6}\\s+").find(line)
        if (heading != null) {
            line = line.substring(heading.value.length)
            withStyle(SpanStyle(fontWeight = FontWeight.Bold, fontSize = 17.sp)) { appendInline(line) }
        } else {
            val bullet = Regex("^\\s*[-*+]\\s+").find(line)
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
    val pattern = Regex("(\\*\\*[^*]+\\*\\*|`[^`]+`|\\*[^*\\s][^*]*\\*)")
    var cursor = 0
    for (match in pattern.findAll(line)) {
        append(line.substring(cursor, match.range.first))
        val token = match.value
        when {
            token.startsWith("**") -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(token.removeSurrounding("**")) }
            token.startsWith("`") -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Palette.surfaceHigh, color = Palette.green)) {
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
