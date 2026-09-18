package com.neura.os.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Prompt history panel — shows previous image generation prompts
 * with the ability to re-use or delete entries.
 */
data class PromptHistoryEntry(val prompt: String, val timestamp: Long, val model: String, val wasSuccessful: Boolean)

@Composable
fun PromptHistoryPanel(
    history: List<PromptHistoryEntry>,
    onReuse: (String) -> Unit,
    onDelete: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (history.isEmpty()) return

    Column(modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
            Icon(Icons.Default.AccessTime, null, tint = Palette.muted, modifier = Modifier.size(16.dp))
            androidx.compose.foundation.layout.Spacer(Modifier.width(6.dp))
            Text("Recent Prompts", color = Palette.muted, style = MaterialTheme.typography.labelMedium)
        }
        LazyColumn(modifier = Modifier.heightIn(max = 200.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(history.take(10).withIndex().toList(), key = { it.value.timestamp }) { (idx, entry) ->
                Row(
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Palette.surface).padding(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(entry.prompt, color = Palette.text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(entry.model.substringAfterLast('/'), color = Palette.muted, fontSize = 10.sp)
                    }
                    IconButton(onClick = { onReuse(entry.prompt) }, modifier = Modifier.size(28.dp)) {
                        Icon(Icons.Default.Refresh, "Re-use", tint = Palette.green, modifier = Modifier.size(14.dp))
                    }
                    IconButton(onClick = { onDelete(idx) }, modifier = Modifier.size(28.dp)) {
                        Icon(Icons.Default.Delete, "Delete", tint = Palette.red, modifier = Modifier.size(14.dp))
                    }
                }
            }
        }
    }
}
