package com.neura.os.app.ui
import androidx.compose.foundation.layout.fillMaxHeight

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Before/After comparison overlay for image editing.
 *
 * Shows the original and edited images side by side with a draggable
 * divider. The user can slide to reveal more of either version.
 */
@Composable
fun BeforeAfterComparison(
    original: ImageBitmap?,
    edited: ImageBitmap?,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (original == null || edited == null) return

    var sliderPosition by remember { mutableFloatStateOf(0.5f) }
    val density = LocalDensity.current

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Palette.background)
            .pointerInput(Unit) {
                detectDragGestures { change, _ ->
                    change.consume()
                    sliderPosition = (change.position.x / size.width).coerceIn(0f, 1f)
                }
            },
    ) {
        // Edited image (full background)
        Image(
            bitmap = edited,
            contentDescription = "Edited",
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop,
        )

        // Original image (clipped by slider position)
        Box(
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer {
                    clip = true
                    shape = RoundedCornerShape(0.dp)
                    translationX = 0f
                }
        ) {
            Image(
                bitmap = original,
                contentDescription = "Original",
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = 1f
                    },
                contentScale = ContentScale.Crop,
            )
        }

        // Slider divider line — positioned using fraction of available width
        Box(
            modifier = Modifier
                .fillMaxSize(),
        ) {
            // Divider line at slider position
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .width(2.dp)
                    .background(Palette.green)
                    .align(Alignment.CenterStart)
                    .graphicsLayer { translationX = sliderPosition * size.width - 1 },
            )
            // Handle
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(Palette.green)
                    .align(Alignment.Center),
                contentAlignment = Alignment.Center,
            ) {
                Text("⟷", color = Palette.background, fontSize = 14.sp)
            }
        }

        // Labels
        Text(
            text = "Original",
            color = Palette.text,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier
                .padding(12.dp)
                .align(Alignment.TopStart),
        )
        Text(
            text = "Edited",
            color = Palette.text,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier
                .padding(12.dp)
                .align(Alignment.TopEnd),
        )

        // Close button
        IconButton(
            onClick = onDismiss,
            modifier = Modifier
                .padding(8.dp)
                .align(Alignment.TopEnd),
        ) {
            Icon(Icons.Default.Close, "Close", tint = Palette.text)
        }
    }
}

/**
 * Prompt history panel showing previous image generation prompts
 * with timestamps and the ability to re-use or delete entries.
 */
data class PromptHistoryEntry(
    val prompt: String,
    val timestamp: Long,
    val model: String,
    val wasSuccessful: Boolean,
)

@Composable
fun PromptHistoryPanel(
    history: List<PromptHistoryEntry>,
    onReuse: (String) -> Unit,
    onDelete: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (history.isEmpty()) return

    Column(modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(bottom = 8.dp),
        ) {
            Icon(
                Icons.Default.AccessTime,
                contentDescription = null,
                tint = Palette.muted,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                text = "Recent Prompts",
                color = Palette.muted,
                style = MaterialTheme.typography.labelMedium,
            )
        }

        LazyColumn(
            modifier = Modifier.heightIn(max = 200.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            items(history.take(10).withIndex().toList(), key = { it.value.timestamp }) { (index, entry) ->
                PromptHistoryCard(
                    entry = entry,
                    onReuse = { onReuse(entry.prompt) },
                    onDelete = { onDelete(index) },
                )
            }
        }
    }
}

@Composable
private fun PromptHistoryCard(
    entry: PromptHistoryEntry,
    onReuse: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Palette.surface)
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = entry.prompt,
                color = Palette.text,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row {
                Text(
                    text = entry.model.substringAfterLast('/'),
                    color = Palette.muted,
                    style = MaterialTheme.typography.labelSmall,
                    fontSize = 10.sp,
                )
                Text(
                    text = if (entry.wasSuccessful) " ✓" else " ✗",
                    color = if (entry.wasSuccessful) Palette.green else Palette.red,
                    fontSize = 10.sp,
                )
            }
        }
        IconButton(onClick = onReuse, modifier = Modifier.size(28.dp)) {
            Icon(Icons.Default.Refresh, "Re-use", tint = Palette.green, modifier = Modifier.size(14.dp))
        }
        IconButton(onClick = onDelete, modifier = Modifier.size(28.dp)) {
            Icon(Icons.Default.Delete, "Delete", tint = Palette.red, modifier = Modifier.size(14.dp))
        }
    }
}

/**
 * Batch generation progress indicator.
 * Shows progress when generating multiple images at once.
 */
@Composable
fun BatchProgressIndicator(
    current: Int,
    total: Int,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (total <= 1) return

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text = "Generating $current of $total",
                color = Palette.text,
                style = MaterialTheme.typography.bodySmall,
            )
            TextButton(onClick = onCancel, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                Text("Cancel", color = Palette.red, fontSize = 12.sp)
            }
        }
        LinearProgressIndicator(
            progress = { current.toFloat() / total.coerceAtLeast(1) },
            modifier = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)),
            color = Palette.green,
            trackColor = Palette.surfaceHigh,
        )
    }
}
