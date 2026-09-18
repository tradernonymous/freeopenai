package com.neura.os.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.SaveAlt
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.neura.os.app.data.FileGenerator

/**
 * Shows a row of download/share buttons for files the agent produced.
 *
 * Appears below a chat message that contains detectable file content:
 *   - Code blocks → code icon + language name
 *   - Markdown documents → description icon + "Markdown document"
 *   - JSON/XML → code icon + format name
 *   - Tables → table chart icon + "Table (N rows)"
 *
 * Each button triggers the corresponding save or share action.
 */
@Composable
fun DownloadBar(
    files: List<FileGenerator.GeneratedFile>,
    onSave: (FileGenerator.GeneratedFile) -> Unit,
    onShare: (FileGenerator.GeneratedFile) -> Unit,
    modifier: Modifier = Modifier,
    visible: Boolean = true,
) {
    if (files.isEmpty()) return

    AnimatedVisibility(
        visible = visible,
        enter = expandVertically(expandFrom = Alignment.Top),
        exit = shrinkVertically(shrinkTowards = Alignment.Top),
    ) {
        Column(
            modifier = modifier
                .fillMaxWidth()
                .padding(top = 4.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            for (file in files) {
                FileChip(
                    file = file,
                    onSave = { onSave(file) },
                    onShare = { onShare(file) },
                )
            }
        }
    }
}

@Composable
private fun FileChip(
    file: FileGenerator.GeneratedFile,
    onSave: () -> Unit,
    onShare: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Palette.surfaceHigh)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            imageVector = iconForFile(file),
            contentDescription = null,
            tint = Palette.green,
            modifier = Modifier.size(18.dp),
        )

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = file.displayName,
                style = MaterialTheme.typography.bodySmall,
                color = Palette.text,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = formatSize(file.content.size),
                style = MaterialTheme.typography.labelSmall,
                color = Palette.muted,
                fontSize = 10.sp,
            )
        }

        IconButton(onClick = onSave, modifier = Modifier.size(28.dp)) {
            Icon(
                imageVector = Icons.Default.SaveAlt,
                contentDescription = "Save to Downloads",
                tint = Palette.text,
                modifier = Modifier.size(16.dp),
            )
        }

        IconButton(onClick = onShare, modifier = Modifier.size(28.dp)) {
            Icon(
                imageVector = Icons.Default.Share,
                contentDescription = "Share",
                tint = Palette.text,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

private fun iconForFile(file: FileGenerator.GeneratedFile): ImageVector = when {
    file.mimeType.startsWith("image/") -> Icons.Default.Image
    file.mimeType == "text/csv" || file.mimeType.contains("table") -> Icons.Default.TableChart
    file.extension == "md" || file.mimeType == "text/markdown" -> Icons.Default.Description
    else -> Icons.Default.Code
}

private fun formatSize(bytes: Int): String = when {
    bytes < 1024 -> "${bytes}B"
    bytes < 1024 * 1024 -> "${bytes / 1024}KB"
    else -> "${"%.1f".format(bytes / (1024.0 * 1024))}MB"
}
